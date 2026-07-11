# Permissions And Requests

Resource scope and approval behavior are separate. The parent Codex task does
not automatically pass its sandbox or approval policy through MCP.

Project/global Agent scope is separate again: it controls which workspace can
see and address an Agent, not which provider configuration or tools the Agent
loads and not what files or commands it may use.

| Profile | Sandbox | Approval |
|---|---|---|
| `trusted` | `danger_full_access` | `autonomous` |
| `guarded` | `workspace_write` | `on_request` |
| `observer` | `read_only` | `fail_closed` |

`trusted` is the local personal-plugin default. Use `guarded` for supervised
writes and `observer` when no mutation is allowed. Low-level `sandbox` and
`approval` fields are advanced overrides.

The creation policy is a ceiling. Per-Run overrides can narrow resource scope or
make approvals stricter, but cannot escalate beyond the Agent policy.

## Provider Mapping

Claude Code combines allowed tools, permission mode, SDK callbacks, and its
command sandbox. Codex uses native App Server sandbox and approval policies.
These mechanisms preserve the public profile meaning but are not identical OS
security systems.

Trusted mode also injects a shared strict delegation prompt. It permits routine
local coding without approval chatter while forbidding unrelated scope, secret
handling, publishing, deployment, destructive Git operations, broad deletion,
and other high-impact effects unless explicitly authorized. This is a soft
behavioral contract, not a substitute for a sandbox.

## Interactive Requests

With `on_request`, supported command, file-change, permission, user-question,
and elicitation events pause the Run as `waiting_for_input`. The pending request
contains safe display data and available decisions; provider transport IDs stay
internal.

Use `respond_to_request` with the actual user decision or answers. Never infer
approval from general trust. If the process exits, pending callbacks expire and
are not replayed automatically.

Claude CLI fallback cannot provide interactive callbacks. Claude Agents using
`on_request` therefore require the Agent SDK and fail clearly when it is not
available.
