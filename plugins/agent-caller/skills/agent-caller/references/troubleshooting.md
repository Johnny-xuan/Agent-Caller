# Troubleshooting

Run `npm run doctor` from the plugin directory to check source paths, provider
availability, and persisted state. Run `npm test` for the complete regression
suite.

## Common Cases

- Model unavailable: call `list_models` again for the exact provider and `cwd`,
  then choose one of its reported IDs and effort values.
- Agent is `waiting_for_input`: inspect `pendingRequests` with `get_agent`, then
  answer through `respond_to_request`.
- Agent is `inactive` or `stopped`: call `resume_agent` before the next message.
- Agent appears busy after a restart: inspect the latest Run; interrupted work
  is never automatically replayed.
- Agent is running with empty output: continue waiting. Providers may complete
  many internal tool calls before producing their first user-facing text; blank
  output alone is not evidence that the Run is stuck.
- Claude guarded mode fails immediately: verify the Claude Agent SDK is
  available because CLI fallback cannot round-trip interactive requests.
- Plugin was reinstalled but the old surface remains visible: start a new host
  session (a new Codex task or Claude Code session) so the host loads the new
  plugin cache and Skill metadata.
- Expected Agent is missing: verify the caller `cwd` and scope. Project Agents
  appear only for the exact canonical Workspace path the user opened; Git roots
  are not inferred. Global Agents require explicit `scope=global`.
- Codex configured model is marked unadvertised: it is absent from App Server
  `model/list`, not permanently unsupported. Recommend the advertised selected
  model for this runtime; try the configured model only when explicitly
  requested and report its real backend error.
- Native resume: read `providerState.threadId` or `providerState.sessionId` from
  the Agent's local `agent.json`, then use `codex resume` or `claude --resume`.
  Never do this while the Agent has an active Run.

Runtime state defaults to `~/.codex/agent-caller`. Set
`AGENT_CALLER_DATA_DIR` to isolate development or test state.
