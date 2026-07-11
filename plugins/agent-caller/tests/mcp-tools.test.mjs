import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import test from "node:test";

import { AgentService } from "../src/core/agent-service.mjs";
import { AgentStore } from "../src/core/store.mjs";
import { callAgentTool, TOOL_DEFINITIONS } from "../src/mcp/tools.mjs";

class FakeProvider {
  constructor() {
    this.capabilities = { multiTurn: true };
  }

  availability() {
    return { available: true, version: "fake" };
  }

  async listModels({ cwd }) {
    return {
      provider: "codex",
      cwd,
      configuredModel: "fake-model",
      configuredEffort: "medium",
      selectedModel: "fake-model",
      models: [{
        id: "fake-model",
        displayName: "Fake Model",
        isDefault: true,
        defaultEffort: "medium",
        supportedEfforts: ["low", "medium", "high"],
      }],
    };
  }

  async send({ agent, message, onEvent, onProviderState, onRequest }) {
    const sessionId = agent.providerState.sessionId || `fake_${agent.id}`;
    await onProviderState({ runtime: "fake", sessionId });
    let suffix = "";
    if (message === "needs-approval") {
      const response = await onRequest({
        kind: "tool_approval",
        title: "Approve test",
        tool: "Bash",
        input: { command: "npm test" },
      });
      suffix = `:${response.decision}`;
    }
    const output = `fake:${message}${suffix}`;
    await onEvent({ type: "assistant", text: output });
    return { output, providerState: { runtime: "fake", sessionId } };
  }
}

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-caller-mcp-tools-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const provider = new FakeProvider();
  const providers = new Map([["codex", provider]]);
  const service = new AgentService({ store: new AgentStore({ root }), providers });
  await service.init();
  return { service, providers };
}

test("the MCP surface stays agent-oriented", () => {
  assert.deepEqual(
    TOOL_DEFINITIONS.map((tool) => tool.name),
    [
      "create_agent",
      "send_message",
      "respond_to_request",
      "get_agent",
      "get_history",
      "list_agents",
      "list_models",
      "release_agent",
      "stop_run",
      "resume_agent",
      "delete_agent",
    ],
  );
  const create = TOOL_DEFINITIONS.find((tool) => tool.name === "create_agent");
  const send = TOOL_DEFINITIONS.find((tool) => tool.name === "send_message");
  const respond = TOOL_DEFINITIONS.find((tool) => tool.name === "respond_to_request");
  const history = TOOL_DEFINITIONS.find((tool) => tool.name === "get_history");
  const models = TOOL_DEFINITIONS.find((tool) => tool.name === "list_models");
  assert.equal("access" in create.inputSchema.properties, false);
  assert.deepEqual(create.inputSchema.properties.profile.enum, [
    "trusted",
    "guarded",
    "observer",
  ]);
  assert.equal(create.inputSchema.properties.profile.default, "trusted");
  assert.equal(create.inputSchema.properties.scope.default, "project");
  assert.equal("isolated" in create.inputSchema.properties, false);
  assert.equal(create.inputSchema.required.includes("cwd"), true);
  assert.equal(send.inputSchema.required.includes("cwd"), true);
  assert.match(create.inputSchema.properties.profile.description, /Defaults to trusted/);
  assert.equal(history.inputSchema.properties.limit.default, 6);
  assert.equal(models.annotations.openWorldHint, false);
  assert.match(create.inputSchema.properties.effort.description, /list_models/);
  assert.match(send.inputSchema.properties.model.description, /list_models/);
  assert.equal(send.annotations.openWorldHint, true);
  assert.equal(respond.annotations.openWorldHint, true);
});

test("MCP tools support multi-turn, release, resume, history, and delete", async (t) => {
  const context = await fixture(t);
  const cwd = "/tmp/agent-caller-project";
  const created = await callAgentTool(context, "create_agent", {
    name: "worker",
    provider: "codex",
    role: "Do focused work",
    cwd,
    model: "fake-model",
    effort: "high",
  });
  assert.equal(created.agent.recoverable, false);
  assert.equal(created.agent.profile, "trusted");
  assert.equal(created.agent.sandbox, "danger_full_access");
  assert.equal(created.agent.approval, "autonomous");
  assert.equal(created.agent.metadata.model, "fake-model");
  assert.equal(created.agent.metadata.effort, "high");
  assert.equal("providerState" in created.agent, false);

  const first = await callAgentTool(context, "send_message", {
    agent: created.agent.id,
    message: "first",
    cwd,
    model: "fake-model-fast",
    effort: "low",
  });
  const second = await callAgentTool(context, "send_message", {
    agent: created.agent.id,
    message: "second",
    cwd,
  });
  assert.equal(first.run.status, "completed");
  assert.equal(first.run.model, "fake-model-fast");
  assert.equal(first.run.effort, "low");
  assert.equal(second.agent.recoverable, true);

  const released = await callAgentTool(context, "release_agent", { agent: "worker", cwd });
  assert.equal(released.agent.status, "inactive");
  const resumed = await callAgentTool(context, "resume_agent", { agent: "worker", cwd });
  assert.equal(resumed.agent.status, "ready");

  const history = await callAgentTool(context, "get_history", {
    agent: "worker",
    cwd,
    limit: 10,
  });
  assert.deepEqual(
    history.messages.map((message) => message.content),
    ["first", "fake:first", "second", "fake:second"],
  );

  const deleted = await callAgentTool(context, "delete_agent", { agent: "worker", cwd });
  assert.equal(deleted.deleted.deleted, true);
  assert.equal((await callAgentTool(context, "list_agents", { cwd })).agents.length, 0);
});

