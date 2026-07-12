# Claude Code Host

Agent Caller is host-neutral. The same plugin directory, the same MCP server,
the same durable state, and the same eleven tools run whether Codex or Claude
Code is the host session. This reference records exactly how Claude Code loads
Agent Caller, why the plugin directory is shared, and the boundaries that follow.

## How Claude Code Loads Agent Caller

Claude Code uses its official plugin system. The repository ships two Claude
Code manifests:

- `/.claude-plugin/marketplace.json` — the marketplace, registered with
  `claude plugin marketplace add <repo-root>`. It advertises one plugin,
  `agent-caller`, whose `source` is `./plugins/agent-caller`.
- `/plugins/agent-caller/.claude-plugin/plugin.json` — the plugin manifest. Its
  `name` is `agent-caller`; `skills/` is auto-discovered; and `mcpServers`
  points at `./.mcp.claude.json`.

The MCP server is a normal stdio process. `.mcp.claude.json` launches it the
way Claude Code requires:

```json
{
  "mcpServers": {
    "agent-caller": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/start.mjs"],
      "cwd": "${CLAUDE_PLUGIN_ROOT}"
    }
  }
}
```

`${CLAUDE_PLUGIN_ROOT}` is expanded by Claude Code to the installed plugin
directory and is also exported to the server process. `scripts/start.mjs`
resolves its own plugin root from `import.meta.url`, installs the locked runtime
dependencies on first start, and imports `src/mcp/server.mjs`. No Codex code is
duplicated: the Claude Code host and the Codex host call the same entrypoint.

Install and verify:

```bash
claude plugin marketplace add "$PWD"
claude plugin install agent-caller@agent-caller
claude mcp list              # plugin:agent-caller:agent-caller -> Connected
```

Plugins and their MCP servers load when a session starts. Run `/reload-plugins`
inside an open session, or start a new Claude Code session, after installing.

## Why Two MCP Configs Coexist

Codex and Claude Code resolve MCP server paths differently, so the plugin keeps
one config per host and one shared runtime:

| File | Host | Entrypoint | Path basis |
|---|---|---|---|
| `.mcp.json` | Codex | `node ./scripts/start.mjs`, `cwd: "."` | plugin-root relative |
| `.mcp.claude.json` | Claude Code | `node ${CLAUDE_PLUGIN_ROOT}/scripts/start.mjs` | `${CLAUDE_PLUGIN_ROOT}` |

Each host manifest references its own file (`.codex-plugin/plugin.json` →
`.mcp.json`; `.claude-plugin/plugin.json` → `.mcp.claude.json`). Claude Code
loads only the file its manifest names; it does not also auto-discover
`.mcp.json`, so the two never collide. Both files point at the same
`scripts/start.mjs`, so there is exactly one Agent Caller runtime.

A separate, benign mechanism: Claude Code also scans the current working
directory for a project-level `.mcp.json`. If you launch Claude Code from inside
the plugin directory, it will notice `plugins/agent-caller/.mcp.json` and list
it as a pending project server (named `agent-caller`, awaiting approval). That is
unrelated to plugin loading and never connects unless you approve it; from your
own project directory only the plugin server `plugin:agent-caller:agent-caller`
loads.

A single plugin directory therefore carries both hosts at once:
`.codex-plugin/`, `.claude-plugin/`, `.mcp.json`, `.mcp.claude.json`, `skills/`,
`src/`, and `scripts/`. Claude Code ignores `.codex-plugin/` and the Codex MCP
config; Codex ignores `.claude-plugin/` and the Claude MCP config.

## Shared State And Workspace Isolation

The Claude Code host and the Codex host share one durable store. The default
data root is `~/.codex/agent-caller` for both hosts; set `AGENT_CALLER_DATA_DIR`
to override it. This path name is historical, not a Codex-only store — changing
it would break existing agents, so it is preserved.

Scope is workspace-canonical, not host-specific:

- A project-scoped agent created from a Claude Code session opened on workspace
  `/work/a` is visible to a Codex session opened on the same canonical path
  `/work/a`, and vice versa.
- A different workspace `/work/b` does not see that agent by default.
- `scope=global` is the only cross-workspace escape hatch and must be explicit
  on every call.

There is no host tag on an agent. The same agent can be created from one host
and continued from the other, because both hosts read and write the same
`agents/`, `messages.jsonl`, runs, and request files through the same service.

## Coordination From A Claude Code Host

The shared skill `skills/agent-caller/SKILL.md` is auto-discovered by both
hosts and carries the coordination rules. When Claude Code is the host, the
model must use the eleven MCP tools and must not shell out to `claude -p`,
`codex exec`, or provider SDKs directly. In particular:

1. Before first use of each provider in the session, call `list_models`.
2. Unless the user named both model and effort, show the live default and a few
   alternatives, then wait for a choice.
3. Pass the workspace `cwd` the user actually opened on every scoped call.
4. Default to `scope=project`; use `global` only for deliberate cross-workspace
   sharing.
5. Continue a multi-turn conversation against the same stable name or agent ID.
6. Default ordinary delegation to `trusted`, including web research and review.
   Use `guarded` or `observer` only for explicit containment or after an
   explicit authority decision for high-impact work. Claude `observer` is a
   reduced local-inspection mode and does not expose configured Web MCP tools.
7. Creation sets the default profile; `send_message.profile` may select another
   profile for one run without replacing the durable agent or its conversation.
8. On `waiting_for_input`, read the real pending request and relay the user's
   decision through `respond_to_request`. Never fabricate an approval.
9. Prefer `get_agent` for progress; use `get_history` only for transcripts.
10. Run independent work on separate agents; one agent takes one mutating run.
11. `release_agent` and `stop_run` preserve the agent; only `delete_agent`
    removes it.
12. Do not set a default `maxTurns`.
13. A Claude Code host may create a `claude-code` provider agent. That agent is
    an independent process, session, and context — not the host session itself.
14. Sub-agent output is evidence; the host Claude Code synthesizes, verifies,
    and decides.
15. A running Agent may expose no partial text before its final result. Do not
    stop it solely because intermediate output is blank.

## Boundaries

- Agent Caller never reads or removes the user's Claude Code or Codex
  configuration, skills, plugins, MCP servers, or credentials. A Claude Code
  provider agent inherits the user's normal Claude Code settings through the
  Claude Agent SDK.
- Plugins do not hot-load into a running session. Start a new Claude Code
  session (or run `/reload-plugins`) after install or update.
- The Claude Code host and a Claude Code provider agent are distinct processes.
  Nesting is real delegation, not recursion into the host's own context.
- This plugin targets the current Claude Code plugin specification
  (`.claude-plugin/` manifests, `${CLAUDE_PLUGIN_ROOT}`). Earlier, deprecated
  plugin conventions are not used.
