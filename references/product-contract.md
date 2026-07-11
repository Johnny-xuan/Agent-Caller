# Agent Caller Product Contract

## Product Definition

Agent Caller gives Codex a durable external sub-agent system.

Codex can create independent agents backed by Claude Code or Codex, assign each
agent a role, send messages over multiple turns, inspect its output history,
stop current work, and later restore the same agent with its prior context.

The product is not a collection of review or rescue commands. Review, rescue,
implementation, research, and adversarial analysis are roles or instructions
given to an agent through ordinary messages.

## Mental Model

An agent is a durable identity. A run is one period of active work. A message is
one turn in the agent's conversation.

- Agent: owns a provider, role, working directory, provider session, and message
  history.
- Run: starts when Codex sends work to an agent and ends when the agent replies,
  fails, or is stopped.
- Message: a user or agent turn recorded under the durable agent.
- Provider process: an implementation detail that may exit without deleting the
  agent.

Stopping a run must never delete the agent. Deleting an agent is the only action
that intentionally removes its recoverable state.

## User Experience

Codex acts as the team lead. It can:

1. Create a named agent, choose `claude-code` or `codex` as its provider, and
   optionally select a trust profile.
2. Give the agent a stable role and an initial request.
3. Read the reply and the recorded output for that run.
4. Send another message to the same agent and continue the same provider
   conversation.
5. Create other agents with different roles and coordinate their conclusions.
6. Release an idle agent without losing its identity or provider conversation.
7. Stop an active run without deleting the agent or its unfinished context.
8. Restore an inactive or stopped agent and continue its provider conversation.
9. Delete an agent only when its durable identity is no longer wanted.
10. See when an agent is waiting for permission or an answer, inspect the exact
    request, and respond without losing the active Run.

## Workspace And Global Scope

Every Agent belongs to one durable namespace:

- `project`: the default. The Agent is visible and addressable only from its
  opened Workspace namespace.
- `global`: explicit. The Agent can be deliberately addressed from any Workspace
  when the caller also selects global scope.

Workspace identity is the canonical caller-supplied Workspace path. Git metadata
does not affect it. Two paths opened separately are separate Workspaces even
when one is nested inside the other or both belong to one repository. Agent
names are unique inside their Workspace, so different Workspaces may use the
same role names.

Every public Agent, Run, and Request operation carries the caller CWD and scope.
An Agent ID or Run ID does not bypass this check. The caller CWD selects the
namespace; it never changes the Agent's persisted provider working directory.

Existing Agents without current Workspace metadata migrate to project scope
using their persisted CWD. Scope is logical protection against accidental
cross-Workspace access, not an OS boundary against a caller that deliberately
supplies another Workspace path.

## Product Actions

The public capability surface is intentionally small:

- `create_agent`: create a durable agent identity with a provider and role.
- `send_message`: send one new turn to an existing agent.
- `get_agent`: inspect identity, status, current run, and recent output.
- `get_history`: read recorded conversation and run output.
- `list_agents`: list the team and each member's status.
- `list_models`: query provider-configured models and supported effort levels.
- `release_agent`: release an idle member while preserving its recoverable state.
- `stop_run`: stop current work while preserving the agent.
- `resume_agent`: make a persisted agent available again.
- `delete_agent`: intentionally remove the agent and local state.
- `respond_to_request`: approve, deny, cancel, or answer a request raised by an
  active agent.

Provider-specific session identifiers remain internal to the public MCP tools.
Codex addresses agents by the stable Agent Caller ID or an unambiguous name.
The owner may open a persisted provider conversation directly for diagnostics:
Claude Code accepts `claude --resume <session-id>` and Codex accepts
`codex resume <thread-id>`. The IDs live in the Agent's local `agent.json`.
Manual provider turns are not copied into Agent Caller message history, and a
native session must not be opened concurrently with an active Agent Run.

## Model And Effort

Model selection is provider-owned and may depend on the project directory and
user configuration. Agent Caller queries the live Claude Code SDK or Codex App
Server catalog rather than maintaining a static list. Claude catalogs may
include aliases and models supplied by an Anthropic-compatible endpoint.

