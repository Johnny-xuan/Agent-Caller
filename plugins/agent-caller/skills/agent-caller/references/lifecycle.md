# Agent Lifecycle

An Agent is a durable identity. A Run is one period of active work, and a
message is one conversation turn. Provider processes may exit without deleting
the Agent.

## States

- `ready`: available for a new message.
- `running`: handling one message.
- `waiting_for_input`: the active Run is paused for a decision or answer.
- `stopped`: the latest Run was interrupted; the Agent remains recoverable.
- `inactive`: released or recovered after service restart.
- `deleted`: identity and recovery metadata were intentionally removed.

Only one Run may mutate one Agent conversation at a time. Different Agents may
run concurrently. Use `send_message(wait=false)` to start independent Runs, then
poll each with `get_agent` rather than repeatedly loading full history.

Some Providers do not emit user-facing output while they search, call tools, or
reason. A `running` Run with empty output is still running; wait for its final
reply and never stop it solely because no partial text is visible.

All lifecycle actions remain inside the selected project or global scope. A
stable Agent ID, Run ID, or Request ID cannot bypass the caller CWD check.

## Release, Stop, Resume, Delete

Release is the normal way to put away an idle member. It preserves the complete
identity and provider conversation.

Stop interrupts an active Run. The provider session may still contain an
unfinished turn, so a later resume can continue that context. Do not use stop as
an idle cleanup operation.

Resume changes an inactive or stopped Agent back to ready. A normal follow-up to
an already ready Agent needs only `send_message`.

Delete is the only operation that intentionally forgets the Agent and local
history. It cannot delete a currently running member.

## Restart Recovery

Accepted messages receive Run IDs before provider work starts. Completed output
remains readable after restart. Interrupted Runs and expired requests are marked
instead of silently replayed. If provider recovery metadata remains valid, the
same Agent can resume its prior conversation.

There is no default maximum turn count. Provider context management, including
provider-supported compaction, remains provider-owned.
