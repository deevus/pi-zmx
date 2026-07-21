/**
 * Tests for the pure helpers in zmx-exec.ts.
 *
 * Run with:  node --experimental-strip-types --test extensions/zmx-lib.test.ts
 *
 * These cover the robustness-critical logic: session-creation resolution and
 * output sanitization (which must survive arbitrarily complex user prompts).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	configFromEnv,
	mergeConfig,
	parseConfig,
	parseRunOutput,
	readConfigFile,
	resolveSessionCreate,
	sanitizeText,
	stripAnsi,
} from "./zmx-lib.ts";

const ESC = "\u001B";
const BEL = "\u0007";

// ─── resolveSessionCreate ───────────────────────────────────────────────────

test("clean mode is the default and forces a plain shell + quiet prompt", () => {
	const r = resolveSessionCreate({}, (p) => p === "/bin/sh");
	assert.equal(r.mode, "clean");
	assert.equal(r.env.SHELL, "/bin/sh");
	assert.equal(r.env.PS1, "zmx$ ");
	assert.equal(r.env.PROMPT_COMMAND, "");
});

test("clean mode falls back to /bin/bash when /bin/sh is missing", () => {
	const r = resolveSessionCreate({}, (p) => p === "/bin/bash");
	assert.equal(r.env.SHELL, "/bin/bash");
});

test("ps1 config overrides the clean prompt", () => {
	const r = resolveSessionCreate({ ps1: "$ " }, () => true);
	assert.equal(r.env.PS1, "$ ");
});

test("full/interactive/login mode uses the login shell (no overrides)", () => {
	for (const v of ["full", "interactive", "login", "FULL"]) {
		const r = resolveSessionCreate({ shell: v }, () => true);
		assert.equal(r.mode, "full");
		assert.deepEqual(r.env, {});
	}
});

test("a custom value is treated as a shell path", () => {
	const r = resolveSessionCreate({ shell: "/opt/clean-shell" }, () => true);
	assert.equal(r.mode, "custom");
	assert.equal(r.env.SHELL, "/opt/clean-shell");
	assert.equal(r.env.PS1, "zmx$ ");
});

// ─── config layers ──────────────────────────────────────────────────

test("configFromEnv reads PI_ZMX_SHELL / PI_ZMX_PS1 and ignores blanks", () => {
	assert.deepEqual(configFromEnv({ PI_ZMX_SHELL: "full", PI_ZMX_PS1: "> " }), {
		shell: "full",
		ps1: "> ",
	});
	assert.deepEqual(configFromEnv({ PI_ZMX_SHELL: "  " }), {});
	assert.deepEqual(configFromEnv({}), {});
});

test("parseConfig validates and ignores unknown keys", () => {
	assert.deepEqual(parseConfig('{"shell":"/bin/sh","ps1":"# ","x":1}'), {
		shell: "/bin/sh",
		ps1: "# ",
	});
	assert.deepEqual(parseConfig('{"shell":42}'), {});
});

test("mergeConfig: first defined value per key wins (precedence order)", () => {
	const merged = mergeConfig(
		{ shell: "full" }, // flag
		{ shell: "clean", ps1: "env$ " }, // env
		{ ps1: "proj$ " }, // project file
	);
	assert.equal(merged.shell, "full");
	assert.equal(merged.ps1, "env$ ");
});

test("readConfigFile returns undefined when missing or invalid", () => {
	const missing = readConfigFile("/nope.json", { exists: () => false, read: () => "" });
	assert.equal(missing, undefined);
	const broken = readConfigFile("/x.json", { exists: () => true, read: () => "not json" });
	assert.equal(broken, undefined);
	const ok = readConfigFile("/x.json", { exists: () => true, read: () => '{"shell":"full"}' });
	assert.deepEqual(ok, { shell: "full" });
});

// ─── stripAnsi / sanitizeText ───────────────────────────────────────────────

test("strips CSI color sequences", () => {
	assert.equal(stripAnsi(`${ESC}[0;32mgreen${ESC}[0m`), "green");
});

test("strips OSC sequences (BEL- and ST-terminated)", () => {
	assert.equal(stripAnsi(`${ESC}]0;title${BEL}body`), "body");
	assert.equal(stripAnsi(`${ESC}]8;;https://x${ESC}\\link`), "link");
});

test("strips shell-integration OSC 133 / cmdline_url noise", () => {
	const mangled = `${ESC}]133;C;cmdline_url=foo${ESC}\\real output${ESC}]133;D;0${BEL}`;
	assert.equal(stripAnsi(mangled), "real output");
});

test("resolves carriage-return overwrites to the final visible text", () => {
	assert.equal(sanitizeText("progress...\rdone"), "done");
	assert.equal(sanitizeText("a\r\nb"), "a\nb");
});

test("drops stray control characters but keeps tabs", () => {
	assert.equal(sanitizeText("a\u0001b\tc"), "ab\tc");
});

// ─── parseRunOutput ─────────────────────────────────────────────────────────

test("extracts the completion marker and strips it from output", () => {
	const { text, markerExit } = parseRunOutput("hello world\nZMX_TASK_COMPLETED:0");
	assert.equal(text, "hello world");
	assert.equal(markerExit, 0);
});

test("captures a non-zero inner exit code", () => {
	const { text, markerExit } = parseRunOutput("boom\nZMX_TASK_COMPLETED:1");
	assert.equal(text, "boom");
	assert.equal(markerExit, 1);
});

test("handles a fully mangled fish-style capture", () => {
	const raw =
		`${ESC}[K hypa ${ESC}[1;36m~/p/gh-elm${ESC}[0m\r\n` +
		`${ESC}[1;32m\u276f${ESC}[0m clean output test${ESC}]133;D;0${BEL}\n` +
		`ZMX_TASK_COMPLETED:0`;
	const { text, markerExit } = parseRunOutput(raw);
	assert.equal(markerExit, 0);
	assert.ok(text.includes("clean output test"));
	assert.ok(!text.includes(ESC));
	assert.ok(!text.includes("ZMX_TASK_COMPLETED"));
});

test("no marker present leaves markerExit undefined", () => {
	const { markerExit } = parseRunOutput("just output");
	assert.equal(markerExit, undefined);
});
