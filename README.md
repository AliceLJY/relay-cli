# relay-cli

`relay-cli` is a small local control plane for letting Codex and Claude work with each other without turning the project into a chat room.

The installed command is intentionally short:

```sh
duo status
duo brake "direction is drifting"
duo resume "new direction: keep this as process orchestration, not a room"
duo mcp
duo watch
```

## Boundary

This is not `agent-room-cli`.

- `agent-room-cli`: human-led shared room, mention routing, transcript-first collaboration.
- `relay-cli`: agent-led local process orchestration, with Alice retaining an immediate brake.

## Current MVP

- Runs an MCP server through `duo mcp`.
- Exposes Codex/Claude process orchestration tools to agents.
- Uses tmux as the first PTY backend.
- Stores project-local state in `.duo/state.json`.
- Gives Alice explicit control commands: `status`, `brake`, `resume`, and `abort`.
- Adds a human observer view through `duo watch`.

## MCP tools

- `whoami`
- `list_runtimes`
- `spawn_agent`
- `send_input`
- `get_output`
- `get_status`
- `cancel_agent`
- `close_process`
- `need_human`

## Safety Model

The default is autonomous Codex/Claude collaboration, not autonomous irreversible action.

- `duo brake` freezes new spawn/send actions without killing current panes.
- `duo resume` clears the brake and can answer a pending `need_human` request.
- `need_human` is blocking: the calling agent waits for Alice to resume with direction.
- Spawn depth is capped at 2.
- A process that has not produced observed output for 5 minutes causes a brake on the next status or tool check.
- Three recorded tool failures trigger a brake.

## Local Development

```sh
npm install
npm run check
npm link
duo status
```

## MacBook Install

This repo is created on the Mac mini, but Alice usually works from the MacBook.

Use the helper script from the mini:

```sh
npm run install:macbook
```

It syncs the source to `mac:~/Projects/relay-cli`, installs dependencies with `npm ci`, runs checks, links `duo`, registers the `duo` MCP server for Codex, and ensures the Claude project-level `.mcp.json` exists.

Current MacBook runtime requirement: `codex` is available, but `claude` must also be installed on the MacBook for full Codex/Claude orchestration.

To expose the control plane to an agent, configure that agent with an MCP server command equivalent to:

```sh
duo mcp
```

The repo also carries a project-level [`.mcp.json`](/Users/USER/Projects/relay-cli/.mcp.json) so Claude Code can discover the `duo` MCP server inside this project on the MacBook.

For the actual MacBook operator workflow, see [docs/macbook-start-playbook.md](/Users/USER/Projects/relay-cli/docs/macbook-start-playbook.md).
