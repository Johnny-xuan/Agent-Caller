import assert from "node:assert/strict";
import test from "node:test";

import {
  buildClaudeCliArgs,
  ClaudeCodeProvider,
  loadClaudeSettings,
} from "../src/providers/claude-code.mjs";

function agent(overrides = {}) {
  return {
    id: "agt_test",
    name: "architect",
    role: "Challenge architectural assumptions",
    cwd: "/tmp/project",
    metadata: {},
    providerState: {},
    ...overrides,
  };
}

function settings() {
  return {
    files: [],
    env: { PATH: process.env.PATH },
    model: "test-model",
    effort: "max",
    baseUrl: "https://example.invalid/anthropic",
    hasAuthToken: true,
    hasApiKey: false,
  };
}

test("SDK calls preserve role, session, and omit a default turn limit", async () => {
  const calls = [];
  const sdkLoader = async () => ({
    resolved: "/fake/sdk.mjs",
    module: {
      query({ prompt, options }) {
        calls.push({ prompt, options });
        const sessionId = options.resume || "claude-session-1";
        return (async function* events() {
          yield { type: "system", session_id: sessionId };
          yield {
            type: "assistant",
            session_id: sessionId,
            message: { content: [{ type: "text", text: `answer:${prompt}` }] },
          };
          yield {
            type: "result",
            subtype: "success",
            session_id: sessionId,
            result: `answer:${prompt}`,
          };
        })();
      },
    },
  });
  const provider = new ClaudeCodeProvider({
    runtime: "sdk",
    sdkLoader,
    settingsLoader: settings,
  });
  const observedState = [];
  const first = await provider.send({
    agent: agent(),
    message: "first",
    access: "read_only",
    signal: new AbortController().signal,
    onEvent: async () => {},
    onProviderState: async (state) => observedState.push(state),
  });
  const second = await provider.send({
    agent: agent({ providerState: first.providerState }),
    message: "second",
    access: "read_only",
    signal: new AbortController().signal,
    onEvent: async () => {},
    onProviderState: async () => {},
  });

  assert.equal(first.providerState.sessionId, "claude-session-1");
  assert.equal(second.providerState.sessionId, "claude-session-1");
  assert.equal(calls[1].options.resume, "claude-session-1");
  assert.equal("maxTurns" in calls[0].options, false);
  assert.equal(calls[0].options.model, "test-model");
  assert.equal(calls[0].options.effort, "max");
  assert.equal(calls[0].options.pathToClaudeCodeExecutable, "claude");
  assert.match(calls[0].options.systemPrompt.append, /Challenge architectural assumptions/);
  assert.match(calls[0].options.systemPrompt.append, /observer Run/);
  assert.match(calls[0].options.systemPrompt.append, /coordinated through Agent Caller/);
  assert.doesNotMatch(calls[0].options.systemPrompt.append, /parent Codex/);
  assert.match(calls[0].options.systemPrompt.append, /credentials, tokens, secret stores/);
  assert.match(calls[0].options.systemPrompt.append, /force-push/);
  assert.deepEqual(calls[0].options.tools, ["Read", "Glob", "Grep", "AskUserQuestion"]);
  assert.deepEqual(calls[0].options.allowedTools, ["Read", "Glob", "Grep"]);
  assert.equal(calls[0].options.permissionMode, "dontAsk");
  assert.equal(calls[0].options.sandbox.enabled, true);
  assert.equal(observedState[0].sessionId, "claude-session-1");
});

test("CLI arguments remain project-aware, resumable, and unlimited by default", () => {
  const args = buildClaudeCliArgs({
    agent: agent({ providerState: { sessionId: "resume-me" } }),
    message: "continue",
    access: "read_only",
    settings: settings(),
    sessionId: "new-session",
  });

  assert.equal(args.includes("--bare"), false);
  assert.equal(args.includes("--max-turns"), false);
  assert.equal(args.includes("--verbose"), true);
  assert.equal(args.at(-1), "continue");
  assert.equal(args[args.indexOf("--resume") + 1], "resume-me");
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Glob,Grep,AskUserQuestion");
  assert.equal(args[args.indexOf("--model") + 1], "test-model");
  assert.equal(args[args.indexOf("--effort") + 1], "max");
  assert.match(args[args.indexOf("--append-system-prompt") + 1], /architect/);
  assert.match(args[args.indexOf("--append-system-prompt") + 1], /observer Run/);
  assert.match(args[args.indexOf("--append-system-prompt") + 1], /coordinating host/);
});

