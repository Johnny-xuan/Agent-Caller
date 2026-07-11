# Tool Reference

Agent references accept either a stable Agent Caller ID or a name unique inside
the selected scope. Every scoped operation requires the caller's current `cwd`;
`scope` defaults to `project` and must be explicitly set to `global` for global
Agents. All schemas reject unknown fields.

## Create And Communicate

`create_agent`

- Required: `name`, `provider` (`claude-code` or `codex`), `role`, `cwd`.
- Optional: `scope` (`project` by default or explicit `global`), `profile`
  (`trusted`, `guarded`, `observer`), `sandbox`, `approval`, `model`, `effort`,
  `runtime` (`auto`, `sdk`, `cli`), `skip_git_check`.
- `model` and `effort` become persistent Agent defaults.
- Scope controls Agent visibility only. Provider configuration, Skills, plugins,
  MCP servers, and authentication remain available.

`send_message`

- Required: `agent`, `message`, caller `cwd`.
- Optional: `scope` (`project` by default).
- Optional: narrower `sandbox`, stricter `approval`, Run-only `model` and
  `effort`, and `wait` (default `true`).
- Returns the Agent, Run, any pending requests, and whether the call waited.

`respond_to_request`

- Required: `request_id`, caller `cwd`.
- Optional: `scope` (`project` by default).
- Optional: `decision` (`allow_once`, `allow_session`, `deny`, `cancel`),
  `answers`, provider `response`, and `wait` (default `true`).
- Use the options advertised by the pending request. A response may complete the
  Run or surface another request.

## Inspect

`get_agent`

- Required: `agent`, caller `cwd`.
- Optional: `scope` (`project` by default).
- Returns identity and status plus `currentRun`, `lastRun`, and
  `pendingRequests` when present.

`get_history`

- Required: `agent`, caller `cwd`.
- Optional: `scope` (`project` by default), `limit`, from 1 to 100, default 6.
- Returns the most recent messages, Runs, and requests. Increase the limit only
  when older context is actually needed.

`list_agents`

- Required: caller `cwd`.
- Optional: `scope` (`project` by default).
- Returns Agents inside exactly that namespace plus safe provider diagnostics.

`list_models`

- Required: project `cwd`. Optional: `provider`; omit it to query both.
- Returns live provider catalogs, defaults, resolved aliases when available,
  and supported effort values.

## Manage Lifecycle

`release_agent`

- Required: `agent`, caller `cwd`. Optional: `scope`.
- Releases an idle member while preserving history and provider recovery data.

`stop_run`

- Required: caller `cwd`; supply `run_id` or `agent`. Optional: `scope`.
- Interrupts active work without deleting the Agent or its provider context.

`resume_agent`

- Required: `agent`, caller `cwd`. Optional: `scope`.
- Makes a released, stopped, or restart-recovered Agent ready again.

`delete_agent`

- Required: `agent`, caller `cwd`. Optional: `scope`.
- Permanently removes a non-running Agent and local history. This is destructive
  and requires explicit user intent.
