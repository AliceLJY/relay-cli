# relay-cli

`relay-cli` 是一个很小的本地控制层，用来让 Codex 和 Claude 这两个 CLI agent 互相协作，同时不把项目变成一个吵吵闹闹的聊天室。

装好之后命令名字故意取短：

```sh
duo status
duo start --parent codex "实现 relay-cli 的下一个小改进"
duo brake "方向跑偏了"
duo resume "新方向：保持在进程编排，不要做成聊天室"
duo mcp
duo watch
```

## 边界

这个项目不是 `agent-room-cli`。

- `agent-room-cli`：人主导的共享房间，靠 @ 路由，一切以聊天记录为中心。
- `relay-cli`：agent 主导的本地进程编排，操作者保留随时可按的刹车键。

## 当前 MVP

- 通过 `duo mcp` 跑一个 MCP server
- 把 Codex/Claude 的进程编排能力以工具形式暴露给 agent
- 首选 tmux 作为 PTY 后端
- 把项目级状态存在 `.duo/state.json` 里
- 给操作者几个明确的控制命令：`status`、`brake`、`resume`、`abort`
- 通过 `duo start --parent` 提供父子启动路径
- 通过 `duo pair` 提供一次性配对启动
- 通过 `duo watch` 提供人类旁观视角
- 把 `DUO_PROCESS_ID` / `DUO_RUNTIME` / `DUO_DEPTH` 作为真正的环境变量注入，让父子链条落在进程状态里，而不是只躺在 prompt 文字里

## MCP 工具

- `whoami`
- `list_runtimes`
- `spawn_agent`
- `send_input`
- `get_output`
- `get_status`
- `cancel_agent`
- `close_process`
- `need_human`

## 安全模型

默认是让 Codex/Claude 自治协作，但不是让它们自治地做不可逆操作。

- `duo brake` 冻结新的 spawn/send 动作，不杀掉当前 pane
- `duo resume` 解除刹车，同时可以回答一个挂起的 `need_human` 请求
- `need_human` 是阻塞的：发起调用的 agent 会一直等，直到操作者用 resume 给出方向
- 最大 spawn 深度为 2
- 一个进程连续 5 分钟没产生可观察输出，下一次状态检查或工具调用会触发 brake
- 累计 3 次工具调用失败会触发 brake

## 本地开发

```sh
npm install
npm run check
npm link
duo status
```

## 推荐启动方式

真正想做"委派"的场景，应该只起一个 parent，让它自己判断要不要把另一个 runtime 拉进来：

```sh
duo start --parent codex "实现 relay-cli 的下一个小改动"
duo start --parent claude "审视当前 relay-cli 的交接设计"
```

这样只会生成一个 root 进程，并把终端接到那个 tmux session；第二个 runtime 只有在 parent 明确通过 duo MCP 主动召唤时才会进场。

## 快速配对启动

如果确实想要并排 fan-out，而不是父子委派：

```sh
duo pair "实现 relay-cli 的下一个小改动"
```

这会从同一段任务文本生成一个 `codex` 进程和一个 `claude` 进程，然后默认进入 `duo watch`。这属于并行扇出，**不是**父子流。只想做启动这一步的话加 `--no-watch`。

## 双机联调

这个仓库在 Mac mini 上编写，但设计上是跑在 MacBook 上的。mini 这边准备好一个辅助脚本来保持两台机器同步：

```sh
npm run install:macbook
```

脚本会把源码同步到 `mac:~/Projects/relay-cli`，用 `npm ci` 装依赖，跑 check，link `duo`，为 Codex 注册 `duo` 这个 MCP server，并确保 Claude 的项目级 `.mcp.json` 存在。

真正跑 `duo` 的那台机器上，`codex` 和 `claude` 这两个 CLI 都得装好并完成登录。

要把这个控制层暴露给某个 agent，把它的 MCP server 配置指向：

```sh
duo mcp
```

仓库里带了一份项目级的 [`.mcp.json`](./.mcp.json)，所以 Claude Code 在这个项目里就能直接发现 `duo` MCP server。

完整的操作流程看 [docs/macbook-start-playbook.md](./docs/macbook-start-playbook.md)（英文）。

## 状态

这是一个个人实验级的工具。能用，也在持续打磨，API 表面可能没有 deprecation notice 就直接变动。更适合当参考或起点，不适合当稳定依赖。
