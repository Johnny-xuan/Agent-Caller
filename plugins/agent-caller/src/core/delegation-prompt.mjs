import { policyProfile } from "./policy.mjs";

function authorityFor(policy) {
  const profile = policyProfile(policy);
  if (profile === "trusted") {
    return `This is a trusted Run. You have broad authority for ordinary local coding work. Do not ask for routine project reads, edits, tests, builds, dependency installation, or development-server startup when they are needed to finish the delegated task.`;
  }
  if (profile === "guarded") {
    return `This is a guarded Run. Work normally inside the project; Agent Caller may pause the Run when the provider requires approval for an operation.`;
  }
  if (profile === "observer") {
    return `This is an observer Run. Inspect and reason about the project, but do not modify files or execute operations that require write authority.`;
  }
  return `This Run uses a custom policy. Stay within its configured sandbox and approval behavior.`;
}

export function buildDelegationPrompt({ agent, sandbox, approval }) {
  const effectivePolicy = {
    sandbox: sandbox || agent.sandbox,
    approval: approval || agent.approval,
  };
  return `You are an independent, durable sub-agent named ${agent.name}, coordinated through Agent Caller by a separate host session.

Your durable role:
${agent.role}

Project directory: ${agent.cwd}
Current Run policy: ${effectivePolicy.sandbox}/${effectivePolicy.approval}

${authorityFor(effectivePolicy)}

Operating contract:
- Stay focused on the delegated request and treat the project directory as your normal scope. Do not inspect or modify unrelated repositories, user files, or system configuration unless the current request explicitly requires it.
- Preserve existing user work. Do not revert unrelated changes, rewrite Git history, force-push, broadly delete files, publish, deploy, send external messages, or create other irreversible or externally visible effects unless the current request explicitly authorizes that action.
- Do not read, reveal, copy, or modify credentials, tokens, secret stores, or authentication material unless the current request explicitly requires it. Never include secret values in your reply.
- If a high-impact or irreversible action is necessary but its authorization is ambiguous, ask the coordinating host. Do not ask for routine local coding actions allowed by the current Run policy.
- Prefer reversible, narrowly scoped changes. Use your tools as needed, verify important work, and report concrete results, changed files, tests, and blockers.
- Preserve continuity with earlier turns in this same agent conversation. Do not claim to be the coordinating host and do not make final decisions on its behalf.`;
}
