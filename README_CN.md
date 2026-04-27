# relay-cli

`relay-cli` 是一个很小的本地控制层，用来做 Codex/Claude 委派。人直接使用的 CLI 命令面保持很窄。

## 命令

```sh
duo start --parent claude
duo start --parent codex
duo list
duo show <prefix>
duo watch
```

- `duo start --parent claude`：起 Claude 父 agent。
- `duo start --parent codex`：起 Codex 父 agent。
- `duo list`：看当前活的父 agent。
- `duo show <prefix>`：看某条 Claude 父 agent 的详细聊天记录。前缀唯一即可，通常 4 位够用。
- `duo watch`：多 pane 盯子 agent。父 agent 不进入这个视图。

## 边界

这个项目不是 `agent-room-cli`。

- `agent-room-cli`：人主导的共享房间，靠 @ 路由，一切以聊天记录为中心。
- `relay-cli`：父 agent 主导的本地进程编排。先选一个父 agent，由它负责主任务，并在每个有意义的动作节点主动拉子 agent 做局部审查、诊断或实现切片。

关键默认是：父 agent 对结果负责，并把子 agent 委派当成常规检查点。Alice 不需要像 room 工作流那样手动 @ 或路由另一个 agent。

## 当前 MVP

- 通过 `duo start --parent` 起一个选定父 agent
- 通过 `duo list` 查看活跃父 agent
- 通过 `duo show <prefix>` 读取 Claude 父 agent 聊天记录
- 通过 `duo watch` 旁观被 spawn 出来的子 agent
- 提示父 agent 在有意义的动作节点主动 duo 另一个 runtime，同时由父 agent 负责整合判断
- 首选 tmux 作为 PTY 后端
- 把项目级状态存在 `.duo/state.json` 里
- 把 `DUO_PROCESS_ID` / `DUO_RUNTIME` / `DUO_DEPTH` 注入 agent 进程
- MCP server 保留为已配置 agent 使用的隐藏管道

## 安全模型

- 最大 spawn 深度为 2
- 一个进程连续 30 分钟没有自身或子进程活动，下一次工具检查会触发 brake
- 累计 3 次工具调用失败会触发 brake

## 本地开发

```sh
npm install
npm run check
npm link
duo list
```

## 双机联调

这个仓库在 Mac mini 上编写，但设计上是跑在 MacBook 上的。mini 这边准备好一个辅助脚本来保持两台机器同步：

```sh
npm run install:macbook
```

真正跑 `duo` 的那台机器上，`codex` 和 `claude` 这两个 CLI 都得装好并完成登录。

## 状态

这是一个个人实验级的工具。能用，也在持续打磨，API 表面可能没有 deprecation notice 就直接变动。

## License

MIT，详见 [LICENSE](./LICENSE)。
