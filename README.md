# Agent Caller

让 Codex 调用并管理可持续协作的 Claude Code 与 Codex 子 Agent。

Agent Caller 不是一次性执行 `claude -p` 或 `codex exec` 的命令包装。它为
Codex 提供一组原生 MCP 工具，用来创建有名字、有角色、有独立上下文的团队成员，
并在多轮对话、进程退出和 Codex 重启后继续使用同一个 Agent。

## 能做什么

- 同时创建 Claude Code 和 Codex Agent，并为每个成员定义角色。
- 与同一个 Agent 持续多轮对话，保留原生 Claude Session 或 Codex Thread。
- 并行分配任务，查看状态、最近输出、历史和待处理请求。
- 停止当前 Run、释放空闲 Agent，并在之后恢复，而不丢失上下文。
- 从 Provider 的实时配置中发现模型与思考强度。
- 在 `trusted`、`guarded` 和 `observer` 三种权限档位之间选择。
- 默认按照当前打开的 Workspace 隔离 Agent，显式使用 `global` 才跨 Workspace。

## 安装

要求：

- Node.js 22 或更高版本，以及 npm；
- 支持 Plugin 和 App Server 的 Codex CLI/App；
- 使用 Claude Code Provider 时，需要本机已安装并配置 Claude Code。

添加 Marketplace 并安装插件：

```bash
codex plugin marketplace add Johnny-xuan/Agent-Caller
codex plugin add agent-caller@agent-caller
```

安装完成后新建一个 Codex 任务，让 Codex 加载新的 Skill 和 MCP 工具。
插件首次启动会通过 npm 安装 Claude Agent SDK 的 JavaScript 运行依赖，不会下载
SDK 自带的可选 Claude 二进制；Claude Provider 使用用户本机的 `claude` 命令。

## 开始使用

可以直接对 Codex 说：

```text
查看当前 Claude Code 和 Codex 可以使用的模型，询问我选择哪个模型和思考强度，
然后创建 architect 和 reviewer 两个 Agent 来分析这个项目。
```

也可以继续已有成员：

```text
列出这个 Workspace 里的 Agent，恢复 architect，然后追问它上一轮方案里的风险。
```

第一次在当前 Codex 任务中使用某个 Provider 时，Agent Caller 会先读取实时模型
列表，并让你确认模型和思考强度。选择会在当前任务和 Workspace 中复用。

## Workspace 与 Global

`scope=project` 是默认值；这里的 `project` 指用户实际打开的 Workspace 路径，
与是否存在 Git 仓库无关。

- 同一个 Workspace 中的不同 Codex 任务可以看到并继续使用相同 Agent。
- 另一个 Workspace 默认看不到这些 Agent。
- 分别打开的父目录和子目录是两个 Workspace。
- `scope=global` 必须显式指定，适合真正需要跨 Workspace 共享的成员。

Workspace Scope 只控制 Agent 的可见性。Claude Code 与 Codex 仍然使用用户原有的
配置、认证、Skills、插件和 MCP Server。

## 权限档位

| Profile | Sandbox | Approval | 适用场景 |
|---|---|---|---|
| `trusted` | Full access | Autonomous | 日常本地开发，默认值 |
| `guarded` | Workspace write | On request | 允许写入，但关键操作需要确认 |
| `observer` | Read only | Fail closed | 只读探索、Review 和分析 |

`trusted` 会减少频繁审批，但仍通过强约束 Prompt 限定任务边界。Prompt 不是安全
边界；需要技术隔离时应使用 `guarded` 或 `observer`。

## MCP 工具

插件提供 11 个工具：

| 类别 | 工具 |
|---|---|
| 创建与沟通 | `create_agent`, `send_message`, `respond_to_request` |
| 查看 | `get_agent`, `get_history`, `list_agents`, `list_models` |
| 生命周期 | `release_agent`, `stop_run`, `resume_agent`, `delete_agent` |

Agent 默认状态保存在 `~/.codex/agent-caller`。可以通过
`AGENT_CALLER_DATA_DIR` 指定其他位置。

## 更新

```bash
codex plugin marketplace upgrade agent-caller
codex plugin add agent-caller@agent-caller
```

更新后新建一个 Codex 任务以加载新版本。
