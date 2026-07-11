import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { abortError } from "../core/errors.mjs";
import { buildDelegationPrompt } from "../core/delegation-prompt.mjs";
import { resolvePolicy } from "../core/policy.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "../..");
const DEFAULT_RUNTIME_ROOT = path.join(os.homedir(), ".codex", "agent-caller", "runtime");
const CLAUDE_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"];
const READ_ONLY_AVAILABLE_TOOLS = [...READ_ONLY_TOOLS, "AskUserQuestion"];
const WRITE_TOOLS = ["Write", "Edit", "NotebookEdit"];
const OPENAI_SECRET_KEYS = ["OPENAI_API_KEY", "OPENAI_ACCESS_TOKEN"];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function lastSetting(loaded, key) {
  for (let index = loaded.length - 1; index >= 0; index -= 1) {
    if (loaded[index].value[key] !== undefined) return loaded[index].value[key];
  }
  return undefined;
}

export function loadClaudeSettings({ home = os.homedir(), baseEnv = process.env } = {}) {
  const files = [
    path.join(home, ".claude", "settings.json"),
    path.join(home, ".claude", "settings.local.json"),
  ];
  const loaded = files
    .map((file) => ({ file, value: readJson(file) }))
    .filter((entry) => entry.value);
  const env = { ...baseEnv };
  for (const key of OPENAI_SECRET_KEYS) delete env[key];
  for (const entry of loaded) {
    if (entry.value.env && typeof entry.value.env === "object") {
      Object.assign(env, entry.value.env);
    }
  }

  return {
    files: loaded.map((entry) => entry.file),
    env,
    baseUrl: env.ANTHROPIC_BASE_URL,
    model:
      env.ANTHROPIC_MODEL ||
      lastSetting(loaded, "model") ||
      env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    effort: lastSetting(loaded, "effortLevel"),
    hasAuthToken: Boolean(env.ANTHROPIC_AUTH_TOKEN),
    hasApiKey: Boolean(env.ANTHROPIC_API_KEY),
  };
}

function makeRequire(directory) {
  return createRequire(path.join(directory, "__agent_caller_require__.cjs"));
}

export function resolveClaudeSdk() {
  const candidates = [
    process.env.AGENT_CALLER_RUNTIME_DIR,
    PLUGIN_ROOT,
    DEFAULT_RUNTIME_ROOT,
    process.cwd(),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const resolved = makeRequire(candidate).resolve(CLAUDE_SDK_PACKAGE);
      return { ok: true, root: candidate, resolved };
    } catch {
      // Continue through the explicit resolution order.
    }
  }
  return { ok: false };
}

async function defaultSdkLoader() {
  const sdk = resolveClaudeSdk();
  if (!sdk.ok) throw new Error(`${CLAUDE_SDK_PACKAGE} is not installed`);
  const module = await import(pathToFileURL(sdk.resolved).href);
  if (typeof module.query !== "function") {
    throw new Error(`Claude Agent SDK at ${sdk.resolved} does not export query()`);
  }
  return { module, resolved: sdk.resolved };
}

function claudePermissionMode(approval) {
  if (approval === "on_request") return "default";
  if (approval === "autonomous") return "bypassPermissions";
  return "dontAsk";
}

function claudeSandbox(agent, sandbox, approval) {
  if (sandbox === "danger_full_access") return undefined;
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: approval === "autonomous",
    allowUnsandboxedCommands: false,
    filesystem: sandbox === "workspace_write" ? { allowWrite: [agent.cwd] } : undefined,
  };
}

function normalizeAnswers(questions, answers = {}) {
  const normalized = {};
  questions.forEach((question, index) => {
    const id = `q${index + 1}`;
    const value = answers[id] ?? answers[question.question];
    if (value === undefined) return;
    normalized[question.question] = Array.isArray(value) ? value.join(", ") : String(value);
  });
  return normalized;
}

