import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import test from "node:test";

import { AgentService } from "../src/core/agent-service.mjs";
import { abortError } from "../src/core/errors.mjs";
import { normalizePersistedAgent, resolveAgentPolicy } from "../src/core/policy.mjs";
import { AgentStore } from "../src/core/store.mjs";

class FakeProvider {
  constructor() {
    this.calls = [];
    this.capabilities = { multiTurn: true, stoppable: true };
  }

  async send({ agent, message, model, effort, signal, onEvent, onProviderState, onRequest }) {
    const sessionId = agent.providerState.sessionId || `fake_${agent.id}`;
    this.calls.push({ agentId: agent.id, message, model, effort, sessionId });
    await onProviderState({ sessionId });

    if (message === "wait") {
      if (signal.aborted) throw abortError();
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(abortError()), { once: true });
      });
    }

    if (message === "fail-partially") {
      await onEvent({ type: "output", text: "partial answer" });
      throw new Error("provider failed");
    }

    if (message === "request-tool") {
      const response = await onRequest({
        kind: "tool_approval",
        title: "Run tests",
        tool: "Bash",
        input: { command: "npm test" },
        availableDecisions: ["allow_once", "deny", "cancel"],
      });
      const output = `tool:${response.decision}`;
      await onEvent({ type: "output", text: output });
      return { output, providerState: { sessionId } };
    }

    if (message === "request-secret") {
      const response = await onRequest({
        kind: "question",
        title: "Credential",
        questions: [{ id: "token", question: "Token?", isSecret: true }],
        sensitive: true,
      });
      const output = response.answers?.token ? "secret-received" : "secret-missing";
      await onEvent({ type: "output", text: output });
      return { output, providerState: { sessionId } };
    }

    const output = `reply ${this.calls.length}: ${message}`;
    await onEvent({ type: "output", text: output });
    return {
      output,
      providerState: { sessionId },
      metadata: { fake: true },
    };
  }
}

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-caller-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const provider = new FakeProvider();
  const store = new AgentStore({ root });
  const service = new AgentService({ store, providers: { fake: provider } });
  await service.init();
  return { root, provider, store, service };
}

test("trust profiles provide explicit defaults without escalating legacy policy", async (t) => {
  const { service } = await fixture(t);
  const trusted = await service.createAgent({ name: "trusted-default", provider: "fake" });
  const guarded = await service.createAgent({
    name: "guarded-profile",
    provider: "fake",
    profile: "guarded",
  });
  const observer = await service.createAgent({
    name: "observer-profile",
    provider: "fake",
    profile: "observer",
  });

  assert.deepEqual(
    [trusted.profile, trusted.sandbox, trusted.approval],
    ["trusted", "danger_full_access", "autonomous"],
  );
  assert.deepEqual(
    [guarded.profile, guarded.sandbox, guarded.approval],
    ["guarded", "workspace_write", "on_request"],
  );
  assert.deepEqual(
    [observer.profile, observer.sandbox, observer.approval],
    ["observer", "read_only", "fail_closed"],
  );

  assert.deepEqual(resolveAgentPolicy({ sandbox: "read_only" }), {
    profile: "observer",
    sandbox: "read_only",
    approval: "fail_closed",
  });
  assert.deepEqual(resolveAgentPolicy({ profile: "trusted", approval: "on_request" }), {
    profile: "custom",
    sandbox: "danger_full_access",
    approval: "on_request",
  });
  assert.equal(normalizePersistedAgent({ access: "read_only" }).profile, "observer");
});

test("Agent model and effort defaults may be overridden for one Run", async (t) => {
  const { provider, service } = await fixture(t);
  const agent = await service.createAgent({
    name: "model-routing",
    provider: "fake",
    metadata: { model: "model-default", effort: "high" },
  });

  const defaultRun = await service.sendMessage({
    agent: agent.id,
    message: "use defaults",
  });
  const overrideRun = await service.sendMessage({
    agent: agent.id,
    message: "use override",
    model: "model-fast",
    effort: "low",
  });
  const restoredRun = await service.sendMessage({
    agent: agent.id,
    message: "use defaults again",
  });

  assert.deepEqual(
    provider.calls.map(({ model, effort }) => [model, effort]),
    [
      ["model-default", "high"],
      ["model-fast", "low"],
      ["model-default", "high"],
    ],
  );
  assert.deepEqual([defaultRun.run.model, defaultRun.run.effort], ["model-default", "high"]);
  assert.deepEqual([overrideRun.run.model, overrideRun.run.effort], ["model-fast", "low"]);
  assert.deepEqual([restoredRun.run.model, restoredRun.run.effort], ["model-default", "high"]);
});

