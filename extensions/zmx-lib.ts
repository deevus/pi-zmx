/**
 * Pure, dependency-free helpers for the zmx extension.
 *
 * Kept in a separate module (no `typebox` / pi imports) so they can be unit
 * tested under plain Node without pi's runtime module resolver.
 */
import { existsSync, readFileSync } from "node:fs";

// ─── Configuration ──────────────────────────────────────────────────────────
//
// zmx creates a session by spawning a *login `$SHELL`* with a PTY. If that is
// the user's real interactive shell (fish + starship + shell-integration, or
// bash/zsh with atuin, etc.), it emits OSC / prompt escape sequences that get
// interleaved with — and corrupt — the command output we capture back through
// `zmx run`. Chained commands can also silently break.
//
// Robustness is layered:
//   1. Sessions are created in a quiet shell with a controlled prompt (here),
//      and
//   2. all captured output is sanitized (see sanitizeText / parseRunOutput).
//
// The `shell` setting selects behavior:
//   • unset | "clean"                  → clean mode (default): spawn /bin/sh
//     (fallback /bin/bash) with a simple, controlled PS1 and no prompt tools.
//   • "full" | "interactive" | "login" → use the user's real login $SHELL
//     (the original behavior — full interactive prompt).
//   • any other value                  → treat it as a custom shell path.
// The `ps1` setting overrides the clean-mode prompt (default: "zmx$ ").
//
// Settings are resolved by precedence (first defined wins):
//   CLI flag (--zmx-shell)
//     > $PI_ZMX_SHELL / $PI_ZMX_PS1 env
//       > <cwd>/.pi/zmx.json  (project)
//         > ~/.pi/agent/zmx.json  (global)
//           > built-in default ("clean").

export interface ZmxConfig {
	/** "clean" | "full" | "interactive" | "login" | a shell path. */
	shell?: string;
	/** Clean-mode prompt string. */
	ps1?: string;
}

export type SessionMode = "clean" | "full" | "custom";

export interface SessionCreate {
	/** Mode, for diagnostics/details. */
	mode: SessionMode;
	/** Extra environment applied when *creating* a session (may include SHELL). */
	env: Record<string, string>;
}

/** Extract a partial config from environment variables. */
export function configFromEnv(env: Record<string, string | undefined> = process.env): ZmxConfig {
	const config: ZmxConfig = {};
	const shell = env.PI_ZMX_SHELL?.trim();
	if (shell) config.shell = shell;
	if (env.PI_ZMX_PS1 !== undefined) config.ps1 = env.PI_ZMX_PS1;
	return config;
}

/** Parse (and validate) a zmx.json config document. Ignores unknown keys. */
export function parseConfig(raw: string): ZmxConfig {
	const data: unknown = JSON.parse(raw);
	const config: ZmxConfig = {};
	if (data && typeof data === "object") {
		const { shell, ps1 } = data as Record<string, unknown>;
		if (typeof shell === "string" && shell.trim()) config.shell = shell.trim();
		if (typeof ps1 === "string") config.ps1 = ps1;
	}
	return config;
}

export interface FsDeps {
	exists(path: string): boolean;
	read(path: string): string;
}

function defaultFsDeps(): FsDeps {
	return { exists: existsSync, read: (p: string) => readFileSync(p, "utf-8") };
}

/** Read a zmx.json config file, returning undefined if absent or invalid. */
export function readConfigFile(path: string, deps: FsDeps = defaultFsDeps()): ZmxConfig | undefined {
	try {
		if (!deps.exists(path)) return undefined;
		return parseConfig(deps.read(path));
	} catch {
		return undefined;
	}
}

/** Merge partial configs by precedence: the first defined value for each key wins. */
export function mergeConfig(...sources: (ZmxConfig | undefined)[]): ZmxConfig {
	const merged: ZmxConfig = {};
	for (const source of sources) {
		if (!source) continue;
		if (merged.shell === undefined && source.shell !== undefined) merged.shell = source.shell;
		if (merged.ps1 === undefined && source.ps1 !== undefined) merged.ps1 = source.ps1;
	}
	return merged;
}

