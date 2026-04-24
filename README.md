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

### Auto session naming

Set a pi session name via `pi.setSessionName()` in an extension (e.g. the [session-name example](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/session-name.ts)) and `zmx_run` will use it automatically with no `session` param needed.

## License

MIT
