import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  buildCodexAppServerArgs,
  buildCodexThreadParams,
  codexProcessEnv,
  CodexProvider,
} from "../src/providers/codex.mjs";

function agent(overrides = {}) {
  return {
    id: "agt_codex_test",
    name: "implementer",
    role: "Implement scoped changes and report verification",
    cwd: "/tmp/project",
    metadata: { model: "gpt-test" },
    providerState: {},
    ...overrides,
  };
}

class FakeAppServer extends EventEmitter {
  constructor({
    answer = "answer",
    approvalRequest = false,
    configuredModel = "gpt-test",
    configuredEffort = "medium",
    availableModels = [{ id: "gpt-test", isDefault: true }],
  } = {}) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.messages = [];
    this.answer = answer;
    this.approvalRequest = approvalRequest;
    this.configuredModel = configuredModel;
    this.configuredEffort = configuredEffort;
    this.availableModels = availableModels;
    this.turnId = `turn-${answer}`;
    this.stdinBuffer = "";
    this.stdin.on("data", (chunk) => {
      this.stdinBuffer += chunk.toString();
      const lines = this.stdinBuffer.split("\n");
      this.stdinBuffer = lines.pop() || "";
      for (const line of lines.filter(Boolean)) this.#handle(JSON.parse(line));
    });
  }

  #send(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  #response(id, result) {
    this.#send({ jsonrpc: "2.0", id, result });
  }

  #complete() {
    this.#send({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: "codex-thread-1", turnId: this.turnId, delta: this.answer },
    });
    this.#send({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId: "codex-thread-1",
        turnId: this.turnId,
        completedAtMs: Date.now(),
        item: { type: "agentMessage", id: `item-${this.answer}`, text: this.answer, phase: null, memoryCitation: null },
      },
    });
    this.#send({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: "codex-thread-1",
        turn: {
          id: this.turnId,
          items: [],
          itemsView: "full",
          status: "completed",
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 10,
        },
      },
    });
  }

  #handle(message) {
    this.messages.push(message);
    if (message.method === "initialize") {
      this.#response(message.id, {
        userAgent: "fake",
        codexHome: "/tmp/codex",
        platformFamily: "unix",
        platformOs: "macos",
      });
      return;
    }
    if (message.method === "thread/start" || message.method === "thread/resume") {
      this.#response(message.id, {
        thread: { id: "codex-thread-1" },
        model: message.params.model || this.configuredModel,
        reasoningEffort: this.configuredEffort,
      });
      return;
    }
    if (message.method === "config/read") {
      this.#response(message.id, {
        config: {
          model: this.configuredModel,
          model_reasoning_effort: this.configuredEffort,
        },
        origins: {},
        layers: null,
      });
      return;
    }
    if (message.method === "model/list") {
      this.#response(message.id, {
        data: this.availableModels,
        nextCursor: null,
      });
      return;
    }
    if (message.method === "turn/start") {
      this.#response(message.id, {
        turn: { id: this.turnId, items: [], status: "inProgress" },
      });
      setImmediate(() => {
        if (this.approvalRequest) {
          this.#send({
            jsonrpc: "2.0",
            id: "approval-1",
            method: "item/commandExecution/requestApproval",
            params: {
              threadId: "codex-thread-1",
              turnId: this.turnId,
              itemId: "command-1",
              startedAtMs: Date.now(),
              command: "npm test",
              cwd: "/tmp/project",
              reason: "Run verification",
              availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
            },
          });
        } else {
          this.#complete();
        }
      });
      return;
    }
    if (message.id === "approval-1" && !message.method) {
      this.approvalResponse = message.result;
      setImmediate(() => this.#complete());
    }
  }

  kill(signal = "SIGTERM") {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", null, signal);
    return true;
  }
}

class EarlyExitAppServer extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.stdin.once("data", () => {
      this.stderr.end("app-server startup failed");
      this.stdout.end();
      this.exitCode = 1;
      this.emit("close", 1, null);
    });
  }

  kill() {
    return false;
  }
}

function sendContext(overrides = {}) {
  return {
    agent: agent(),
    message: "work",
    sandbox: "read_only",
    approval: "fail_closed",
    signal: new AbortController().signal,
    onEvent: async () => {},
    onProviderState: async () => {},
    onRequest: async () => ({ decision: "deny" }),
    ...overrides,
  };
}