function publicQuestions(questions = []) {
  return questions.map((question, index) => ({
    id: `q${index + 1}`,
    header: question.header || `Question ${index + 1}`,
    question: question.question,
    options: question.options,
    multiSelect: Boolean(question.multiSelect),
    isSecret: Boolean(question.isSecret),
  }));
}

function sdkRequestHandlers(onRequest, approval) {
  const canUseTool = async (tool, input, details) => {
    if (tool === "AskUserQuestion" && Array.isArray(input?.questions)) {
      const result = await onRequest({
        kind: "question",
        title: "Claude Code needs input",
        description: "The agent needs an answer before it can continue.",
        tool,
        questions: publicQuestions(input.questions),
        sensitive: input.questions.some((question) => question.isSecret),
      });
      if (["deny", "cancel"].includes(result.decision)) {
        return {
          behavior: "deny",
          message: result.decision === "cancel" ? "The coordinator cancelled the request" : "The coordinator declined to answer",
          interrupt: result.decision === "cancel",
        };
      }
      return {
        behavior: "allow",
        updatedInput: {
          ...input,
          answers: normalizeAnswers(input.questions, result.answers),
        },
      };
    }

    if (approval === "fail_closed") {
      return {
        behavior: "deny",
        message: "Agent Caller is configured to fail closed for unapproved operations",
      };
    }
    if (approval === "autonomous") {
      return { behavior: "allow", updatedInput: input };
    }

    const result = await onRequest({
      kind: "tool_approval",
      title: details.title || `${tool} requires approval`,
      description: details.description || details.decisionReason,
      tool,
      input,
      availableDecisions: ["allow_once", "allow_session", "deny", "cancel"],
    });
    if (result.decision === "allow_once" || result.decision === "allow_session") {
      return {
        behavior: "allow",
        updatedInput: input,
        updatedPermissions:
          result.decision === "allow_session" ? details.suggestions : undefined,
      };
    }
    return {
      behavior: "deny",
      message: result.decision === "cancel" ? "The coordinator cancelled this operation" : "The coordinator denied this operation",
      interrupt: result.decision === "cancel",
    };
  };

  const onElicitation = async (request) => {
    const result = await onRequest({
      kind: "elicitation",
      title: request.title || request.displayName || "Claude MCP request",
      description: request.description || request.message,
      input: {
        serverName: request.serverName,
        mode: request.mode,
        url: request.url,
        requestedSchema: request.requestedSchema,
      },
      availableDecisions: ["allow_once", "deny", "cancel"],
      sensitive: Boolean(request.requestedSchema?.properties && Object.values(request.requestedSchema.properties).some(
        (property) => property?.format === "password" || property?.writeOnly === true,
      )),
    });
    if (result.decision === "cancel") return { action: "cancel" };
    if (result.decision === "deny") return { action: "decline" };
    return { action: "accept", content: result.response || result.answers };
  };

  const onUserDialog = async (request) => {
    const result = await onRequest({
      kind: "user_dialog",
      title: "Claude Code needs a decision",
      description: request.dialogKind,
      input: request.payload,
      availableDecisions: ["allow_once", "deny", "cancel"],
    });
    if (result.decision === "cancel" || result.decision === "deny") {
      return { behavior: "cancelled" };
    }
    return { behavior: "completed", result: result.response };
  };

  return { canUseTool, onElicitation, onUserDialog };
}

