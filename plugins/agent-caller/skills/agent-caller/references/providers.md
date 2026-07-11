# Provider Notes

## Claude Code

Claude Code uses the Claude Agent SDK when available. The SDK preserves a
recoverable session, supports provider tools, interactive permission callbacks,
questions, and the user's Claude Code configuration. A CLI fallback is
available for compatible non-interactive work.

The live model catalog can include configured aliases and models exposed by an
Anthropic-compatible endpoint. Agent Caller reads those provider choices; it
does not persist API keys or expose them in status and history.

## Codex

Codex uses App Server v2 for durable threads, turns, native tools, approvals,
questions, model catalogs, and reasoning effort. It inherits the user's normal
Codex home, configuration, Skills, plugins, MCP servers, authentication, and
native session store. Agent Caller project scope controls durable Agent
visibility; it does not create a separate Codex configuration environment.

App Server `model/list` is an advertised catalog, not a complete proof of every
configured model a newer CLI may accept. A configured but unlisted model is
shown with `advertised=false`, while the advertised default is recommended. An
explicit request for the unadvertised model is passed through and any backend
rejection is surfaced directly.

## Shared Rules

Provider session and thread identifiers are recovery handles owned by Agent
Caller. Address members only by Agent Caller ID or unique name and never paste
provider identifiers into prompts.

For owner diagnostics, a completed or idle Codex conversation can be opened in
the terminal with `codex resume <thread-id>`. The thread ID is stored in the
Agent's local `agent.json` under `providerState.threadId`; Claude uses
`claude --resume <session-id>`. Do not open the native session while an Agent
Run is active. Manual native turns will exist in provider history but are not
mirrored into Agent Caller `messages.jsonl`.

Both providers own their context-window behavior. When supported, provider
conversation compaction occurs inside the continuing provider session. Agent
Caller preserves its own durable message, Run, request, and output records
independently.