test("new and resumed Codex turns use App Server and preserve thread identity", async () => {
  const children = [];
  const processFactory = (_command, args) => {
    const child = new FakeAppServer({ answer: `answer-${children.length + 1}` });
    child.args = args;
    children.push(child);
    return child;
  };
  const provider = new CodexProvider({ processFactory });
  const states = [];
  const first = await provider.send(sendContext({
    message: "first",
    onProviderState: async (state) => states.push(state),
  }));
  const second = await provider.send(sendContext({
    agent: agent({ providerState: first.providerState }),
    message: "second",
  }));

  assert.equal(first.output, "answer-1");
  assert.equal(second.output, "answer-2");
  assert.equal(first.providerState.threadId, "codex-thread-1");
  assert.equal(children[0].messages.some((message) => message.method === "thread/start"), true);
  assert.equal(children[1].messages.some((message) => message.method === "thread/resume"), true);
  const resumed = children[1].messages.find((message) => message.method === "thread/resume");
  assert.equal(resumed.params.threadId, "codex-thread-1");
  const started = children[0].messages.find((message) => message.method === "thread/start");
  assert.match(started.params.developerInstructions, /Implement scoped changes/);
  assert.equal(states[0].runtime, "app-server");
});

test("Codex App Server policy maps sandbox and approval explicitly", () => {
  const params = buildCodexThreadParams({
    agent: agent(),
    sandbox: "workspace_write",
    approval: "on_request",
  });
  assert.equal(params.sandbox, "workspace-write");
  assert.equal(params.approvalPolicy, "on-request");
  assert.equal(params.model, "gpt-test");
  assert.match(params.developerInstructions, /guarded Run/);
  assert.match(params.developerInstructions, /Do not read, reveal, copy, or modify credentials/);
  assert.deepEqual(
    buildCodexAppServerArgs(agent({ metadata: { isolated: true } })),
    ["app-server", "--stdio"],
  );
});

test("Codex trusted policy receives autonomous local-work guidance", () => {
  const params = buildCodexThreadParams({
    agent: agent({
      profile: "trusted",
      sandbox: "danger_full_access",
      approval: "autonomous",
    }),
    sandbox: "danger_full_access",
    approval: "autonomous",
  });
  assert.match(params.developerInstructions, /trusted Run/);
  assert.match(params.developerInstructions, /coordinated through Agent Caller/);
  assert.doesNotMatch(params.developerInstructions, /parent Codex/);
  assert.match(params.developerInstructions, /Do not ask for routine project reads, edits, tests/);
});

test("Codex model catalog reports configured selection and supported efforts", async () => {
  const child = new FakeAppServer({
    availableModels: [{
      id: "gpt-test",
      model: "gpt-test",
      displayName: "GPT Test",
      description: "Test model",
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Fast" },
        { reasoningEffort: "medium", description: "Balanced" },
        { reasoningEffort: "high", description: "Deep" },
      ],
    }],
  });
  const provider = new CodexProvider({ processFactory: () => child });
  const catalog = await provider.listModels({ cwd: "/tmp/codex-models" });

  assert.equal(catalog.configuredModel, "gpt-test");
  assert.equal(catalog.configuredEffort, "medium");
  assert.equal(catalog.selectedModel, "gpt-test");
  assert.equal(catalog.configuredModelAdvertised, true);
  assert.equal(catalog.models[0].advertised, true);
  assert.deepEqual(catalog.models[0].supportedEfforts, ["low", "medium", "high"]);
});

test("Codex Run model and effort overrides reach turn/start", async () => {
  const child = new FakeAppServer();
  const provider = new CodexProvider({ processFactory: () => child });
  const result = await provider.send(sendContext({
    model: "gpt-test-fast",
    effort: "xhigh",
  }));
  const turnStart = child.messages.find((message) => message.method === "turn/start");

  assert.equal(turnStart.params.model, "gpt-test-fast");
  assert.equal(turnStart.params.effort, "xhigh");
  assert.equal(result.metadata.model, "gpt-test-fast");
  assert.equal(result.metadata.effort, "xhigh");
});

