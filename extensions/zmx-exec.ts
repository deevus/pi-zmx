/**
 * ZMX Exec Extension
 *
 * Executes shell commands inside persistent zmx sessions.
 * Filesystem side effects, background processes, and exported
 * env vars persist across calls within the same session.
 *
 * Tools:
 *   zmx_run     - Run a shell command in a zmx session
 *   zmx_list    - List active zmx sessions
 *   zmx_kill    - Kill one or more zmx sessions
 *   zmx_history - View recent output from a session
 *   zmx_wait    - Wait for session tasks to complete
 *   zmx_attach  - Show instructions for manually attaching to a session
 *
 * Commands:
 *   /zmx       - Open interactive zmx session manager
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";
import {
	configFromEnv,
	mergeConfig,
	parseRunOutput,
	readConfigFile,
	resolveSessionCreate,
	sanitizeText,
	stripAnsi,
	type SessionCreate,
} from "./zmx-lib.ts";

// ─── Extension ──────────────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
	// CLI override for the session shell (highest precedence). See zmx-lib.
	pi.registerFlag("zmx-shell", {
		description: "Shell for new zmx sessions: clean | full | <path to shell>",
		type: "string",
	});

	// How sessions are created (shell + env), resolved lazily on first use so
	// CLI flags are parsed and the project cwd is known. Precedence:
	//   --zmx-shell > $PI_ZMX_* > <cwd>/.pi/zmx.json > ~/.pi/agent/zmx.json > default
	let cachedCreate: SessionCreate | undefined;
	function sessionCreateFor(cwd: string): SessionCreate {
		if (cachedCreate) return cachedCreate;
		const flagShell =
			typeof pi.getFlag === "function" ? (pi.getFlag("zmx-shell") as string | undefined) : undefined;
		const config = mergeConfig(
			flagShell ? { shell: flagShell } : undefined,
			configFromEnv(process.env),
			readConfigFile(join(cwd, CONFIG_DIR_NAME, "zmx.json")),
			readConfigFile(join(getAgentDir(), "zmx.json")),
		);
		cachedCreate = resolveSessionCreate(config);
		return cachedCreate;
	}
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
		for (const name of ["zmx_run", "zmx_list", "zmx_kill", "zmx_history", "zmx_wait", "zmx_attach"]) {
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
		options?: { timeout?: number; env?: Record<string, string> },
	): Promise<{ stdout: string; stderr: string; code: number }> {
		try {
			// When creating a session we need extra env (SHELL, PS1, ...) to reach
			// the zmx client that spawns the PTY. Run via `/usr/bin/env K=V ... zmx`
			// so it applies regardless of whether pi.exec forwards a custom env.
			const env = options?.env;
			const [cmd, cmdArgs]: [string, string[]] =
				env && Object.keys(env).length > 0
					? [
							"/usr/bin/env",
							[...Object.entries(env).map(([k, v]) => `${k}=${v}`), "zmx", ...args],
						]
					: ["zmx", args];
			const result = await pi.exec(cmd, cmdArgs, {
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

	async function ensureSession(
		session: string,
		createEnv: Record<string, string>,
	): Promise<{ ok: boolean; error?: string }> {
		const sessions = await listSessions();
		if (sessions.includes(session)) return { ok: true };

		// Create the session with the clean shell + controlled prompt so its PTY
		// doesn't run the full interactive login shell (see resolveSessionCreate).
		const result = await zmxExec(["run", session, "true"], { timeout: 10, env: createEnv });
		if (result.code !== 0) {
			return { ok: false, error: result.stderr || result.stdout || `failed to create session "${session}"` };
		}
		return { ok: true };
	}

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
			"Output is sanitized: terminal escape/prompt sequences are stripped, so it is safe to parse even with complex user shells.",
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
			const piSessionName = pi
				.getSessionName()
				?.toLowerCase()
				.replace(/\s+/g, "-")
				.replace(/[^\w-]/g, "") || undefined;

			const session = params.session ?? piSessionName;

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

			// 1) Ensure session exists (created with the resolved clean/full shell)
			const ensured = await ensureSession(session, sessionCreateFor(ctx.cwd).env);
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

			// zmx itself failed to run the command (bad session, timeout, etc.).
			if (runResult.code !== 0) {
				const { text } = parseRunOutput(runResult.stdout);
				return {
					content: [
						{
							type: "text" as const,
							text: sanitizeText(runResult.stderr) || text || `Command failed with exit code ${runResult.code}`,
						},
					],
					details: { session, command: commandStr, exitCode: runResult.code, stderr: sanitizeText(runResult.stderr) },
					isError: true,
				};
			}

			// Sanitize captured PTY output and recover the inner command's real
			// exit status from zmx's completion marker (more accurate than zmx's
			// own exit code, which is 0 even when the inner command failed).
			const { text, markerExit } = parseRunOutput(runResult.stdout);
			const exitCode = markerExit ?? 0;

			if (exitCode !== 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: text || `Command exited with code ${exitCode}.`,
						},
					],
					details: { session, command: commandStr, exitCode, stdout: text },
					isError: true,
				};
			}

			return {
				content: [
					{
						type: "text" as const,
						text: text || "Command completed successfully (no output).",
					},
				],
				details: { session, command: commandStr, exitCode: 0, stdout: text },
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
			const sessions = stripAnsi(result.stdout) || "(no active sessions)";
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

			const allLines = sanitizeText(result.stdout).split("\n");
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
			"Wait for zmx session tasks to complete. Use after zmx_run to ensure " +
			"a command has finished before checking zmx_history.",
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
					const r = await zmxExec(["run", target, "echo", `"zmx session ${target} initialized"`], { timeout: 10, env: sessionCreateFor(ctx.cwd).env });
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
