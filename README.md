<p align="center">
  <img src="./plugins/agent-caller/assets/agent-caller-logo.png" width="144" alt="Agent Caller icon">
</p>

<h1 align="center">Agent Caller</h1>

<p align="center">让 Codex 调用并管理可持续协作的 Claude Code 与 Codex 子 Agent。</p>

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

## 交给 Coding Agent 安装（推荐）

把下面整段 Prompt 发给 Claude Code、Codex 或其他能够执行终端命令的 Coding
Agent。它会负责下载、安装、验证，并在完成后告诉你如何开始使用，而不是只把命令
重新念一遍。

```text
请帮我把 Agent Caller 安装到本机 Codex，并在安装完成后指导我使用。

项目地址：https://github.com/Johnny-xuan/Agent-Caller
目标插件：agent-caller@agent-caller

请实际执行安装和验证，不要只向我复述命令。按照下面流程进行：

1. 检查 `codex --version`、`node --version` 和 `npm --version`。Agent Caller 需要
   Node.js 22 或更高版本，以及支持 `codex plugin` 和 App Server 的 Codex。
   如果当前 Codex 不支持这些命令，先解释需要升级；在修改我的 Codex 安装前询问我。

2. 检查本机是否安装了 `claude`。没有 Claude Code 时仍可使用 Codex Provider，
   但要明确告诉我 Claude Provider 暂时不可用，不要因此阻止整个插件安装。

3. 下载并注册 Git Marketplace：
   - 如果还没有名为 `agent-caller` 的 Marketplace，执行
     `codex plugin marketplace add Johnny-xuan/Agent-Caller --ref main`。
   - 如果已经存在，执行 `codex plugin marketplace upgrade agent-caller`。
   - 不要删除或覆盖其他 Marketplace、插件或用户配置。

4. 执行 `codex plugin add agent-caller@agent-caller` 安装插件。

5. 执行 `codex plugin list` 验证结果。确认 `agent-caller@agent-caller` 显示为
   installed 且 enabled；如果失败，请读取真实错误、排查并重试一次，不要在没有
   验证的情况下声称安装成功。

6. 说明新安装的 Plugin 和 MCP 工具不会热加载到当前 Codex 对话。安装成功后，
   明确让我新建一个 Codex 任务。如果你当前是 Claude Code 或其他 Coding Agent，
   也要说明这个插件最终是在 Codex 中使用，而不是安装进当前 Agent 自己。

7. 安装结束后，用简短中文告诉我：
   - Agent Caller 能创建 Claude Code 或 Codex 驱动的持久 Agent；
   - 同一个 Agent 可以多轮对话、停止、释放和恢复；
   - 默认 `scope=project` 按我实际打开的 Workspace 路径隔离，跨 Workspace 只有
     显式 `global`；
   - `trusted` 适合日常自主开发，`guarded` 会请求审批，`observer` 只读；
   - 第一次使用某个 Provider 时应该先调用 `list_models`，让我选择模型和思考强度。

8. 最后给我下面三个可以在新 Codex 任务里直接说的示例：
   - 查看 Claude Code 和 Codex 的可用模型，询问我选择模型与思考强度，然后创建
     architect 和 reviewer 两个 Agent 分析当前项目。
   - 列出当前 Workspace 的 Agent，查看 architect 的最新状态和输出。
   - 恢复 reviewer，继续追问上一轮 Review 中最严重的问题。

完成后报告实际执行结果、安装到的插件版本，以及我下一步需要打开的新 Codex 任务。
```

Marketplace 注册本身就会从 GitHub 下载插件，不需要先手动 `git clone`。

## 手动安装

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
