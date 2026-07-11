# Project And Global Scope

Agent Caller defaults every durable Agent to `scope=project`.

For this API, `project` means the Workspace path explicitly opened by the user.
Agent Caller canonicalizes that caller-supplied path, including resolving
symlinks, but never searches for a Git root. Git and non-Git Workspaces follow
the same rule.

Two paths opened separately are separate namespaces, even when one is nested
inside the other or both are in the same Git repository. Calls share Agents only
when they supply the same canonical Workspace path.

Every public Agent, Run, Request, and lifecycle operation requires the current
caller `cwd`. Agent Caller checks that context before resolving even a stable
Agent ID, Run ID, or Request ID. Different projects can safely use the same
Agent name.

Use `scope=global` only when the user explicitly wants a durable member shared
across Workspaces. Global Agents are not silently mixed into project listings;
list and address them with explicit global scope on every operation.

Caller CWD selects visibility. It does not move the Agent or change the
provider's persisted working directory. A global Agent still works in the CWD
chosen when it was created.

Scope also does not replace or filter provider configuration. Agents keep the
user's normal Claude Code or Codex settings, Skills, plugins, MCP servers, and
authentication. Trust profiles separately control file, command, and approval
authority.

Existing Agents created with missing or Git-derived scope metadata migrate to
Workspace-local project scope using their persisted CWD. Provider sessions and
history remain unchanged.

This is a logical product boundary against accidental cross-Workspace access. It
is not an OS security boundary: a caller that deliberately supplies another
Workspace path is claiming that Workspace context. Sandbox and approval profiles
remain responsible for resource containment.
