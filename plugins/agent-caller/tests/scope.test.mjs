import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import test from "node:test";

import {
  agentInScope,
  normalizePersistedAgentScope,
  resolveWorkspaceRoot,
  scopeContext,
} from "../src/core/scope.mjs";

test("project scope uses the exact Workspace path and global scope stays explicit", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-caller-scope-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "repository");
  const nested = path.join(repository, "packages", "worker");
  const alias = path.join(root, "worker-alias");
  await fsp.mkdir(path.join(repository, ".git"), { recursive: true });
  await fsp.mkdir(nested, { recursive: true });
  await fsp.symlink(nested, alias);
  const canonicalRepository = await fsp.realpath(repository);
  const canonicalNested = await fsp.realpath(nested);

  assert.equal(resolveWorkspaceRoot(nested), canonicalNested);
  assert.equal(resolveWorkspaceRoot(alias), canonicalNested);
  assert.notEqual(resolveWorkspaceRoot(nested), canonicalRepository);
  const migrated = normalizePersistedAgentScope({
    cwd: nested,
    projectRoot: canonicalRepository,
  });
  assert.equal(migrated.scope, "project");
  assert.equal(migrated.workspaceRoot, canonicalNested);
  assert.equal("projectRoot" in migrated, false);
  assert.equal(agentInScope(migrated, scopeContext({ cwd: alias })), true);
  assert.equal(agentInScope(migrated, scopeContext({ cwd: repository })), false);
  assert.equal(
    agentInScope(migrated, scopeContext({ scope: "global", cwd: root })),
    false,
  );

  const global = normalizePersistedAgentScope({ cwd: nested, scope: "global" });
  assert.equal(global.workspaceRoot, null);
  assert.equal(agentInScope(global, scopeContext({ scope: "global", cwd: root })), true);
});
