# MacBook Start Playbook

## Core Rule

Do not manually start both Codex and Claude as parent agents at the same time.

Start one parent agent only. Let that parent decide whether to spawn the other agent through `duo`.

Default parent choice:

- Start `codex` as the parent for implementation-heavy work.
- Start `claude` as the parent for prompt shaping, critique, planning, or research-heavy work.

## Before You Start

Run these in the MacBook terminal inside the project:

```sh
cd ~/Projects/relay-cli
duo status
duo runtimes --check-auth
```

Then start one parent through duo:

```sh
duo start --parent codex "这里写任务目标"
```

or:

```sh
duo start --parent claude "这里写任务目标"
```

Optional fast side-by-side start when Alice explicitly wants both visible from one command:

```sh
duo pair "这里写任务目标"
```

This is a convenience startup path, not the default recommendation. Treat it as fan-out, not delegation. The default remains: start one parent and let that parent decide whether to spawn the other side through `duo`.

## When Alice Should Start

Alice should manually start the parent agent only at these moments:

1. At the beginning of a new task, when the goal, constraints, and acceptance bar are ready.
2. After Alice has changed direction and wants a fresh attempt under the new constraints.
3. After a `duo brake`, once Alice has decided the next direction.

Alice does not need to manually start both sides or relay messages between them during normal operation. Alice chooses the parent once at launch; the parent chooses whether a child is needed later.

## Default Codex Parent Prompt

Use this when the task is implementation-first:

```text
你现在在 ~/Projects/relay-cli。
使用 duo MCP 作为本地编排层。
目标：<这里写任务目标>。
约束：<这里写硬约束>。
验收标准：<这里写什么算完成>。

默认你自己先推进；如果某个子问题更适合 Claude，就用 duo spawn_agent 起一个 Claude 子进程，把问题切小后交给它。
不要把整个任务原封不动转包。
读回 Claude 输出后，你自己整合、判断、推进。

遇到需要我拍板的点，调用 need_human。
如果方向明显偏了，我会直接 brake。
不要做不可逆操作；关键选择先给我 2 个选项、推荐 1 个。
```

## Default Claude Parent Prompt

Use this when the task is critique-first, planning-first, or research-first:

```text
你现在在 ~/Projects/relay-cli。
使用 duo MCP 作为本地编排层。
目标：<这里写任务目标>。
约束：<这里写硬约束>。
验收标准：<这里写什么算完成>。

默认你先负责拆解、审视、收敛方向；如果某个实现子问题更适合 Codex，就用 duo spawn_agent 起一个 Codex 子进程，把问题切成明确子任务后交给它。
不要把整个任务原封不动转包。
读回 Codex 输出后，你自己判断是否采纳，再继续推进。

遇到需要我拍板的点，调用 need_human。
如果方向明显偏了，我会直接 brake。
不要做不可逆操作；关键选择先给我 2 个选项、推荐 1 个。
```

## Brake Prompt

Use this when Alice wants to stop the current direction immediately:

```text
立刻停下。不要继续 spawn，不要继续写入，不要继续外部操作。
总结当前方向、已做内容、剩余风险、你建议的新方向。
等我下一句，不要自行恢复。
```

## Resume Prompt

Use this after a brake or a decision:

```text
新方向：<这里写新方向>。
保留这些已有效部分：<这里写保留项>。
放弃这些部分：<这里写放弃项>。
先用 2-3 步重排计划，再继续执行。
```

## What Good Handoff Looks Like

Good spawn request:

```text
用 duo spawn_agent 起一个 Claude 子进程。
名字叫 review-logging-plan。
只让它审这个问题：当前日志设计有没有明显观测盲区？
让它给出 3 个具体风险和 1 个推荐方案。
```

Bad spawn request:

```text
你去找 Claude 把整个任务做完。
```
