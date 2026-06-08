# relay-cli

> ⚠️ **Deprecated (2026-06).** relay-cli is no longer maintained. For local
> Codex ↔ Claude collaboration, use
> [agent-room-cli](https://github.com/AliceLJY/agent-room-cli).

`relay-cli` is a small local control plane for Codex/Claude delegation. It keeps the human-facing CLI intentionally narrow.

## Commands

```sh
duo start --parent claude
duo start --parent codex
duo list
duo show <prefix>
duo watch
```

- `duo start --parent claude`: start a Claude parent agent.
- `duo start --parent codex`: start a Codex parent agent.
- `duo list`: show active parent agents.
- `duo show <prefix>`: show one Claude parent agent's chat log. A short id prefix is enough when unique.
- `duo watch`: watch child-agent panes. Root parents stay out of this view.

## Boundary

This is not `agent-room-cli`.

- `agent-room-cli`: human-led shared room, mention routing, transcript-first collaboration.
- `relay-cli`: parent-led local process orchestration. One selected parent remains responsible, and actively pulls a child agent at meaningful action checkpoints for scoped review, diagnosis, or implementation slices.

The important default is: one parent owns the task, and child delegation is a routine checkpoint. Alice should not have to mention or route another agent the way a room workflow would.

## Current MVP

- Starts one chosen parent through `duo start --parent`.
- Lists active parent agents through `duo list`.
- Reads Claude parent chat logs through `duo show <prefix>`.
- Watches spawned child agents through `duo watch`.
- Prompts parent agents to duo the other runtime at meaningful action checkpoints, while keeping the parent responsible for integration.
- Uses tmux as the PTY backend.
- Stores project-local state in `.duo/state.json`.
- Injects `DUO_PROCESS_ID` / `DUO_RUNTIME` / `DUO_DEPTH` into agent processes.
- Keeps the MCP server as hidden plumbing for configured agents.

## Safety Model

- Spawn depth is capped at 2.
- A process with no self or child activity for 30 minutes causes a brake on the next tool check.
- Three recorded tool failures trigger a brake.

## Local Development

```sh
npm install
npm run check
npm link
duo list
```

## Two-Machine Setup

This repo was authored on a Mac mini but designed to run on a MacBook. A helper script keeps the two in sync from the mini side:

```sh
npm run install:macbook
```

Runtime requirements on the machine that actually runs `duo`: both `codex` and `claude` CLI must be installed and authenticated.

## Chinese Version

See [README_CN.md](./README_CN.md).

## Status

This is a personal experiment-grade tool. It works, it is under active shaping, and the surface may shift without deprecation notices.

## License

MIT - see [LICENSE](./LICENSE).