test("MCP isolates project agents and requires explicit global scope", async (t) => {
  const context = await fixture(t);
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-caller-workspaces-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const projectA = path.join(root, "repository");
  const projectB = path.join(projectA, "nested-workspace");
  await fsp.mkdir(path.join(projectA, ".git"), { recursive: true });
  await fsp.mkdir(projectB, { recursive: true });
  const canonicalProjectA = await fsp.realpath(projectA);
  const canonicalProjectB = await fsp.realpath(projectB);

  const first = await callAgentTool(context, "create_agent", {
    name: "reviewer",
    provider: "codex",
    role: "Review project A",
    cwd: projectA,
  });
  const second = await callAgentTool(context, "create_agent", {
    name: "reviewer",
    provider: "codex",
    role: "Review project B",
    cwd: projectB,
  });
  const global = await callAgentTool(context, "create_agent", {
    name: "researcher",
    provider: "codex",
    role: "Research across projects",
    cwd: projectA,
    scope: "global",
  });

  assert.equal(first.agent.scope, "project");
  assert.equal(first.agent.workspaceRoot, canonicalProjectA);
  assert.equal(second.agent.workspaceRoot, canonicalProjectB);
  assert.equal(global.agent.scope, "global");
  assert.equal(global.agent.workspaceRoot, null);
  assert.deepEqual(
    (await callAgentTool(context, "list_agents", { cwd: projectA })).agents.map(({ id }) => id),
    [first.agent.id],
  );
  assert.deepEqual(
    (await callAgentTool(context, "list_agents", { cwd: projectB })).agents.map(({ id }) => id),
    [second.agent.id],
  );
  assert.deepEqual(
    (await callAgentTool(context, "list_agents", { cwd: projectB, scope: "global" }))
      .agents.map(({ id }) => id),
    [global.agent.id],
  );

  await assert.rejects(
    callAgentTool(context, "get_agent", { agent: first.agent.id, cwd: projectB }),
    (error) => error.code === "AGENT_NOT_FOUND",
  );
  await assert.rejects(
    callAgentTool(context, "send_message", {
      agent: first.agent.id,
      message: "cross project",
      cwd: projectB,
    }),
    (error) => error.code === "AGENT_NOT_FOUND",
  );

  const globalReply = await callAgentTool(context, "send_message", {
    agent: global.agent.id,
    message: "explicit global use",
    cwd: projectB,
    scope: "global",
  });
  assert.equal(globalReply.run.status, "completed");
});

test("MCP lists provider models and supported effort values", async (t) => {
  const context = await fixture(t);
  const listed = await callAgentTool(context, "list_models", {
    provider: "codex",
    cwd: "/tmp/model-project",
  });

  assert.equal(listed.providers.codex.available, true);
  assert.equal(listed.providers.codex.cwd, "/tmp/model-project");
  assert.equal(listed.providers.codex.models[0].id, "fake-model");
  assert.deepEqual(listed.providers.codex.models[0].supportedEfforts, [
    "low",
    "medium",
    "high",
  ]);
});

test("MCP exposes and resolves a pending provider request", async (t) => {
  const context = await fixture(t);
  await callAgentTool(context, "create_agent", {
    name: "supervised-worker",
    provider: "codex",
    role: "Work under supervision",
    cwd: "/tmp/supervised-project",
    sandbox: "workspace_write",
    approval: "on_request",
  });
  const waiting = await callAgentTool(context, "send_message", {
    agent: "supervised-worker",
    message: "needs-approval",
    cwd: "/tmp/supervised-project",
  });

  assert.equal(waiting.run.status, "waiting_for_input");
  assert.equal(waiting.pendingRequests.length, 1);
  assert.equal("transport" in waiting.pendingRequests[0], false);

  await assert.rejects(
    callAgentTool(context, "respond_to_request", {
      request_id: waiting.pendingRequests[0].id,
      decision: "allow_once",
      cwd: "/tmp/another-project",
    }),
    (error) => error.code === "AGENT_NOT_FOUND",
  );

  const completed = await callAgentTool(context, "respond_to_request", {
    request_id: waiting.pendingRequests[0].id,
    decision: "allow_once",
    cwd: "/tmp/supervised-project",
  });
  assert.equal(completed.run.status, "completed");
  assert.equal(completed.run.output, "fake:needs-approval:allow_once");
});