Catalog entries expose the provider model ID, resolved model when available,
default selection, and supported effort strings. Agent Caller does not translate
effort names across providers or claim that compatible endpoints implement an
advertised effort identically.

A Codex model explicitly selected by user configuration remains visible when it
is absent from App Server `model/list`. Catalog omission means unadvertised, not
permanently unsupported, but it is not the recommended default for the current
runtime. Agent Caller recommends an advertised model and passes an unadvertised
model through only when the caller explicitly selects it, so the provider can
return its real compatibility error.

`model` and `effort` supplied at Agent creation are durable defaults. A
`send_message` Run may override either value without changing the Agent default.
Every Run records its effective model and effort for status and history.

On the first delegation to a provider in each parent Codex task, the coordinator
queries `list_models` and asks the user to choose model and effort unless both
were already explicit in the current request. That choice is reused for the
same provider in the task. A provider or project-directory change, an explicit
switch request, or a catalog mismatch requires a fresh choice. This is a Skill
contract because standard MCP does not expose the parent task identity to the
server.

## Lifecycle

Agent status:

```text
ready <-> running <-> waiting_for_input
  |         |                |
  v         v                v
inactive <- stopped <---------
  |
  v
deleted
```

- `ready`: persisted and available for a new message.
- `running`: currently handling one message.
- `waiting_for_input`: the same active Run is paused for a coordinator decision
  or answer; it has not completed or failed.
- `stopped`: the latest run was interrupted; the agent remains recoverable.
- `inactive`: the agent was released or recovered after a service restart; it
  remains recoverable.
- `deleted`: local identity and recovery metadata were intentionally removed.

Only one run may mutate a single agent conversation at a time. Different agents
may run concurrently.

## Sandbox And Approval

Resource scope and approval behavior are separate and explicit. They are not
implicitly inherited from the parent Codex task because standard MCP calls do
not carry the parent's sandbox or approval context.

The personal local plugin exposes three named profiles:

| Profile | Sandbox | Approval | Intended use |
|---|---|---|---|
| `trusted` | `danger_full_access` | `autonomous` | Normal local coding by a trusted durable teammate |
| `guarded` | `workspace_write` | `on_request` | Writable work whose provider operations should be supervised |
| `observer` | `read_only` | `fail_closed` | Review and analysis without modification |

New agents default to `trusted` when no profile or low-level policy is supplied.
This is a deliberate usability choice for the owner's local environment. Calls
that explicitly use the older `sandbox` or `approval` parameters keep their
original low-level semantics, and persisted agents are classified from their
existing policy rather than silently upgraded.

Sandbox scope:

- `read_only`: the provider may inspect but not mutate the project.
- `workspace_write`: the provider may write inside the configured workspace but
  not receive unrestricted host access.
- `danger_full_access`: the provider is not contained by a workspace sandbox;
  this is always an explicit choice.

Approval behavior:

- `fail_closed`: operations that require approval are denied instead of asking.
- `on_request`: the Run pauses and exposes a durable request to Codex.
- `autonomous`: the provider proceeds without asking, while the selected sandbox
  remains the maximum resource boundary.

When low-level policy is used without a profile, read-only agents default to
`fail_closed` and writable agents default to `on_request`, preserving the
original API behavior. Low-level overrides of a named profile are reported as
`custom` when the resulting pair no longer matches a named profile.

An Agent's creation policy is its maximum authority. A message may temporarily
use a narrower sandbox or stricter approval behavior, but it cannot escalate
beyond the Agent policy. Broader authority requires a separately authorized
Agent rather than a hidden per-message upgrade.

Provider-native implementations may differ, but the public meaning must stay
stable. Codex sandbox modes enforce resource scope directly. Claude Code uses
tool restrictions, permission mode, and its command sandbox together. A public
policy must not claim stronger isolation than its provider can enforce.

## Interactive Requests

A Request belongs to one active Run and has a durable Agent Caller ID. It may
represent a command approval, file-change approval, additional permission,
provider question, or supported elicitation.

```text
running -> waiting_for_input -> running -> completed
                         |          |
                         +-> denied-+
                         +-> stopped
```

