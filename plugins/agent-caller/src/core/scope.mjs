import fs from "node:fs";
import path from "node:path";

import { AgentCallerError } from "./errors.mjs";

export const AGENT_SCOPES = ["project", "global"];

function canonicalPath(cwd) {
  const resolved = path.resolve(String(cwd || ""));
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function resolveWorkspaceRoot(cwd) {
  if (!String(cwd || "").trim()) {
    throw new AgentCallerError("CWD_REQUIRED", "cwd is required for Agent scope");
  }
  return canonicalPath(cwd);
}

export function normalizeScope(scope) {
  const value = scope || "project";
  if (!AGENT_SCOPES.includes(value)) {
    throw new AgentCallerError("INVALID_SCOPE", `Unknown Agent scope: ${value}`);
  }
  return value;
}

export function normalizePersistedAgentScope(agent) {
  if (!agent || typeof agent !== "object") return agent;
  const scope = AGENT_SCOPES.includes(agent.scope) ? agent.scope : "project";
  const { projectRoot: _legacyProjectRoot, ...persisted } = agent;
  return {
    ...persisted,
    scope,
    workspaceRoot: scope === "project"
      ? resolveWorkspaceRoot(agent.workspaceRoot || agent.cwd)
      : null,
  };
}

export function scopeContext({ scope, cwd }) {
  const normalizedScope = normalizeScope(scope);
  return {
    scope: normalizedScope,
    workspaceRoot: normalizedScope === "project" ? resolveWorkspaceRoot(cwd) : null,
  };
}

export function agentInScope(agent, context) {
  const normalized = normalizePersistedAgentScope(agent);
  if (normalized.scope !== context.scope) return false;
  return context.scope === "global" || normalized.workspaceRoot === context.workspaceRoot;
}
