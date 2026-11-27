/**
 * ZMX Exec Extension
 *
 * Executes shell commands inside persistent zmx sessions.
 * Filesystem side effects, background processes, and exported
 * env vars persist across calls within the same session.
 *
 * Tools:
 *   zmx_run             - Run a shell command in a zmx session (synchronous)
 *   zmx_run_background  - Start a long task and get a message when it exits
 *   zmx_watch           - Watch an already-running session until its task exits
 *   zmx_unwatch         - Stop watching a session
 *   zmx_list            - List active zmx sessions
 *   zmx_kill            - Kill one or more zmx sessions
 *   zmx_history         - View recent output from a session
 *   zmx_wait            - Wait for session tasks to complete (blocking)
 *   zmx_attach          - Show instructions for manually attaching to a session
 *
 * Commands:
 *   /zmx       - Open interactive zmx session manager
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ─── Extension ──────────────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
	// Verify zmx is available on PATH
	try {
		await pi.exec("zmx", ["version"]);
	} catch {
		const msg =
			"zmx not found on PATH. Install from https://zmx.sh :\n" +
			"  brew install neurosnap/tap/zmx\n" +
			"Or download a binary directly from https://zmx.sh/#binaries\n" +
			"Then restart pi.";
		// Register a stub tool that surfaces the error instead of silently failing
		for (const name of [
			"zmx_run",
			"zmx_run_background",
			"zmx_watch",
			"zmx_unwatch",
			"zmx_list",
			"zmx_kill",
			"zmx_history",
			"zmx_wait",
			"zmx_attach",
		]) {
			pi.registerTool({
				name,
				label: name,
				description: "zmx is not installed — see error for install instructions.",
				parameters: { type: "object" as const, properties: {}, required: [] },
				async execute() {
					return { content: [{ type: "text" as const, text: msg }], isError: true };
				},
			});
		}
		return;
	}

	// Async zmx helpers — use pi.exec which is non-blocking

	async function zmxExec(
		args: string[],
		options?: { timeout?: number },
	): Promise<{ stdout: string; stderr: string; code: number }> {
		try {
			const result = await pi.exec("zmx", args, {
				timeout: (options?.timeout ?? 30) * 1000,
			});
			return {
				stdout: (result.stdout ?? "").trim(),
				stderr: (result.stderr ?? "").trim(),
				code: result.code ?? -1,
			};
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			return { stdout: "", stderr: message, code: -1 };
		}
	}

	async function listSessions(): Promise<string[]> {
		const result = await zmxExec(["list", "--short"]);
		if (result.code !== 0) return [];
		return result.stdout.split("\n").filter(Boolean);
	}

	async function ensureSession(session: string): Promise<{ ok: boolean; error?: string }> {
		const sessions = await listSessions();
		if (sessions.includes(session)) return { ok: true };

		const result = await zmxExec(["run", session, "true"], { timeout: 10 });
		if (result.code !== 0) {
			return { ok: false, error: result.stderr || result.stdout || `failed to create session "${session}"` };
		}
		return { ok: true };
	}

	// ── Session metadata ────────────────────────────────────────────────────

	interface ZmxSessionInfo {
		name: string;
		created?: number;
		ended?: number;
		exitCode?: number;
		cmd?: string;
		cwd?: string;
	}

	function parseSessionInfo(line: string): ZmxSessionInfo | undefined {
		const trimmed = line.trim();
		if (!trimmed.startsWith("name=")) return undefined;
		const info: ZmxSessionInfo = { name: "" };
		for (const field of trimmed.split("\t")) {
			const eq = field.indexOf("=");
			if (eq <= 0) continue;
			const value = field.slice(eq + 1);
			switch (field.slice(0, eq)) {
				case "name":
					info.name ||= value;
					break;
				case "created":
					info.created ??= Number(value);
					break;
				case "ended":
					info.ended ??= Number(value);
					break;
				case "exit_code":
					info.exitCode ??= Number(value);
					break;
				case "cmd":
					info.cmd ??= value;
					break;
				case "cwd":
					info.cwd ??= value;
					break;
			}
		}
		return info.name ? info : undefined;
	}

	async function getSessionInfo(session: string): Promise<ZmxSessionInfo | undefined> {
		const result = await zmxExec(["list"]);
		if (result.code !== 0) return undefined;
		for (const line of result.stdout.split("\n")) {
			const info = parseSessionInfo(line);
			if (info?.name === session) return info;
		}
		return undefined;
	}

	function resolveSessionName(explicit?: string): string | undefined {
		if (explicit) return explicit;
		return (
			pi
				.getSessionName()
				?.toLowerCase()
				.replace(/\s+/g, "-")
				.replace(/[^\w-]/g, "") || undefined
		);
	}

	// ── Completion watchers ─────────────────────────────────────────────────
	//
	// `zmx wait <session>` blocks until the session's tracked task exits and
	// returns its exit code. Running it in the background lets a long task
	// outlive the tool call: when the wait returns, the extension injects a
	// message into this session so the agent can continue its work instead of
	// polling zmx_wait (and hitting tool timeouts) in a loop.

	interface Watch {
		session: string;
		command?: string;
		label?: string;
		startedAt: number;
		tailLines: number;
		abort: AbortController;
	}

	const watches = new Map<string, Watch>();

	function log(level: "warn" | "error", message: string): void {
		try {
			pi.logger?.[level]?.(message);
		} catch {
			// Logging must never break a watcher.
		}
	}

	function deliverNotice(text: string): void {
		try {
			// A custom message wakes an idle session (triggerTurn) and steers a
			// streaming one. Both pi and omp accept this payload; the native
			// async-job delivery uses the same shape.
			pi.sendMessage(
				{ customType: "zmx.task-complete", content: text, display: true },
				{ triggerTurn: true },
			);
		} catch (err) {
			log(
				"warn",
				`zmx: could not deliver completion notice: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	function formatDuration(ms: number): string {
		const seconds = Math.max(0, Math.round(ms / 1000));
		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		const restSeconds = seconds % 60;
		if (minutes < 60) return restSeconds ? `${minutes}m ${restSeconds}s` : `${minutes}m`;
		const hours = Math.floor(minutes / 60);
		const restMinutes = minutes % 60;
		return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
	}

	async function readTail(session: string, lines: number): Promise<string | undefined> {
		if (lines <= 0) return undefined;
		const result = await zmxExec(["history", session], { timeout: 15 });
		if (result.code !== 0 || !result.stdout) return undefined;
		let tail = result.stdout.split("\n").slice(-lines).join("\n").trimEnd();
		if (!tail) return undefined;
		if (tail.length > 4000) tail = `…\n${tail.slice(-4000)}`;
		return tail;
	}

	function stopWatch(session: string): boolean {
		const watch = watches.get(session);
		if (!watch) return false;
		watches.delete(session);
		if (watches.size === 0) resumeTodoReminders();
		watch.abort.abort();
		return true;
	}

	// ── Todo-reminder suppression ───────────────────────────────────────────
	//
	// OMP's todo tracker appends a "you stopped with incomplete todos" reminder
	// and starts another turn whenever the agent ends a turn with open todos.
	// That defeats a deliberate stop while a zmx task runs, so pause the
	// session's `todo.reminders` setting while at least one watch is active and
	// release the override when the last one finishes. Hosts without the
	// setting (upstream pi) skip this.

	interface TodoReminderSetting {
		get(scope: unknown): boolean;
		override(scope: unknown, value: boolean): void;
		clearOverride(scope: unknown): void;
	}

	let todoReminderSetting: TodoReminderSetting | null | undefined;
	let todoRemindersPaused = false;

	function settingsScope(): unknown {
		return (pi.pi as { settings?: unknown } | undefined)?.settings;
	}

	async function pauseTodoReminders(): Promise<void> {
		if (todoRemindersPaused) return;
		if (todoReminderSetting === undefined) {
			try {
				// Dynamic on purpose: this subpath exists only on OMP. A static import
				// would break the extension on upstream pi, where suppression is a no-op.
				const registry = await import("@oh-my-pi/pi-coding-agent/config/registry");
				todoReminderSetting =
					(registry.lookup("todo.reminders") as TodoReminderSetting | undefined) ?? null;
			} catch {
				todoReminderSetting = null;
			}
		}
		const setting = todoReminderSetting;
		const scope = settingsScope();
		if (!setting || scope === undefined) return;
		try {
			// Already off: leave the user's setting alone, and don't re-enable it later.
			if (!setting.get(scope)) return;
			setting.override(scope, false);
			todoRemindersPaused = true;
		} catch (err) {
			log(
				"warn",
				`zmx: could not pause todo reminders: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	function resumeTodoReminders(): void {
		if (!todoRemindersPaused) return;
		todoRemindersPaused = false;
		const scope = settingsScope();
		if (!todoReminderSetting || scope === undefined) return;
		try {
			todoReminderSetting.clearOverride(scope);
		} catch (err) {
			log(
				"warn",
				`zmx: could not resume todo reminders: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	async function notifyCompletion(
		watch: Watch,
		result: { stdout: string; stderr: string; code: number; killed: boolean },
	): Promise<void> {
		const info = await getSessionInfo(watch.session);
		const disappeared = /disappeared before completing/.test(result.stderr);
		const missing = result.code === 2 || /no matching sessions found/.test(result.stderr);
		const parsed = /exit_code=(\d+)/.exec(result.stdout);
		const exitCode = parsed ? Number(parsed[1]) : result.code;
		const failed = !disappeared && !missing && exitCode !== 0;
		const unknown = !disappeared && !missing && (result.killed || result.code === -1);

		const lines: string[] = ["[zmx] Watched task exited; resume your previous work.", ""];
		if (missing) {
			lines.push(
				`Session: ${watch.session}`,
				"Status: unknown (the session disappeared before it could be watched; no exit code is available)",
			);
		} else if (disappeared) {
			lines.push(
				`Session: ${watch.session}`,
				"Status: session ended (the session process exited; zmx does not track an exit code for this kind of session)",
			);
		} else if (unknown) {
			const detail = result.stderr.split("\n")[0];
			lines.push(
				`Session: ${watch.session}`,
				`Status: watcher stopped unexpectedly${detail ? `: ${detail}` : ""}`,
			);
		} else {
			lines.push(
				`Session: ${watch.session}`,
				`Status: ${failed ? "FAILED" : "success"} (exit code ${exitCode})`,
			);
		}

		if (watch.label) lines.push(`Label: ${watch.label}`);
		const command = watch.command ?? info?.cmd;
		if (command) lines.push(`Command: ${command}`);
		if (!missing && !disappeared && !unknown) {
			lines.push(`Duration: ${formatDuration(Date.now() - watch.startedAt)}`);
		}
		const cwd = info?.cwd?.replace(/^file:\/\/[^/]*/, "");
		if (cwd) lines.push(`Working directory: ${cwd}`);

		if (!missing) {
			const tail = await readTail(watch.session, watch.tailLines);
			if (tail) lines.push("", `Output tail (last ${watch.tailLines} lines):`, tail);
		}

		const remaining = [...watches.values()].filter(w => w !== watch);
		lines.push(
			"",
			remaining.length === 0
				? "Remaining watches: 0."
				: `Remaining watches: ${remaining.length} (${remaining
						.map(w => (w.label ? `${w.session} [${w.label}]` : w.session))
						.join(", ")}).`,
		);

		lines.push(
			"",
			`Continue your previous work now. Full scrollback: zmx_history(session="${watch.session}").`,
		);

		deliverNotice(lines.join("\n"));
	}

	async function startWatch(input: { session: string; command?: string; label?: string; tailLines?: number }): Promise<void> {
		const watch: Watch = {
			session: input.session,
			command: input.command,
			label: input.label,
			startedAt: Date.now(),
			tailLines: input.tailLines ?? 20,
			abort: new AbortController(),
		};
		watches.set(watch.session, watch);
		// Applied before the tool returns, so the stop-time todo check sees it.
		await pauseTodoReminders();

		void (async () => {
			let result: { stdout: string; stderr: string; code: number; killed: boolean };
			try {
				const execResult = await pi.exec("zmx", ["wait", watch.session], { signal: watch.abort.signal });
				result = {
					stdout: execResult.stdout ?? "",
					stderr: execResult.stderr ?? "",
					code: execResult.code ?? -1,
					killed: Boolean(execResult.killed),
				};
			} catch (err) {
				result = {
					stdout: "",
					stderr: err instanceof Error ? err.message : String(err),
					code: -1,
					killed: true,
				};
			}
			if (watches.get(watch.session) === watch) watches.delete(watch.session);
			if (watches.size === 0) resumeTodoReminders();
			if (watch.abort.signal.aborted) return;
			await notifyCompletion(watch, result);
		})().catch(err => {
			log(
				"warn",
				`watcher for "${watch.session}" failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		});
	}

	pi.on("session_shutdown", () => {
		for (const watch of watches.values()) watch.abort.abort();
		watches.clear();
		resumeTodoReminders();
	});

	// ── z m x _ r u n ───────────────────────────────────────────────────────

	pi.registerTool({
		name: "zmx_run",
		label: "ZMX Run",
		description:
			"Execute a shell command inside a persistent zmx session (synchronous). " +
			"The command runs directly (no shell wrapper). " +
			"Results are returned directly — no need for zmx_wait or zmx_history to check output.",
		promptSnippet: "Execute shell commands inside persistent zmx sessions",
		promptGuidelines: [
			"Use zmx_run for shell commands that need persistent terminal state (exported vars, background processes).",
			"Commands run synchronously — output is returned directly, no need for zmx_wait.",
			"No shell wrapper: pass each argument as a separate array element.",
			"Shell operators (&&, ||, ;, |, $VAR) are NOT supported — zmx escapes all arguments as literals. Use sh -c or bash -c when you need shell chaining, e.g. [\"sh\", \"-c\", \"echo hello && echo world\"].",
			"If no session name is provided, zmx_run uses the pi session display name. If that is also unset, the session param is required.",
			"Use zmx_attach for interactive tasks requiring human input (passwords, sudo, vim, etc.).",
		],
		parameters: Type.Object({
			command: Type.Array(Type.String(), { description: "Command to execute (argv array, no shell wrapper). Pass each argument as a separate array element." }),
			session: Type.Optional(
				Type.String({
					description: "ZMX session name. Defaults to the pi session display name if set. Required if pi has no session name.",
				}),
			),
			timeout: Type.Optional(
				Type.Integer({
					description: "Maximum time in seconds to wait for the command (default: 30, max: 600)",
					minimum: 1,
					maximum: 600,
				}),
			),
			dryRun: Type.Optional(
				Type.Boolean({
					description: "If true, show what would be executed without running",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const command = params.command;
			const commandStr = command.join(" ");

			// Derive zmx session name:
			// 1. User-provided param
			// 2. pi session display name (set via pi.setSessionName())
			// 3. Neither — require the user to provide one
			const session = resolveSessionName(params.session);

			if (!session) {
				return {
					content: [{
						type: "text" as const,
						text: "No session name available. Either provide a `session` parameter or set a pi session name first (e.g. name this session something descriptive).",
					}],
					isError: true,
				};
			}

			if (params.dryRun) {
				return {
					content: [
						{ type: "text" as const, text: `[dry-run] zmx run ${session}: ${commandStr}` },
					],
					details: { session, command, dryRun: true },
				};
			}

			// 1) Ensure session exists
			const ensured = await ensureSession(session);
			if (!ensured.ok) {
				return {
					content: [
						{ type: "text" as const, text: `Failed to create/access session "${session}": ${ensured.error}` },
					],
					details: { session, command: commandStr, error: ensured.error },
					isError: true,
				};
			}

			// 2) Run command synchronously (blocking)
			const runResult = await zmxExec(["run", session, ...command], { timeout: params.timeout ?? 30 });

			if (runResult.code !== 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: runResult.stderr || runResult.stdout || `Command failed with exit code ${runResult.code}`,
						},
					],
					details: { session, command: commandStr, exitCode: runResult.code, stderr: runResult.stderr },
					isError: true,
				};
			}

			return {
				content: [
					{
						type: "text" as const,
						text: runResult.stdout || "Command completed successfully (no output).",
					},
				],
				details: { session, command: commandStr, exitCode: 0, stdout: runResult.stdout },
			};
		},
	});

	// ── z m x _ l i s t ─────────────────────────────────────────────────────

	pi.registerTool({
		name: "zmx_list",
		label: "ZMX List",
		description: "List active zmx sessions.",
		parameters: Type.Object({}),
		async execute() {
			const result = await zmxExec(["list"]);
			if (result.code !== 0) {
				return {
					content: [{ type: "text" as const, text: `zmx list failed: ${result.stderr || result.stdout}` }],
					isError: true,
				};
			}
			const sessions = result.stdout || "(no active sessions)";
			return {
				content: [{ type: "text" as const, text: sessions }],
				details: { sessions: await listSessions() },
			};
		},
	});

	// ── z m x _ k i l l ─────────────────────────────────────────────────────

	pi.registerTool({
		name: "zmx_kill",
		label: "ZMX Kill",
		description: "Kill one or more zmx sessions.",
		parameters: Type.Object({
			sessions: Type.Array(Type.String(), {
				description: "Session name(s) to kill",
			}),
			force: Type.Optional(
				Type.Boolean({
					description: "Force kill even if clients are attached",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const args = ["kill", ...params.sessions];
			if (params.force) args.push("--force");
			const result = await zmxExec(args, { timeout: 10 });
			if (result.code !== 0) {
				return {
					content: [{ type: "text" as const, text: `Failed to kill sessions: ${result.stderr || result.stdout}` }],
					isError: true,
					details: { killed: false, sessions: params.sessions },
				};
			}
			return {
				content: [{ type: "text" as const, text: `Killed sessions: ${params.sessions.join(", ")}` }],
				details: { killed: true, sessions: params.sessions, output: result.stdout },
			};
		},
	});

	// ── z m x _ h i s t o r y ───────────────────────────────────────────────

	pi.registerTool({
		name: "zmx_history",
		label: "ZMX History",
		description: "View recent output/scrollback from a zmx session.",
		parameters: Type.Object({
			session: Type.String({ description: "Session name" }),
			lines: Type.Optional(
				Type.Integer({
					description: "Number of recent lines to show (default: 100, max: 1000)",
					minimum: 1,
					maximum: 1000,
				}),
			),
			format: Type.Optional(
				Type.Union([Type.Literal("text"), Type.Literal("vt"), Type.Literal("html")], {
					description: "Output format (default: text)",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const lines = Math.min(params.lines ?? 100, 1000);
			const formatArgs = params.format && params.format !== "text" ? [`--${params.format}`] : [];

			const result = await zmxExec(["history", params.session, ...formatArgs], { timeout: 15 });
			if (result.code !== 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to get history for "${params.session}": ${result.stderr || result.stdout}`,
						},
					],
					isError: true,
				};
			}

			const allLines = result.stdout.split("\n");
			const tail = allLines.slice(-lines).join("\n");

			return {
				content: [{ type: "text" as const, text: tail }],
				details: {
					session: params.session,
					totalLines: allLines.length,
					shownLines: Math.min(lines, allLines.length),
				},
			};
		},
	});

	// ── z m x _ w a i t ─────────────────────────────────────────────────────

	pi.registerTool({
		name: "zmx_wait",
		label: "ZMX Wait",
		description:
			"Block this turn until a zmx session's task completes (bounded by `timeout`). " +
			"Prefer zmx_run_background or zmx_watch for long tasks: they return immediately and " +
			"send a completion message instead of making the agent poll or time out.",
		parameters: Type.Object({
			session: Type.String({ description: "Session name" }),
			timeout: Type.Optional(
				Type.Integer({
					description: "Maximum seconds to wait (default: 30, max: 300)",
					minimum: 1,
					maximum: 300,
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const timeout = Math.min(params.timeout ?? 30, 300);
			const result = await zmxExec(["wait", params.session], { timeout });
			if (result.code !== 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Wait for "${params.session}" timed out or failed: ${result.stderr || result.stdout}`,
						},
					],
					details: { session: params.session, completed: false, timedOut: true },
				};
			}
			return {
				content: [{ type: "text" as const, text: `Session "${params.session}" tasks completed.` }],
				details: { session: params.session, completed: true },
			};
		},
	});

	// ── z m x _ r u n _ b a c k g r o u n d ─────────────────────────────────

	pi.registerTool({
		name: "zmx_run_background",
		label: "ZMX Run Background",
		description:
			"Start a long-running command in a zmx session and return immediately. " +
			"The call ends your turn: you must stop generating after it returns. " +
			"When the command exits you receive one message with the exit code and the last N lines of output, " +
			"which starts your next turn.",
		promptSnippet: "Start long-running zmx commands and get notified when they finish",
		promptGuidelines: [
			"Use zmx_run_background for commands that may run longer than a tool timeout: builds, training, simulations, long test suites.",
			"After zmx_run_background or zmx_watch returns, STOP: make no further tool calls and add no commentary. End your turn immediately.",
			"You will be woken by one message with the exit code and the output tail; that message starts your next turn. Do NOT poll with zmx_wait or zmx_history.",
			"Commands in one session run sequentially — do not start a second background task in the same session while one is running.",
			"Multiple zmx sessions may be watched at once; each completion notice reports how many watches remain.",
			'No shell wrapper: pass each argument as a separate array element; use ["sh", "-c", "..."] for shell operators.',
		],
		parameters: Type.Object({
			command: Type.Array(Type.String(), {
				description: "Command to execute (argv array, no shell wrapper). Pass each argument as a separate array element.",
			}),
			session: Type.Optional(
				Type.String({
					description: "ZMX session name. Defaults to the pi session display name if set. Required if pi has no session name.",
				}),
			),
			label: Type.Optional(
				Type.String({ description: 'Short label used in the completion message (e.g. "nightly build").' }),
			),
			tailLines: Type.Optional(
				Type.Integer({
					description: "Output tail lines included in the completion message (default: 20, max: 200).",
					minimum: 0,
					maximum: 200,
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const session = resolveSessionName(params.session);
			if (!session) {
				return {
					content: [{
						type: "text" as const,
						text: "No session name available. Either provide a `session` parameter or set a pi session name first.",
					}],
					isError: true,
				};
			}
			if (watches.has(session)) {
				return {
					content: [{
						type: "text" as const,
						text: `Already watching session "${session}". Wait for its completion message or call zmx_unwatch first.`,
					}],
					isError: true,
				};
			}
			if (params.command.length === 0) {
				return {
					content: [{ type: "text" as const, text: "`command` must not be empty." }],
					isError: true,
				};
			}

			const command = params.command;
			const result = await zmxExec(["run", session, "-d", ...command], { timeout: 30 });
			if (result.code !== 0) {
				return {
					content: [{
						type: "text" as const,
						text: `Failed to start background task in "${session}": ${result.stderr || result.stdout || `exit code ${result.code}`}`,
					}],
					isError: true,
				};
			}

			await startWatch({ session, command: command.join(" "), label: params.label, tailLines: params.tailLines });

			const tailLines = params.tailLines ?? 20;
			return {
				content: [{
					type: "text" as const,
					text:
						`Background task started in zmx session "${session}".\n\n` +
						"STOP NOW: end your reply immediately. Do not call any more tools and do not add commentary. " +
						"Todo reminders are paused while the task runs. " +
						`You will be woken by one message with the exit code and the last ${tailLines} lines of output ` +
						"when the task exits; that message starts your next turn.",
				}],
				details: { session, command: command.join(" "), background: true },
			};
		},
	});

	// ── z m x _ w a t c h ───────────────────────────────────────────────────

	pi.registerTool({
		name: "zmx_watch",
		label: "ZMX Watch",
		description:
			"Watch a zmx session that is already running a command and get a message when the command exits. " +
			"The call ends your turn: you must stop generating after it returns. " +
			"Tracks the task most recently started with `zmx run` in that session. " +
			"For sessions created with `zmx attach <name> <command>`, the notice reports when the session process exits.",
		promptSnippet: "Watch an already-running zmx session and get notified on completion",
		promptGuidelines: [
			"Use zmx_watch when a long command was started in a zmx session outside this tool call (another agent, a shell, a previous session).",
			"After zmx_watch returns, STOP: make no further tool calls and add no commentary. End your turn immediately.",
			"You will be woken by one message with the exit code and the output tail; that message starts your next turn. Do NOT poll with zmx_wait.",
			"Only tasks started with `zmx run` are tracked. An interactive shell session with no command only reports when the session itself ends.",
			"Multiple zmx sessions may be watched at once; each completion notice reports how many watches remain.",
			"If the session's last task already finished, the tool returns that result immediately instead of waiting.",
		],
		parameters: Type.Object({
			session: Type.String({ description: "Session name to watch" }),
			label: Type.Optional(
				Type.String({ description: "Short label used in the completion message." }),
			),
			tailLines: Type.Optional(
				Type.Integer({
					description: "Output tail lines included in the completion message (default: 20, max: 200).",
					minimum: 0,
					maximum: 200,
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const session = params.session;
			const info = await getSessionInfo(session);
			if (!info) {
				const sessions = await listSessions();
				return {
					content: [{
						type: "text" as const,
						text: sessions.length
							? `No zmx session named "${session}". Active sessions: ${sessions.join(", ")}`
							: `No zmx session named "${session}". There are no active zmx sessions.`,
					}],
					isError: true,
				};
			}
			if (watches.has(session)) {
				return {
					content: [{
						type: "text" as const,
						text: `Already watching session "${session}". Wait for its completion message or call zmx_unwatch first.`,
					}],
					isError: true,
				};
			}

			const tailLines = params.tailLines ?? 20;
			if (info.ended !== undefined) {
				const exitCode = info.exitCode ?? 0;
				const tail = await readTail(session, tailLines);
				const lines = [
					`[zmx] Session "${session}" is not running a task: its last task already finished (exit code ${exitCode}).`,
				];
				if (info.cmd) lines.push(`Command: ${info.cmd}`);
				if (tail) lines.push("", `Output tail (last ${tailLines} lines):`, tail);
				lines.push("", `Full scrollback: zmx_history(session="${session}").`);
				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: { session, alreadyFinished: true, exitCode },
				};
			}

			await startWatch({ session, command: info.cmd, label: params.label, tailLines });
			return {
				content: [{
					type: "text" as const,
					text:
						`Watching zmx session "${session}".\n\n` +
						"STOP NOW: end your reply immediately. Do not call any more tools and do not add commentary. " +
						"Todo reminders are paused while the task runs. " +
						`You will be woken by one message with the exit code and the last ${tailLines} lines of output ` +
						"when the task exits; that message starts your next turn.",
				}],
				details: { session, background: true },
			};
		},
	});

	// ── z m x _ u n w a t c h ───────────────────────────────────────────────

	pi.registerTool({
		name: "zmx_unwatch",
		label: "ZMX Unwatch",
		description:
			"Stop watching zmx sessions started with zmx_run_background or zmx_watch. No completion message will be sent.",
		parameters: Type.Object({
			session: Type.Optional(Type.String({ description: "Session to stop watching" })),
			all: Type.Optional(Type.Boolean({ description: "Stop watching every session" })),
		}),
		async execute(_toolCallId, params) {
			if (params.all) {
				const sessions = [...watches.keys()];
				for (const session of sessions) stopWatch(session);
				return {
					content: [{
						type: "text" as const,
						text: sessions.length ? `Stopped watching: ${sessions.join(", ")}` : "No active watchers.",
					}],
					details: { stopped: sessions },
				};
			}
			if (!params.session) {
				return {
					content: [{ type: "text" as const, text: "Provide a `session` or set `all: true`." }],
					isError: true,
				};
			}
			const stopped = stopWatch(params.session);
			return {
				content: [{
					type: "text" as const,
					text: stopped
						? `Stopped watching session "${params.session}".`
						: `No active watcher for session "${params.session}".`,
				}],
				details: { session: params.session, stopped },
			};
		},
	});

	// ── z m x _ a t t a c h ─────────────────────────────────────────────────

	pi.registerTool({
		name: "zmx_attach",
		label: "ZMX Attach",
		description:
			"Get instructions for manually attaching to a zmx session. " +
			"Use this when you need interactive terminal access or human input that the agent cannot provide: " +
			"entering passwords, sudo prompts, interactive installers, vim, htop, git rebase -i, etc. " +
			"Workflow: use zmx_run to start the process, call zmx_attach to prompt the human to attach and complete the interaction, then use zmx_wait + zmx_history to continue once they are done.",
		parameters: Type.Object({
			session: Type.String({ description: "Session name to attach to" }),
		}),
		async execute(_toolCallId, params) {
			const sessions = await listSessions();
			const exists = sessions.includes(params.session);
			const cmd = `zmx attach ${params.session}`;

			const instruction = exists
				? `Session "${params.session}" exists. Attach with:\n\n  ${cmd}`
				: `Session "${params.session}" does not exist yet. Create & attach with:\n\n  ${cmd}`;

			return {
				content: [
					{
						type: "text" as const,
						text: `${instruction}\n\nTo detach later: press Ctrl+\\ (or \`zmx detach\` from another terminal)`,
					},
				],
				details: { session: params.session, exists, attachCommand: cmd },
			};
		},
	});

	// ── / z m x   c o m m a n d ─────────────────────────────────────────────

	pi.registerCommand("zmx", {
		description: "Open interactive ZMX session manager",
		handler: async (_args, ctx) => {
			const sessions = await listSessions();

			if (!ctx.hasUI) {
				const msg =
					sessions.length > 0
						? `Active sessions: ${sessions.join(", ")}`
						: "No active zmx sessions.";
				ctx.ui.notify(msg, "info");
				return;
			}

			const options = [
				...(sessions.length > 0 ? sessions.map((s) => `attach:${s}`) : []),
				"new:default",
				...(sessions.length > 0 ? sessions.map((s) => `kill:${s}`) : []),
				...(sessions.length > 0 ? ["kill:all"] : []),
			];

			if (options.length === 0) {
				ctx.ui.notify("No zmx sessions. Create one with `zmx_run` or `zmx attach default`.", "info");
				return;
			}

			const choice = await ctx.ui.select("ZMX Session Manager", options);
			if (!choice) return;

			const [action, ...rest] = choice.split(":");
			const target = rest.join(":");

			switch (action) {
				case "attach":
					ctx.ui.notify(`Attach with: zmx attach ${target}`, "info");
					break;
				case "new": {
					const r = await zmxExec(["run", target, "echo", `"zmx session ${target} initialized"`], { timeout: 10 });
					if (r.code === 0) {
						ctx.ui.notify(`Session "${target}" created. Attach with: zmx attach ${target}`, "success");
					} else {
						ctx.ui.notify(`Failed: ${r.stderr}`, "error");
					}
					break;
				}
				case "kill":
					if (target === "all") {
						for (const s of sessions) await zmxExec(["kill", s], { timeout: 5 });
						ctx.ui.notify("All sessions killed.", "info");
					} else {
						const r = await zmxExec(["kill", target], { timeout: 5 });
						if (r.code === 0) ctx.ui.notify(`Session "${target}" killed.`, "info");
						else ctx.ui.notify(`Failed: ${r.stderr}`, "error");
					}
					break;
				default:
					break;
			}
		},
	});
}
