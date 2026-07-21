# @deevus/pi-zmx

A [pi](https://github.com/badlogic/pi-mono) extension that executes shell commands inside persistent [zmx](https://zmx.sh) sessions.

## Features

- **Persistent sessions** — filesystem effects, background processes, and exported env vars survive across tool calls
- **Non-blocking** — `zmx_run` sends commands and returns immediately; use `zmx_wait` when you need to block
- **Human-in-the-loop** — start a process, prompt the user to attach and enter a password or interact, then continue
- **Auto session naming** — defaults to the pi session display name if set; otherwise requires an explicit session name

## Requirements

[zmx](https://zmx.sh) must be installed and on your `PATH`:

```bash
brew install neurosnap/tap/zmx
```

Or download a binary directly from [zmx.sh](https://zmx.sh/#binaries).

## Configuration

### Session shell

zmx creates a session by spawning a **login `$SHELL`**. If that is your real
interactive shell (fish/zsh/bash with starship, atuin, or other shell
integrations), it emits OSC / prompt escape sequences that get interleaved
with the command output this extension captures. To stay robust the extension
both (a) creates sessions in a quiet shell and (b) sanitizes all captured
output (stripping escape/prompt sequences), so it survives arbitrarily complex
prompts.

The `shell` setting selects how new sessions are created:

| Value | Behavior |
| --- | --- |
| _unset_ or `clean` | **Default.** Spawn `/bin/sh` (fallback `/bin/bash`) with a simple controlled prompt and no prompt-framework hooks. |
| `full` / `interactive` / `login` | Use your real login `$SHELL` — full interactive prompt (original behavior). |
| _any other value_ | Treated as a custom shell path, e.g. a wrapper that execs `bash --noprofile --norc -i`. |

The `ps1` setting overrides the clean-mode prompt string (default: `zmx$ `).

#### Where to set it (highest precedence first)

1. **CLI flag:** `pi --zmx-shell full` (or `--zmx-shell /path/to/shell`)
2. **Environment:** `PI_ZMX_SHELL` / `PI_ZMX_PS1`
3. **Project config:** `<cwd>/.pi/zmx.json`
4. **Global config:** `~/.pi/agent/zmx.json`
5. Built-in default (`clean`)

The JSON config files are the idiomatic pi mechanism (same pattern as pi's
`presets.json`) and let you use, say, `full` in one repo and `clean` elsewhere:

```json
// ~/.pi/agent/zmx.json  (or  <project>/.pi/zmx.json)
{
  "shell": "clean",
  "ps1": "zmx$ "
}
```

```bash
# One-off override for a single run:
pi --zmx-shell full

# Or via environment:
export PI_ZMX_SHELL=full
```

The setting only affects **newly created** sessions.

## Install

```bash
pi install npm:@deevus/pi-zmx
```

## Tools

| Tool | Description |
|---|---|
| `zmx_run` | Send a shell command to a zmx session (non-blocking) |
| `zmx_wait` | Wait for session tasks to complete |
| `zmx_history` | View recent scrollback from a session |
| `zmx_list` | List active zmx sessions |
| `zmx_kill` | Kill one or more zmx sessions |
| `zmx_attach` | Get instructions for manually attaching to a session |

## Commands

| Command | Description |
|---|---|
| `/zmx` | Interactive session manager (attach / create / kill) |

## Usage

### Basic

```
zmx_run(session="my-project", command="npm test")
zmx_wait(session="my-project")
zmx_history(session="my-project", lines=50)
```

### Human-in-the-loop (e.g. password prompt)

```
zmx_run(session="my-project", command="sudo apt update")
zmx_attach(session="my-project")
# → tells the human to run: zmx attach my-project
# → human enters password and detaches with Ctrl+\
zmx_wait(session="my-project")
zmx_history(session="my-project")
```


## License

MIT
