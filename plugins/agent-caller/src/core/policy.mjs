import { AgentCallerError } from "./errors.mjs";

export const SANDBOX_SCOPES = new Set([
  "read_only",
  "workspace_write",
  "danger_full_access",
]);

export const APPROVAL_POLICIES = new Set([
  "fail_closed",
  "on_request",
  "autonomous",
]);

export const TRUST_PROFILES = Object.freeze({
  trusted: Object.freeze({
    sandbox: "danger_full_access",
    approval: "autonomous",
  }),
  guarded: Object.freeze({
    sandbox: "workspace_write",
    approval: "on_request",
  }),
  observer: Object.freeze({
    sandbox: "read_only",
    approval: "fail_closed",
  }),
});

export const TRUST_PROFILE_NAMES = new Set(Object.keys(TRUST_PROFILES));

export function sandboxFromLegacyAccess(access) {
  return access === "write" ? "workspace_write" : "read_only";
}

export function legacyAccessFromSandbox(sandbox) {
  return sandbox === "read_only" ? "read_only" : "write";
}

export function defaultApproval(sandbox) {
  return sandbox === "read_only" ? "fail_closed" : "on_request";
}

export function resolvePolicy({ sandbox, approval, access } = {}) {
  const resolvedSandbox = sandbox || sandboxFromLegacyAccess(access);
  if (!SANDBOX_SCOPES.has(resolvedSandbox)) {
    throw new AgentCallerError("INVALID_SANDBOX", `Unsupported sandbox: ${resolvedSandbox}`);
  }

  const resolvedApproval = approval || defaultApproval(resolvedSandbox);
  if (!APPROVAL_POLICIES.has(resolvedApproval)) {
    throw new AgentCallerError("INVALID_APPROVAL", `Unsupported approval policy: ${resolvedApproval}`);
  }
  if (resolvedSandbox === "danger_full_access" && resolvedApproval === "fail_closed") {
    throw new AgentCallerError(
      "UNSAFE_POLICY_COMBINATION",
      "danger_full_access requires on_request or autonomous approval",
    );
  }

  return { sandbox: resolvedSandbox, approval: resolvedApproval };
}

export function policyProfile({ sandbox, approval }) {
  for (const [profile, policy] of Object.entries(TRUST_PROFILES)) {
    if (policy.sandbox === sandbox && policy.approval === approval) return profile;
  }
  return "custom";
}

export function resolveAgentPolicy(options = {}) {
  const { profile, sandbox, approval, access } = options;
  const hasLegacyPolicy = sandbox !== undefined || approval !== undefined || access !== undefined;

  // Calls that predate profiles keep their original low-level policy semantics.
  if (profile === undefined && hasLegacyPolicy) {
    const policy = resolvePolicy({ sandbox, approval, access });
    return { profile: policyProfile(policy), ...policy };
  }

  const selectedProfile = profile ?? "trusted";
  if (!TRUST_PROFILE_NAMES.has(selectedProfile)) {
    throw new AgentCallerError(
      "INVALID_PROFILE",
      `Unsupported trust profile: ${selectedProfile}`,
    );
  }
  const base = TRUST_PROFILES[selectedProfile];
  const policy = resolvePolicy({
    sandbox: sandbox ?? (access === undefined ? base.sandbox : sandboxFromLegacyAccess(access)),
    approval: approval ?? base.approval,
  });
  return { profile: policyProfile(policy), ...policy };
}

export function normalizePersistedAgent(agent) {
  const policy = resolvePolicy({
    sandbox: agent.sandbox,
    approval: agent.approval,
    access: agent.access,
  });
  const { access: _legacyAccess, profile: _persistedProfile, ...current } = agent;
  return { ...current, profile: policyProfile(policy), ...policy };
}

export function resolveRunPolicy(agent, options = {}) {
  const { profile, sandbox, approval, access } = options;
  if (profile !== undefined) {
    return resolveAgentPolicy({ profile, sandbox, approval, access });
  }

  if (sandbox === undefined && approval === undefined && access === undefined) {
    const policy = resolvePolicy(agent);
    return { profile: policyProfile(policy), ...policy };
  }

  const policy = resolvePolicy({
    sandbox: sandbox ?? (access === undefined ? agent.sandbox : undefined),
    approval: approval ?? agent.approval,
    access,
  });
  return { profile: policyProfile(policy), ...policy };
}
