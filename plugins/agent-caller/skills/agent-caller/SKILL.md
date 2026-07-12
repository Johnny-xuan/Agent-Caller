---
name: agent-caller
description: Create and coordinate durable sub-agents backed by Claude Code or Codex. Use when a Claude Code or Codex host should delegate work to an independent agent, assemble named team roles, ask another model for an opinion, run agents in parallel, continue a multi-turn agent conversation, inspect prior agent output, release an idle agent, stop active work, or restore a previously released or interrupted agent.
---

# Agent Caller

Use Agent Caller's MCP tools as a durable, recoverable sub-agent system. Do not
invoke `claude`, `codex exec`, or provider SDKs directly.

## First Provider Use

Before the first delegation to each provider in the current host session:

1. Call `list_models` with the provider and target `cwd`.
2. Unless the user already specified both values, show the provider default as
   the recommendation, offer a short set of useful alternatives, and ask which
   model and effort to use. Wait for the answer.
3. Reuse that choice for the same provider and `cwd` in this task. Ask again
   only when provider or `cwd` changes, the user requests a switch, or the model
   disappears from the live catalog.

The MCP server cannot enforce this because MCP does not expose the parent host
session identity. See [models-and-effort.md](references/models-and-effort.md) for
selection and override details.

## Coordinate A Team

1. Pass the current project `cwd` on every scoped tool call. Call `list_agents`
   with that `cwd` when earlier durable members may be relevant.
2. Create one agent per genuinely independent role with a stable name, provider,
   role, `cwd`, selected model, and effort.
3. Use `claude-code` for a requested or useful independent Claude perspective;
   use `codex` for another Codex coding agent.
4. Omit `profile` or use `profile=trusted` for ordinary delegation, including
   implementation, review, adversarial analysis, tests, web research, and other
   configured Provider tools. Do not infer a narrower profile merely because a
   task is informational or does not intend to modify files.
5. Use `guarded` or `observer` only when the user explicitly requests stricter
   containment, or after making the authority choice explicit for production,
   publishing, secrets, broad deletion, destructive Git, or other high-impact
   work. `observer` is a deliberately reduced local inspection mode on Claude,
   not a general-purpose research profile.
6. Express review, rescue, adversarial analysis, implementation, or research in
   the role and message. They are behaviors, not separate engines.

Default to `scope=project`. It isolates names, visibility, messages, Runs,
requests, and lifecycle actions by the canonical path of the Workspace the user
opened; Git roots are never inferred. Use `scope=global` only when the user
explicitly wants a member shared across Workspaces, and keep passing global
scope on later operations. An Agent's working directory never changes merely
because it is called from another Workspace. See [scopes.md](references/scopes.md).

Scope does not disable provider configuration or capabilities. Claude Code and
Codex Agents keep the user's normal Skills, plugins, MCP servers, authentication,
and provider settings.

Use `send_message(wait=true)` for a foreground turn and `wait=false` for
parallel work. Continue multi-turn discussion by messaging the same agent ID or
unique name. Agents have private context, so relay conclusions deliberately.

Inspect current or latest work with `get_agent`; use `get_history` only when the
recent transcript or Run records are needed. Treat sub-agent output as evidence
for the host to judge and verify, not as the final authority.

A `running` Run may have empty output until the Provider produces its final
reply. Do not treat blank intermediate output as a stalled Agent and do not stop
it solely for that reason. Continue waiting for the result unless the user asks
to stop, the Provider reports an error, or the owning process is no longer live.

See [tools.md](references/tools.md) for the exact eleven-tool surface and
[lifecycle.md](references/lifecycle.md) for concurrency, release, stop, resume,
and recovery behavior.

## Requests And Authority

An Agent's creation profile is its default. Set `send_message.profile` when one
Run needs a different authority mode; omitting it later returns to the Agent
default without losing provider context. A running Run keeps the policy it
started with. The parent host sandbox is not inherited over MCP.

When a Run is `waiting_for_input`, inspect `pendingRequests` and call
`respond_to_request` with the user's real decision or answers. Never invent an
approval. Continue until the Run completes, asks again, or is stopped.

Trusted agents operate autonomously for routine local development, while a
shared strict prompt limits unrelated scope and high-impact actions. That prompt
is not a security boundary; use `guarded` or `observer` when hard containment is
needed. See [permissions.md](references/permissions.md).

## Lifecycle Rules

- Release an idle agent to preserve it for later; resume before messaging an
  inactive or stopped agent.
- Stop only active work. A stopped provider turn may remain unfinished in its
  recoverable context.
- Delete only when the user explicitly wants the durable identity and local
  history permanently removed.
- Never paste provider session or thread IDs into prompts. Agent Caller owns
  recovery handles internally.

For provider behavior and diagnostics, consult
[providers.md](references/providers.md) and
[troubleshooting.md](references/troubleshooting.md) only when needed.