test("one agent keeps provider context across multiple messages", async (t) => {
  const { provider, service } = await fixture(t);
  const agent = await service.createAgent({
    name: "architect",
    provider: "fake",
    role: "Challenge the architecture",
  });

  const first = await service.sendMessage({ agent: agent.id, message: "review storage" });
  const second = await service.sendMessage({ agent: agent.name, message: "go deeper" });
  const history = await service.getHistory(agent.id);

  assert.equal(first.run.status, "completed");
  assert.equal(second.run.status, "completed");
  assert.equal(provider.calls.length, 2);
  assert.equal(provider.calls[0].sessionId, provider.calls[1].sessionId);
  assert.deepEqual(
    history.messages.map((message) => message.role),
    ["user", "assistant", "user", "assistant"],
  );
  assert.equal(history.agent.status, "ready");
});

test("stopping a run preserves the agent and allows an explicit resume", async (t) => {
  const { service } = await fixture(t);
  const agent = await service.createAgent({
    name: "implementer",
    provider: "fake",
    role: "Implement changes",
  });

  const started = await service.startRun({ agent: agent.id, message: "wait" });
  const stopped = await service.stopRun({ runId: started.run.id });
  assert.equal(stopped.run.status, "stopped");
  assert.equal(stopped.agent.status, "stopped");
  assert.equal(stopped.agent.providerState.sessionId, `fake_${agent.id}`);

  await assert.rejects(
    service.sendMessage({ agent: agent.id, message: "continue" }),
    (error) => error.code === "AGENT_NOT_READY",
  );

  await service.resumeAgent(agent.id);
  const continued = await service.sendMessage({ agent: agent.id, message: "continue" });
  assert.equal(continued.run.status, "completed");
  assert.equal((await service.getHistory(agent.id)).messages.length, 3);
});

test("startup marks abandoned work interrupted without deleting the agent", async (t) => {
  const { root, service, store } = await fixture(t);
  const agent = await service.createAgent({
    name: "debugger",
    provider: "fake",
    role: "Debug failures",
  });
  const now = new Date().toISOString();
  const run = {
    id: "run_abandoned",
    agentId: agent.id,
    provider: "fake",
    status: "running",
    access: "read_only",
    requestMessageId: "msg_abandoned",
    responseMessageId: null,
    output: "",
    error: null,
    createdAt: now,
    startedAt: now,
    finishedAt: null,
    updatedAt: now,
  };
  await store.createRun(run);
  await store.updateAgent({ ...agent, status: "running", activeRunId: run.id });

  const restarted = new AgentService({
    store: new AgentStore({ root }),
    providers: { fake: new FakeProvider() },
  });
  const recovered = await restarted.init();
  const current = await restarted.getAgent(agent.id);

  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].status, "interrupted");
  assert.equal(current.agent.status, "inactive");
  assert.equal(current.agent.activeRunId, null);

  await restarted.resumeAgent(agent.id);
  const continued = await restarted.sendMessage({ agent: agent.id, message: "continue" });
  assert.equal(continued.run.status, "completed");
});

test("startup migrates legacy project roots to the persisted Workspace path", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-caller-migration-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "repository");
  const project = path.join(repository, "nested-workspace");
  await fsp.mkdir(path.join(repository, ".git"), { recursive: true });
  await fsp.mkdir(project, { recursive: true });
  const store = new AgentStore({ root: path.join(root, "state") });
  await store.init();
  const now = new Date().toISOString();
  await store.createAgent({
    id: "agt_legacy_scope",
    name: "legacy",
    provider: "fake",
    role: "Legacy agent",
    cwd: project,
    projectRoot: repository,
    access: "read_only",
    status: "ready",
    activeRunId: null,
    lastRunId: null,
    providerState: { sessionId: "persisted-session" },
    capabilities: {},
    metadata: {},
    createdAt: now,
    updatedAt: now,
  });

  const service = new AgentService({ store, providers: { fake: new FakeProvider() } });
  await service.init();
  const migrated = await service.getAgent("legacy", { cwd: project });
  assert.equal(migrated.agent.scope, "project");
  assert.equal(migrated.agent.workspaceRoot, await fsp.realpath(project));
  assert.equal("projectRoot" in migrated.agent, false);
  assert.equal(migrated.agent.providerState.sessionId, "persisted-session");
  assert.equal((await service.listAgents({ cwd: repository })).length, 0);
  assert.equal((await service.listAgents({ cwd: path.join(root, "other") })).length, 0);
});