`send_message(wait=true)` returns when the Run completes or first needs input;
it never hides an approval prompt behind a blocked MCP call. The coordinator
answers through `respond_to_request`, which may wait for completion or return
again if the provider raises another request.

Pending requests include safe display data such as the tool, command, path,
reason, questions, options, and available decisions. Provider transport IDs and
secrets remain internal.

If Agent Caller exits while a request is pending, that request becomes expired.
It must not appear answerable after its provider callback has disappeared, and
the interrupted write operation is not replayed automatically.

## Persistence Promise

Every accepted message receives a run ID before provider work begins. Agent,
run, message, output, and provider-session metadata are persisted independently
of the provider process.

After a crash or restart:

- completed replies remain readable;
- interrupted runs are marked as interrupted rather than silently lost;
- pending requests whose provider process disappeared are marked expired;
- the agent remains resumable when the provider session still exists;
- a new message continues the same provider conversation;
- no write task is automatically replayed.

A stopped provider turn may still be unfinished in the provider's own session.
Restoring that agent resumes its existing context and may continue the
unfinished turn. Releasing an idle agent is the normal way to put a completed
team member away and later continue with a new message.

## Provider Contract

Both `claude-code` and `codex` providers implement the same behavior:

1. Start a provider conversation for a new agent.
2. Send a message and capture output plus a recoverable session identifier.
3. Continue an existing provider conversation.
4. Stop current execution without deleting provider conversation metadata.
5. Report partial output and errors without erasing previous history.

Provider differences may be exposed as capabilities, but they must not change
the meaning of Agent Caller lifecycle actions.

Both providers run with the user's normal provider environment. Claude Code and
Codex configuration, Skills, plugins, MCP servers, authentication, and native
session storage remain available. Project or global scope changes Agent
visibility and addressing only; sandbox and approval profiles independently
control what an Agent may do.

There is no default turn limit. A provider runs until it replies, is stopped, or
returns an error. Any explicit provider limit is opt-in for that run.

## Roles And Teams

Roles are durable instructions attached to an agent. They may describe an
architect, implementer, reviewer, debugger, researcher, or any user-defined team
member. A role does not create a separate execution path.

Codex coordinates agents by sending messages. Agents do not silently share
private context; Codex deliberately relays conclusions or artifacts when another
agent needs them.

## Safety And Visibility

- Provider and role are visible on every agent.
- Scope and project root are visible on every agent.
- Profile, sandbox, and approval behavior are visible on every agent.
- Each run records timestamps, status, output, and errors.
- Trusted agents receive a shared provider-neutral delegation prompt that keeps
  work inside the assigned task, protects unrelated files and secrets, and
  requires explicit authorization for publishing, deployment, destructive Git
  operations, broad deletion, and other externally visible or irreversible
  effects.
- That prompt is a behavioral contract rather than a security boundary. Use
  `guarded` or `observer` when technical containment is required.
- Interactive approvals are recorded with their resolution; secrets entered as
  answers are not copied into summaries or logs.
- Stopping and deleting are separate actions.
- Secrets from provider configuration are never written into history or status
  output.
- Automatic fallback must not replay a run that may already have changed files.

## Non-Goals

- Importing an entire Codex or Claude transcript into another provider.
- Creating separate review, rescue, or adversarial execution engines.
- Replacing Codex as the final coordinator and decision maker.
- Requiring a continuously running provider process to preserve an agent.
- Hiding provider identity or pretending different providers have identical
  tool capabilities.

## Acceptance Scenario

The product is aligned when this flow works end to end:

1. Codex creates `architect` backed by Claude Code and `implementer` backed by
   Codex.
2. Codex sends both agents different role-appropriate requests.
3. Both replies and run records are visible.
4. Codex asks `architect` a follow-up and the agent remembers its first turn.
5. Codex releases `architect` after a completed reply, restores it, and sends a
   new follow-up in the same provider conversation.
6. Codex stops `implementer` during active work.
7. The process exits but `implementer` remains listed with its unfinished run.
8. After restarting Agent Caller, Codex restores `implementer` and continues the
   same provider conversation.
9. Deleting one agent does not affect the other agent or its history.