function sdkOptions({
  agent,
  sandbox,
  approval,
  model,
  effort,
  settings,
  abortController,
  sessionId,
  onRequest,
  cliBinary,
}) {
  const options = {
    cwd: agent.cwd,
    env: settings.env,
    abortController,
    settingSources: ["user", "project", "local"],
    pathToClaudeCodeExecutable: cliBinary,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: buildDelegationPrompt({ agent, sandbox, approval }),
    },
    permissionMode: claudePermissionMode(approval),
    sandbox: claudeSandbox(agent, sandbox, approval),
  };
  if (approval === "autonomous") options.allowDangerouslySkipPermissions = true;
  Object.assign(options, sdkRequestHandlers(onRequest, approval));
  options.supportedDialogKinds = ["refusal_fallback_prompt"];
  const selectedModel = model || agent.metadata?.model || settings.model;
  const selectedEffort = effort || agent.metadata?.effort || settings.effort;
  if (selectedModel) options.model = selectedModel;
  if (selectedEffort) options.effort = selectedEffort;
  if (agent.providerState?.sessionId) options.resume = agent.providerState.sessionId;
  else options.sessionId = sessionId;

  if (sandbox === "read_only") {
    options.tools = READ_ONLY_AVAILABLE_TOOLS;
    options.allowedTools = READ_ONLY_TOOLS;
    options.disallowedTools = [...WRITE_TOOLS, "Bash"];
  }
  return options;
}

function assistantText(message) {
  return (message?.message?.content || [])
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text)
    .join("");
}

function providerFailure(result) {
  const error = new Error(result?.result || result?.subtype || "Claude Code returned an error");
  error.code = result?.subtype || "CLAUDE_ERROR";
  return error;
}

export function buildClaudeCliArgs({
  agent,
  message,
  sandbox,
  approval,
  access,
  model,
  effort,
  settings,
  sessionId,
}) {
  const policy = resolvePolicy({ sandbox, approval, access });
  const args = [
    "-p",
    "--no-chrome",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--setting-sources",
    "user,project,local",
    "--append-system-prompt",
    buildDelegationPrompt({ agent, ...policy }),
    "--permission-mode",
    claudePermissionMode(policy.approval),
  ];

  if (policy.approval === "autonomous") args.push("--dangerously-skip-permissions");
  const sandboxSettings = claudeSandbox(agent, policy.sandbox, policy.approval);
  if (sandboxSettings) args.push("--settings", JSON.stringify({ sandbox: sandboxSettings }));

  const selectedModel = model || agent.metadata?.model || settings.model;
  const selectedEffort = effort || agent.metadata?.effort || settings.effort;
  if (selectedModel) args.push("--model", String(selectedModel));
  if (selectedEffort) args.push("--effort", String(selectedEffort));
  if (agent.providerState?.sessionId) {
    args.push("--resume", String(agent.providerState.sessionId));
  } else {
    args.push("--session-id", sessionId);
  }
  if (policy.sandbox === "read_only") {
    args.push("--tools", READ_ONLY_AVAILABLE_TOOLS.join(","));
    args.push("--disallowed-tools", [...WRITE_TOOLS, "Bash"].join(","));
  }
  args.push("--", message);
  return args;
}

class LineBuffer {
  constructor() {
    this.buffer = "";
  }

  push(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";
    return lines.filter(Boolean);
  }

  flush() {
    const line = this.buffer;
    this.buffer = "";
    return line ? [line] : [];
  }
}

export class ClaudeCodeProvider {
  constructor({
    runtime = "auto",
    sdkLoader = defaultSdkLoader,
    settingsLoader = loadClaudeSettings,
    processFactory = spawn,
    syncRunner = spawnSync,
    cliBinary = "claude",
  } = {}) {
    this.runtime = runtime;
    this.sdkLoader = sdkLoader;
    this.settingsLoader = settingsLoader;
    this.processFactory = processFactory;
    this.syncRunner = syncRunner;
    this.cliBinary = cliBinary;
    this.capabilities = {
      multiTurn: true,
      stoppable: true,
      tools: true,
      writeAccess: true,
      interactiveRequests: true,
    };
  }

