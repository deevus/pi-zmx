# @deevus/pi-zmx

A [pi](https://github.com/badlogic/pi-mono) extension that executes shell commands inside persistent [zmx](https://zmx.sh) sessions.

## Features

- **Persistent sessions** — filesystem effects, background processes, and exported env vars survive across tool calls
- **Synchronous by default** — `zmx_run` blocks until the command exits; use `zmx_run_background` for long tasks
- **Completion notifications** — `zmx_run_background` / `zmx_watch` return immediately and message the agent when the task exits, so long tasks need neither polling nor a held tool call
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
| `zmx_run` | Send a shell command to a zmx session (synchronous) |
| `zmx_run_background` | Start a long task and get a message when it exits |
| `zmx_watch` | Watch an already-running session until its task exits |
| `zmx_unwatch` | Stop watching a session |
| `zmx_wait` | Wait for session tasks to complete (blocking) |
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

### Long tasks without polling

`zmx_run_background` starts a command in a detached zmx task, registers a
watcher, and returns at once. The tool result tells the agent to stop: after the
call it must end its turn — no further tool calls, no commentary. The next turn
starts either from user input or from the completion message, which carries the
exit code and the last N lines of output (`tailLines`, default 20). The
extension runs `zmx wait <session>` in the background while the agent is idle.

While at least one watch is active, the extension pauses the session's
`todo.reminders` setting and releases the override when the last watch
finishes. This keeps OMP's "you stopped with incomplete todos" reminder from
starting an extra turn during an intentional stop. If reminders were already
off, the setting is left alone; hosts without that setting skip the step.

Multiple zmx sessions can be watched at once (one watch per session). Each
completion notice reports how many watches are still running and which sessions
they cover, e.g. `Remaining watches: 1 (train [nightly training]).`

```
zmx_run_background(session="train", command=["python", "train.py"], label="nightly training")
# → returns immediately; the agent ends its turn
# → "[zmx] Watched task exited; resume your previous work."
#    "Session: train" / "Status: success (exit code 0)" / "Duration: 1h 12m"
#    "Output tail (last 20 lines): ..."
```

To pick up a task that is already running in a zmx session (started by another
agent, a shell, or a previous session), watch it instead:

```
zmx_watch(session="train")
```

`zmx_unwatch(session=...)` (or `all=true`) cancels a watch and suppresses its
completion message.

How completion is detected:

- Tasks started with `zmx run` carry an exit-code marker; `zmx wait` reports the
  code when the task ends. This is what `zmx_run_background` and `zmx_watch`
  use, so both success and failure are reported.
- A session created with `zmx attach <name> <command>` has no tracked task; the
  watch reports when the session process exits (exit code unavailable).
- A plain interactive shell session is only reported when the session itself
  ends — zmx has no completion marker for commands typed by hand.
- `zmx_watch` on a session whose last task already finished returns that result
  immediately instead of waiting.
- Watches live in the agent process. If the agent restarts, call `zmx_watch`
  again (the zmx task keeps running independently).

The "stop after the call" instruction is the same mechanism OMP uses for its
own backgrounded `bash` jobs: the host's extension API has no hook that
terminates the turn, so the tool result directs the model to end it.

## License

MIT