test("Codex approval requests round-trip through the provider callback", async () => {
  const child = new FakeAppServer({ answer: "approved", approvalRequest: true });
  const requests = [];
  const provider = new CodexProvider({ processFactory: () => child });
  const result = await provider.send(sendContext({
    sandbox: "workspace_write",
    approval: "on_request",
    onRequest: async (request) => {
      requests.push(request);
      return { decision: "allow_session" };
    },
  }));

  assert.equal(result.output, "approved");
  assert.equal(requests[0].kind, "command_approval");
  assert.equal(requests[0].input.command, "npm test");
  assert.deepEqual(child.approvalResponse, { decision: "acceptForSession" });
});

test("Codex autonomous policy accepts provider approval callbacks inside its sandbox", async () => {
  const child = new FakeAppServer({ answer: "autonomous", approvalRequest: true });
  let forwarded = false;
  const provider = new CodexProvider({ processFactory: () => child });
  const result = await provider.send(sendContext({
    sandbox: "workspace_write",
    approval: "autonomous",
    onRequest: async () => {
      forwarded = true;
      return { decision: "deny" };
    },
  }));

  assert.equal(result.output, "autonomous");
  assert.equal(forwarded, false);
  assert.deepEqual(child.approvalResponse, { decision: "accept" });
});

test("Codex child environment drops Claude provider credentials", () => {
  const env = codexProcessEnv({
    PATH: "/bin",
    CODEX_HOME: "/tmp/user-codex-home",
    OPENAI_API_KEY: "keep-codex-auth",
    ANTHROPIC_API_KEY: "drop",
    ANTHROPIC_AUTH_TOKEN: "drop",
  });
  assert.equal(env.CODEX_HOME, "/tmp/user-codex-home");
  assert.equal(env.OPENAI_API_KEY, "keep-codex-auth");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
});

test("an unadvertised configured model falls back unless explicitly pinned", async () => {
  const child = new FakeAppServer({
    answer: "fallback",
    configuredModel: "future-model",
    availableModels: [{ id: "gpt-test", isDefault: true }],
  });
  const provider = new CodexProvider({ processFactory: () => child });
  const result = await provider.send(sendContext({
    agent: agent({ metadata: {} }),
  }));
  const threadStart = child.messages.find((message) => message.method === "thread/start");

  assert.equal(threadStart.params.model, "gpt-test");
  assert.equal(result.metadata.configuredModelAdvertised, false);
  assert.equal(result.metadata.model, "gpt-test");
  assert.deepEqual(result.metadata.modelFallback, {
    configured: "future-model",
    selected: "gpt-test",
  });
});

test("model catalog labels configured but unadvertised models", async () => {
  const child = new FakeAppServer({
    configuredModel: "future-model",
    configuredEffort: "high",
    availableModels: [{ id: "gpt-test", isDefault: true }],
  });
  const provider = new CodexProvider({ processFactory: () => child });
  const catalog = await provider.listModels({ cwd: "/tmp/codex-models" });

  assert.equal(catalog.selectedModel, "gpt-test");
  assert.equal(catalog.configuredModelAdvertised, false);
  assert.equal(catalog.modelFallbackRequired, true);
  assert.deepEqual(catalog.models[0], {
    id: "future-model",
    resolvedModel: "future-model",
    displayName: "future-model",
    description: "Configured in Codex but not advertised by App Server model/list.",
    isDefault: false,
    isConfigured: true,
    advertised: false,
    defaultEffort: "high",
    supportedEfforts: ["high"],
    effortDescriptions: {},
  });
});

test("an already-aborted Codex run does not spawn App Server", async () => {
  let spawned = false;
  const provider = new CodexProvider({
    processFactory: () => {
      spawned = true;
      return new FakeAppServer();
    },
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    provider.send(sendContext({ signal: controller.signal })),
    (error) => error.code === "ABORT_ERR",
  );
  assert.equal(spawned, false);
});

test("App Server startup exit rejects pending protocol requests", async () => {
  const provider = new CodexProvider({ processFactory: () => new EarlyExitAppServer() });
  await assert.rejects(
    provider.send(sendContext()),
    /app-server startup failed/,
  );
});
