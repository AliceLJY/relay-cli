# MacBook Start Playbook

## Core Rule

Start one parent agent. The parent owns the task and should actively pull a child agent at meaningful action checkpoints for scoped review, diagnosis, or implementation slices.

This is different from `agent-room-cli`: there is no shared room transcript, and Alice should not have to mention or route another agent. The parent delegates, reads the child output, and integrates the decision.

Default parent choice:

- `codex` for implementation-heavy work.
- `claude` for critique, planning, or research-heavy work.

## Commands

```sh
cd ~/Projects/relay-cli
duo start --parent claude
duo start --parent codex
duo list
duo show <prefix>
duo watch
```

## Usage

Start a parent:

```sh
duo start --parent codex "这里写任务目标"
```

or:

```sh
duo start --parent claude "这里写任务目标"
```

Check active parents:

```sh
duo list
```

Inspect a Claude parent log:

```sh
duo show <prefix>
```

Watch child-agent panes:

```sh
duo watch
```

## Parent Prompt Shape

```text
你现在在 ~/Projects/relay-cli。
目标：<这里写任务目标>。
约束：<这里写硬约束>。
验收标准：<这里写什么算完成>。

默认你自己先推进；每到一个有意义的动作节点，主动 duo 另一个 agent 做局部审查、诊断或实现切片。
如果某个子问题更适合另一个 agent，就把问题切小后交给它。
不要把整个任务原封不动转包。
读回子 agent 输出后，你自己整合、判断、推进。
非平凡任务默认要有局部子 agent 审查或实现切片，除非任务明显不需要。
```