test("a Run ID cannot bypass project scope", async (t) => {
  const { service } = await fixture(t);
  const projectA = "/tmp/agent-caller-run-project-a";
  const projectB = "/tmp/agent-caller-run-project-b";
  const agent = await service.createAgent({
    name: "scoped-runner",
    provider: "fake",
    cwd: projectA,
  });
  const started = await service.startRun({
    agent: agent.id,
    message: "wait",
    contextCwd: projectA,
  });

  await assert.rejects(
    service.stopRun({ runId: started.run.id, contextCwd: projectB }),
    (error) => error.code === "AGENT_NOT_FOUND",
  );
  await service.stopRun({ runId: started.run.id, contextCwd: projectA });
});

test("the same agent rejects concurrent runs while different agents remain independent", async (t) => {
  const { service } = await fixture(t);
  const first = await service.createAgent({ name: "first", provider: "fake" });
  const second = await service.createAgent({ name: "second", provider: "fake" });

  const waitingFirst = await service.startRun({ agent: first.id, message: "wait" });
  const waitingSecond = await service.startRun({ agent: second.id, message: "wait" });

  await assert.rejects(
    service.startRun({ agent: first.id, message: "overlap" }),
    (error) => error.code === "AGENT_BUSY",
  );

  await service.stopRun({ runId: waitingFirst.run.id });
  await service.stopRun({ runId: waitingSecond.run.id });
});

test("partial provider output survives a failed run", async (t) => {
  const { service } = await fixture(t);
  const agent = await service.createAgent({ name: "researcher", provider: "fake" });
  const result = await service.sendMessage({ agent: agent.id, message: "fail-partially" });
  const history = await service.getHistory(agent.id);

  assert.equal(result.run.status, "failed");
  assert.equal(result.run.output, "partial answer");
  assert.equal(history.messages.at(-1).partial, true);
  assert.equal(history.agent.status, "ready");
});

test("deleting one idle agent does not affect another", async (t) => {
  const { service } = await fixture(t);
  const first = await service.createAgent({ name: "temporary", provider: "fake" });
  const second = await service.createAgent({ name: "keeper", provider: "fake" });
  await service.sendMessage({ agent: second.id, message: "remember this" });

  const deleted = await service.deleteAgent(first.id);
  assert.equal(deleted.deleted, true);
  await assert.rejects(service.getAgent(first.id), (error) => error.code === "AGENT_NOT_FOUND");
  assert.equal((await service.getHistory(second.id)).messages.length, 2);
});

test("an idle agent can be released and resumed with provider context intact", async (t) => {
  const { service } = await fixture(t);
  const agent = await service.createAgent({ name: "releasable", provider: "fake" });
  const first = await service.sendMessage({ agent: agent.id, message: "first" });
  const sessionId = first.agent.providerState.sessionId;

  const released = await service.releaseAgent(agent.id);
  assert.equal(released.status, "inactive");
  await assert.rejects(
    service.sendMessage({ agent: agent.id, message: "too soon" }),
    (error) => error.code === "AGENT_NOT_READY",
  );

  await service.resumeAgent(agent.id);
  const second = await service.sendMessage({ agent: agent.id, message: "second" });
  assert.equal(second.agent.providerState.sessionId, sessionId);
  assert.equal(second.run.status, "completed");
});

test("external IDs cannot escape the state directory", async (t) => {
  const { service } = await fixture(t);
  await assert.rejects(
    service.getRun("../../outside"),
    (error) => error.code === "INVALID_ID",
  );
  await assert.rejects(
    service.getAgent("agt_../../outside"),
    (error) => error.code === "AGENT_NOT_FOUND",
  );
});

test("a second service neither interrupts nor overlaps a live agent run", async (t) => {
  const { root, service } = await fixture(t);
  const agent = await service.createAgent({ name: "shared", provider: "fake" });
  const waiting = await service.startRun({ agent: agent.id, message: "wait" });

  const secondService = new AgentService({
    store: new AgentStore({ root }),
    providers: { fake: new FakeProvider() },
  });
  const recovered = await secondService.init();
  assert.equal(recovered.length, 0);
  assert.equal((await secondService.getAgent(agent.id)).agent.status, "running");
  await assert.rejects(
    secondService.startRun({ agent: agent.id, message: "overlap" }),
    (error) => error.code === "AGENT_BUSY",
  );

  await service.stopRun({ runId: waiting.run.id });
});

test("a provider request pauses and resumes the same Run", async (t) => {
  const { service } = await fixture(t);
  const agent = await service.createAgent({
    name: "supervised",
    provider: "fake",
    sandbox: "workspace_write",
    approval: "on_request",
  });

  const waiting = await service.sendMessage({ agent: agent.id, message: "request-tool" });
  assert.equal(waiting.run.status, "waiting_for_input");
  assert.equal(waiting.agent.status, "waiting_for_input");
  assert.equal(waiting.pendingRequests.length, 1);
  assert.equal(waiting.pendingRequests[0].tool, "Bash");

  const completed = await service.respondToRequest({
    requestId: waiting.pendingRequests[0].id,
    decision: "allow_once",
  });
  assert.equal(completed.run.id, waiting.run.id);
  assert.equal(completed.run.status, "completed");
  assert.equal(completed.run.output, "tool:allow_once");
  assert.equal(completed.agent.status, "ready");
  assert.deepEqual(completed.pendingRequests, []);

  const history = await service.getHistory(agent.id);
  assert.equal(history.requests[0].status, "resolved");
  assert.equal(history.requests[0].resolution.decision, "allow_once");
});

