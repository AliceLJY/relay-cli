# relay-cli

`relay-cli` is a small local control plane for letting Codex and Claude work with each other without turning the project into a chat room.

The installed command is intentionally short:

```sh
duo status
duo start --parent codex "implement the next relay-cli improvement"
duo brake "direction is drifting"
duo resume "new direction: keep this as process orchestration, not a room"
duo mcp
duo watch
```

## Boundary

This is not `agent-room-cli`.

- `agent-room-cli`: human-led shared room, mention routing, transcript-first collaboration.
- `relay-cli`: agent-led local process orchestration, with the human driver retaining an immediate brake.

## Current MVP

- Runs an MCP server through `duo mcp`.
- Exposes Codex/Claude process orchestration tools to agents.
- Uses tmux as the first PTY backend.
- Stores project-local state in `.duo/state.json`.
- Gives the operator explicit control commands: `status`, `brake`, `resume`, and `abort`.
- Adds a parent-child startup path through `duo start --parent`.
- Adds one-shot paired startup through `duo pair`.
- Adds a human observer view through `duo watch`.
- Injects `DUO_PROCESS_ID` / `DUO_RUNTIME` / `DUO_DEPTH` as real environment variables so the parent-child chain is anchored in process state, not just prompt text.

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
- `need_human` is blocking: the calling agent waits for the human operator to resume with direction.
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

## Recommended Start

For real delegation, start one chosen parent and let that parent decide whether to spawn the other runtime:

```sh
duo start --parent codex "implement the next small relay-cli improvement"
duo start --parent claude "critique the current relay-cli handoff design"
```

That creates one root process, attaches you to its tmux session, and keeps the second runtime out of the picture until the parent explicitly asks for help through duo MCP.

## Quick Pair Start

When the operator explicitly wants side-by-side fan-out instead of parent-child delegation, use:

```sh
duo pair "implement the next small relay-cli improvement"
```

That spawns one `codex` process and one `claude` process from the same task text, then drops into `duo watch` by default. This is parallel fan-out, not a parent-child flow. Use `duo pair --no-watch ...` if you only want the startup step.

## Two-Machine Setup

This repo was authored on a Mac mini but designed to run on a MacBook. A helper script keeps the two in sync from the mini side:

```sh
npm run install:macbook
```

It syncs the source to `mac:~/Projects/relay-cli`, installs dependencies with `npm ci`, runs checks, links `duo`, registers the `duo` MCP server for Codex, and ensures the Claude project-level `.mcp.json` exists.

Runtime requirements on the machine that actually runs `duo`: both `codex` and `claude` CLI must be installed and authenticated.

To expose the control plane to an agent, configure that agent with an MCP server command equivalent to:

```sh
duo mcp
```

The repo also carries a project-level [`.mcp.json`](./.mcp.json) so Claude Code can discover the `duo` MCP server inside this project.

For the full operator workflow, see [docs/macbook-start-playbook.md](./docs/macbook-start-playbook.md).

## Chinese Version

See [README_CN.md](./README_CN.md).

## Status

This is a personal experiment-grade tool. It works, it is under active shaping, and the surface may shift without deprecation notices. Use it as a reference or a starting point rather than a stable dependency.

## License

MIT — see [LICENSE](./LICENSE).