  availability() {
    const cli = this.syncRunner(this.cliBinary, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const sdk = resolveClaudeSdk();
    const settings = this.settingsLoader();
    return {
      available: cli.status === 0 || sdk.ok,
      cli: {
        available: cli.status === 0,
        version: cli.status === 0 ? String(cli.stdout || cli.stderr || "").trim() : undefined,
      },
      sdk: { available: sdk.ok, resolved: sdk.resolved },
      settings: {
        files: settings.files,
        baseUrl: settings.baseUrl,
        model: settings.model,
        effort: settings.effort,
        hasAuthToken: settings.hasAuthToken,
        hasApiKey: settings.hasApiKey,
      },
    };
  }

  async listModels({ cwd = process.cwd() } = {}) {
    const sdk = await this.sdkLoader();
    const settings = this.settingsLoader();
    let releaseInput;
    const inputClosed = new Promise((resolve) => {
      releaseInput = resolve;
    });
    const prompt = (async function* idleInput() {
      await inputClosed;
    })();
    const query = sdk.module.query({
      prompt,
      options: {
        cwd,
        env: settings.env,
        settingSources: ["user", "project", "local"],
        pathToClaudeCodeExecutable: this.cliBinary,
        permissionMode: "dontAsk",
        tools: [],
      },
    });
    try {
      const models = await query.supportedModels();
      return {
        provider: "claude-code",
        cwd,
        baseUrl: settings.baseUrl,
        configuredModel: settings.model,
        configuredEffort: settings.effort,
        models: models.map((model) => ({
          id: model.value,
          resolvedModel: model.resolvedModel,
          displayName: model.displayName,
          description: model.description,
          isDefault: model.value === "default",
          supportedEfforts: model.supportedEffortLevels || [],
          supportsAdaptiveThinking: Boolean(model.supportsAdaptiveThinking),
        })),
      };
    } finally {
      releaseInput();
      query.close();
    }
  }

  async send(context) {
    const policy = resolvePolicy({
      sandbox: context.sandbox,
      approval: context.approval,
      access: context.access,
    });
    const requestContext = { ...context, ...policy };
    const pinnedRuntime = context.agent.providerState?.runtime;
    const requestedRuntime = pinnedRuntime || context.agent.metadata?.runtime || this.runtime;

    if (requestedRuntime === "sdk") {
      return this.#sendSdk(requestContext, await this.sdkLoader());
    }
    if (requestedRuntime === "cli") {
      if (policy.approval === "on_request") {
        const error = new Error("Interactive Claude Code requests require the Agent SDK runtime");
        error.code = "CLAUDE_INTERACTION_REQUIRES_SDK";
        throw error;
      }
      return this.#sendCli(requestContext);
    }

    let sdk;
    try {
      sdk = await this.sdkLoader();
    } catch (sdkError) {
      if (pinnedRuntime) throw sdkError;
      if (policy.approval === "on_request") throw sdkError;
      return this.#sendCli(requestContext);
    }
    return this.#sendSdk(requestContext, sdk);
  }

  async #sendSdk({
    agent,
    message,
    sandbox,
    approval,
    model,
    effort,
    signal,
    onEvent,
    onProviderState,
    onRequest,
  }, sdk) {
    if (signal.aborted) throw abortError();
    const settings = this.settingsLoader();
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    signal.addEventListener("abort", abort, { once: true });
    const newSessionId = crypto.randomUUID();
    const options = sdkOptions({
      agent,
      sandbox,
      approval,
      model,
      effort,
      settings,
      abortController,
      sessionId: newSessionId,
      onRequest,
      cliBinary: this.cliBinary,
    });
    let sessionId = agent.providerState?.sessionId;
    let resultMessage;
    const textParts = [];

    try {
      const query = sdk.module.query({ prompt: message, options });
      for await (const event of query) {
        const observedSessionId = event.session_id || event.sessionId;
        if (observedSessionId && observedSessionId !== sessionId) {
          sessionId = observedSessionId;
          await onProviderState({
            runtime: "sdk",
            sessionId,
            sdkResolved: sdk.resolved,
          });
        }

        if (event.type === "assistant") {
          const text = assistantText(event);
          if (text) {
            textParts.push(text);
            await onEvent({ type: "assistant", text });
          }
        }
        if (event.type === "result") resultMessage = event;
      }
    } finally {
      signal.removeEventListener("abort", abort);
    }

    if (signal.aborted) throw abortError();
    if (resultMessage?.is_error || String(resultMessage?.subtype || "").startsWith("error")) {
      throw providerFailure(resultMessage);
    }

    sessionId = resultMessage?.session_id || sessionId || newSessionId;
    await onProviderState({ runtime: "sdk", sessionId, sdkResolved: sdk.resolved });
    return {
      output: resultMessage?.result || textParts.join("\n"),
      providerState: { runtime: "sdk", sessionId, sdkResolved: sdk.resolved },
      metadata: {
        model: Object.keys(resultMessage?.modelUsage || {})[0] || model || agent.metadata?.model || settings.model,
        effort: effort || agent.metadata?.effort || settings.effort,
        usage: resultMessage?.usage,
        modelUsage: resultMessage?.modelUsage,
        totalCostUsd: resultMessage?.total_cost_usd,
        durationMs: resultMessage?.duration_ms,
        subtype: resultMessage?.subtype,
      },
    };
  }

  async #sendCli({
    agent,
    message,
    sandbox,
    approval,
    model,
    effort,
    signal,
    onEvent,
    onProviderState,
  }) {
    if (signal.aborted) throw abortError();
    const settings = this.settingsLoader();
    const newSessionId = crypto.randomUUID();
    const args = buildClaudeCliArgs({
      agent,
      message,
      sandbox,
      approval,
      model,
      effort,
      settings,
      sessionId: newSessionId,
    });
    const child = this.processFactory(this.cliBinary, args, {
      cwd: agent.cwd,
      env: settings.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines = new LineBuffer();
    let stderr = "";
    let sessionId = agent.providerState?.sessionId;
    let resultMessage;
    let text = "";
    let eventQueue = Promise.resolve();

    const handleLine = async (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      const observedSessionId = event.session_id || event.sessionId;
      if (observedSessionId && observedSessionId !== sessionId) {
        sessionId = observedSessionId;
        await onProviderState({ runtime: "cli", sessionId });
      }

      const delta = event.event?.delta?.text;
      if (event.type === "stream_event" && typeof delta === "string") {
        text += delta;
        await onEvent({ type: "assistant_delta", text: delta });
      }
      if (event.type === "result") resultMessage = event;
    };

    child.stdout.on("data", (chunk) => {
      for (const line of lines.push(chunk.toString())) {
        eventQueue = eventQueue.then(() => handleLine(line));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const abort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", abort, { once: true });
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    signal.removeEventListener("abort", abort);
    for (const line of lines.flush()) eventQueue = eventQueue.then(() => handleLine(line));
    await eventQueue;

    if (signal.aborted) throw abortError();
    if (exitCode !== 0) {
      const error = new Error(stderr.trim() || `Claude Code exited with ${exitCode}`);
      error.code = "CLAUDE_CLI_FAILED";
      throw error;
    }
    if (resultMessage?.is_error || String(resultMessage?.subtype || "").startsWith("error")) {
      throw providerFailure(resultMessage);
    }

    sessionId = resultMessage?.session_id || sessionId || newSessionId;
    await onProviderState({ runtime: "cli", sessionId });
    return {
      output: resultMessage?.result || text,
      providerState: { runtime: "cli", sessionId },
      metadata: {
        model: model || agent.metadata?.model || settings.model,
        effort: effort || agent.metadata?.effort || settings.effort,
        usage: resultMessage?.usage,
        totalCostUsd: resultMessage?.total_cost_usd,
        durationMs: resultMessage?.duration_ms,
        subtype: resultMessage?.subtype,
      },
    };
  }
}