test("Claude model catalog preserves compatible-endpoint models and effort levels", async () => {
  let closed = false;
  let executable;
  const provider = new ClaudeCodeProvider({
    runtime: "sdk",
    settingsLoader: () => ({
      ...settings(),
      model: "glm-5.2[1M]",
      baseUrl: "https://example.invalid/anthropic",
    }),
    sdkLoader: async () => ({
      resolved: "/fake/sdk.mjs",
      module: {
        query({ options }) {
          executable = options.pathToClaudeCodeExecutable;
          return {
            supportedModels: async () => [{
              value: "glm-5.2[1M]",
              resolvedModel: "glm-5.2[1m]",
              displayName: "glm-5.2[1M]",
              description: "Custom model",
              supportsEffort: true,
              supportedEffortLevels: ["low", "medium", "high", "max"],
              supportsAdaptiveThinking: true,
            }],
            close() {
              closed = true;
            },
          };
        },
      },
    }),
  });

  const catalog = await provider.listModels({ cwd: "/tmp/glm-project" });
  assert.equal(catalog.configuredModel, "glm-5.2[1M]");
  assert.equal(catalog.configuredEffort, "max");
  assert.equal(catalog.models[0].id, "glm-5.2[1M]");
  assert.deepEqual(catalog.models[0].supportedEfforts, ["low", "medium", "high", "max"]);
  assert.equal(executable, "claude");
  assert.equal(closed, true);
});

test("an already-aborted run never starts Claude Code", async () => {
  let loaded = false;
  const provider = new ClaudeCodeProvider({
    runtime: "sdk",
    sdkLoader: async () => {
      loaded = true;
      return { module: { query() {} }, resolved: "/fake/sdk.mjs" };
    },
    settingsLoader: settings,
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    provider.send({
      agent: agent(),
      message: "do not run",
      access: "read_only",
      signal: controller.signal,
      onEvent: async () => {},
      onProviderState: async () => {},
    }),
    (error) => error.code === "ABORT_ERR",
  );
  assert.equal(loaded, true);
});

test("SDK on-request policy forwards tool approval and session permission suggestions", async () => {
  let permissionResult;
  const sdkLoader = async () => ({
    resolved: "/fake/sdk.mjs",
    module: {
      query({ options }) {
        return (async function* events() {
          permissionResult = await options.canUseTool(
            "Bash",
            { command: "npm test" },
            {
              title: "Run tests",
              decisionReason: "Bash requires approval",
              suggestions: [{ type: "addRules", rules: [] }],
              toolUseID: "tool-1",
              requestId: "provider-request-1",
              signal: new AbortController().signal,
            },
          );
          yield { type: "result", subtype: "success", session_id: "session", result: "done" };
        })();
      },
    },
  });
  const requests = [];
  const provider = new ClaudeCodeProvider({ runtime: "sdk", sdkLoader, settingsLoader: settings });
  await provider.send({
    agent: agent(),
    message: "test",
    sandbox: "workspace_write",
    approval: "on_request",
    signal: new AbortController().signal,
    onEvent: async () => {},
    onProviderState: async () => {},
    onRequest: async (request) => {
      requests.push(request);
      return { decision: "allow_session" };
    },
  });

  assert.equal(requests[0].kind, "tool_approval");
  assert.equal(requests[0].input.command, "npm test");
  assert.equal(permissionResult.behavior, "allow");
  assert.deepEqual(permissionResult.updatedPermissions, [{ type: "addRules", rules: [] }]);
});

test("Claude CLI refuses an interactive policy instead of silently denying it", async () => {
  const provider = new ClaudeCodeProvider({ runtime: "cli", settingsLoader: settings });
  await assert.rejects(
    provider.send({
      agent: agent(),
      message: "edit",
      sandbox: "workspace_write",
      approval: "on_request",
      signal: new AbortController().signal,
      onEvent: async () => {},
      onProviderState: async () => {},
      onRequest: async () => ({ decision: "deny" }),
    }),
    (error) => error.code === "CLAUDE_INTERACTION_REQUIRES_SDK",
  );
});

test("Claude environment drops inherited OpenAI credentials unless Claude settings add them", () => {
  const loaded = loadClaudeSettings({
    home: "/path/that/does/not/exist",
    baseEnv: { PATH: "/bin", OPENAI_API_KEY: "drop", ANTHROPIC_AUTH_TOKEN: "keep" },
  });
  assert.equal(loaded.env.OPENAI_API_KEY, undefined);
  assert.equal(loaded.env.ANTHROPIC_AUTH_TOKEN, "keep");
});