/** Turn a resolved config into the shell + env used to create a session. */
export function resolveSessionCreate(
	config: ZmxConfig = {},
	fileExists: (p: string) => boolean = (p) => defaultFsDeps().exists(p),
): SessionCreate {
	const raw = config.shell?.trim();
	const prompt = config.ps1 ?? "zmx$ ";
	const lowered = raw?.toLowerCase();

	// Full interactive login shell (original behavior) — opt in explicitly.
	if (lowered === "full" || lowered === "interactive" || lowered === "login") {
		return { mode: "full", env: {} };
	}

	// A quiet prompt and no prompt-framework side effects. PROMPT_COMMAND is
	// cleared so tools like atuin/starship that hook it don't emit escapes.
	const quietEnv: Record<string, string> = { PS1: prompt, PROMPT_COMMAND: "" };

	// Clean mode (default): pick a plain POSIX shell that won't source the
	// user's interactive rc (e.g. ~/.bashrc with starship). /bin/sh does not
	// read ~/.bashrc; /bin/bash is only a last-resort fallback.
	if (!raw || lowered === "clean" || lowered === "default") {
		const shell = ["/bin/sh", "/bin/bash"].find(fileExists);
		return { mode: "clean", env: shell ? { ...quietEnv, SHELL: shell } : quietEnv };
	}

	// Custom shell path.
	return { mode: "custom", env: { ...quietEnv, SHELL: raw } };
}

// ─── Output sanitization ────────────────────────────────────────────────────
//
// Captured PTY output can contain terminal escape sequences from prompts and
// shell integrations. Strip them so output survives arbitrarily complex user
// prompts regardless of the shell that ends up running.

// CSI and OSC (BEL- or ST-terminated). Adapted from the ansi-regex pattern.
const ANSI_REGEX =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escapes is the point
	/[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

// DCS / PM / APC / SOS / OSC strings terminated by ST (ESC \) or BEL.
const STRING_ESCAPE_REGEX =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escapes is the point
	/\u001B[P\]X^_][\s\S]*?(?:\u0007|\u001B\\)/g;

export function stripAnsi(input: string): string {
	return input.replace(STRING_ESCAPE_REGEX, "").replace(ANSI_REGEX, "");
}

/** Strip escapes, resolve carriage-return overwrites, drop stray control chars. */
export function sanitizeText(raw: string): string {
	const noEscapes = stripAnsi(raw);
	// Normalize CRLF line endings first so a trailing \r before \n isn't treated
	// as a cursor-return overwrite.
	const resolvedCr = noEscapes
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => {
			// A carriage return moves the cursor to column 0; later text overwrites.
			// Approximate the final visible line by keeping text after the last \r.
			const idx = line.lastIndexOf("\r");
			return idx >= 0 ? line.slice(idx + 1) : line;
		})
		.join("\n");
	// Remove remaining C0 control chars except tab/newline.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional
	return resolvedCr.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

/**
 * Sanitize `zmx run` output and consume zmx's `ZMX_TASK_COMPLETED:<code>`
 * completion marker. The marker carries the *inner command's* exit status,
 * which is more accurate than zmx's own process exit code.
 */
export function parseRunOutput(raw: string): { text: string; markerExit?: number } {
	const cleaned = sanitizeText(raw);
	let markerExit: number | undefined;
	const kept: string[] = [];
	for (const line of cleaned.split("\n")) {
		const m = line.match(/ZMX_TASK_COMPLETED:(\d+)/);
		if (m) {
			markerExit = Number(m[1]);
			const before = line.slice(0, m.index).replace(/[;\s]+$/, "");
			if (before) kept.push(before);
			continue;
		}
		kept.push(line);
	}
	const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\s+$/g, "");
	return { text, markerExit };
}