test("secret answers reach the provider but are redacted from history", async (t) => {
  const { service } = await fixture(t);
  const agent = await service.createAgent({ name: "secret", provider: "fake" });
  const waiting = await service.sendMessage({ agent: agent.id, message: "request-secret" });
  const completed = await service.respondToRequest({
    requestId: waiting.pendingRequests[0].id,
    answers: { token: "very-secret" },
  });

  assert.equal(completed.run.output, "secret-received");
  const history = await service.getHistory(agent.id);
  assert.equal(history.requests[0].resolution.answers.token, "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(history), /very-secret/);
});

test("stopping a waiting Run cancels its pending request", async (t) => {
  const { service } = await fixture(t);
  const agent = await service.createAgent({ name: "cancel-wait", provider: "fake" });
  const waiting = await service.sendMessage({ agent: agent.id, message: "request-tool" });
  const stopped = await service.stopRun({ runId: waiting.run.id });
  assert.equal(stopped.run.status, "stopped");
  const history = await service.getHistory(agent.id);
  assert.equal(history.requests[0].status, "cancelled");
});

test("restart expires a persisted request whose provider callback disappeared", async (t) => {
  const { root, service, store } = await fixture(t);
  const agent = await service.createAgent({ name: "restart-request", provider: "fake" });
  const now = new Date().toISOString();
  const run = {
    id: "run_waiting_restart",
    agentId: agent.id,
    provider: "fake",
    status: "waiting_for_input",
    sandbox: "workspace_write",
    approval: "on_request",
    requestMessageId: "msg_restart",
    responseMessageId: null,
    output: "",
    error: null,
    pendingRequestIds: ["req_restart"],
    createdAt: now,
    startedAt: now,
    finishedAt: null,
    updatedAt: now,
  };
  await store.createRun(run);
  await store.createRequest({
    id: "req_restart",
    agentId: agent.id,
    runId: run.id,
    provider: "fake",
    kind: "tool_approval",
    status: "pending",
    resolution: null,
    createdAt: now,
    updatedAt: now,
  });
  await store.updateAgent({
    ...agent,
    status: "waiting_for_input",
    activeRunId: run.id,
  });

  const restarted = new AgentService({
    store: new AgentStore({ root }),
    providers: { fake: new FakeProvider() },
  });
  await restarted.init();
  const history = await restarted.getHistory(agent.id);

  assert.equal(history.runs[0].status, "interrupted");
  assert.equal(history.requests[0].status, "expired");
  assert.equal(history.agent.status, "inactive");
});

test("a Run may narrow but cannot escalate its Agent policy", async (t) => {
  const { service } = await fixture(t);
  const restricted = await service.createAgent({
    name: "policy-ceiling",
    provider: "fake",
    sandbox: "read_only",
    approval: "fail_closed",
  });
  await assert.rejects(
    service.sendMessage({
      agent: restricted.id,
      message: "escalate",
      sandbox: "workspace_write",
      approval: "on_request",
    }),
    (error) => error.code === "POLICY_ESCALATION",
  );

  const broad = await service.createAgent({
    name: "policy-narrow",
    provider: "fake",
    sandbox: "workspace_write",
    approval: "on_request",
  });
  const narrowed = await service.sendMessage({
    agent: broad.id,
    message: "narrow",
    sandbox: "read_only",
    approval: "fail_closed",
  });
  assert.equal(narrowed.run.sandbox, "read_only");
  assert.equal(narrowed.run.approval, "fail_closed");
});

test("a stop-response race cannot leave an orphaned running agent", async (t) => {
  const { service } = await fixture(t);
  const agent = await service.createAgent({ name: "race", provider: "fake" });
  const waiting = await service.sendMessage({ agent: agent.id, message: "request-tool" });
  await Promise.allSettled([
    service.stopRun({ runId: waiting.run.id }),
    service.respondToRequest({
      requestId: waiting.pendingRequests[0].id,
      decision: "allow_once",
    }),
  ]);

  const current = await service.getAgent(agent.id);
  assert.equal(["ready", "stopped"].includes(current.agent.status), true);
  assert.equal(current.agent.activeRunId, null);
  assert.equal(current.pendingRequests.length, 0);
});
