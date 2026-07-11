import { spawn, spawnSync } from "node:child_process";

import { buildDelegationPrompt } from "../core/delegation-prompt.mjs";
import { abortError, AgentCallerError } from "../core/errors.mjs";
import { resolvePolicy } from "../core/policy.mjs";
import { CodexAppServerClient } from "./codex-app-server-client.mjs";

const ANTHROPIC_SECRET_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
];

export function codexProcessEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const key of ANTHROPIC_SECRET_KEYS) delete env[key];
  return env;
}

function codexSandbox(sandbox) {
  if (sandbox === "workspace_write") return "workspace-write";
  if (sandbox === "danger_full_access") return "danger-full-access";
  return "read-only";
}

function codexApproval(approval) {
  return approval === "on_request" ? "on-request" : "never";
}

export function buildCodexAppServerArgs() {
  return ["app-server", "--stdio"];
}

export function buildCodexThreadParams({ agent, sandbox, approval, model }) {
  const params = {
    cwd: agent.cwd,
    approvalPolicy: codexApproval(approval),
    sandbox: codexSandbox(sandbox),
    developerInstructions: buildDelegationPrompt({ agent, sandbox, approval }),
  };
  const selectedModel = model || agent.metadata?.model;
  if (selectedModel) params.model = String(selectedModel);
  if (agent.metadata?.skipGitCheck) {
    params.config = { skip_git_repo_check: true };
  }
  return params;
}

async function readCodexModels(client, cwd) {
  const [config, models] = await Promise.all([
    client.request("config/read", { cwd, includeLayers: false }),
    client.request("model/list", { limit: 100, includeHidden: false }),
  ]);
  return {
    configuredModel: config?.config?.model,
    configuredEffort: config?.config?.model_reasoning_effort,
    models: models?.data || [],
  };
}

async function selectCodexModel(client, agent, requestedModel) {
  const pinned = requestedModel || agent.metadata?.model;
  try {
    const catalog = await readCodexModels(client, agent.cwd);
    const selected = catalog.models.find((model) => model.id === pinned)
      || catalog.models.find((model) => model.id === catalog.configuredModel)
      || catalog.models.find((model) => model.isDefault)
      || catalog.models[0];
    return {
      model: pinned ? String(pinned) : selected?.id || catalog.configuredModel,
      effort: catalog.configuredEffort || selected?.defaultReasoningEffort,
      fallback: Boolean(
        !pinned &&
        catalog.configuredModel &&
        selected?.id &&
        catalog.configuredModel !== selected.id
      ),
      configuredAdvertised: Boolean(
        catalog.configuredModel &&
        catalog.models.some((entry) => entry.id === catalog.configuredModel)
      ),
      configured: catalog.configuredModel,
      configuredEffort: catalog.configuredEffort,
    };
  } catch {
    return { model: pinned ? String(pinned) : undefined };
  }
}

function publicCodexModelCatalog({ cwd, configuredModel, configuredEffort, models }) {
  const configuredEntry = models.find((model) => model.id === configuredModel);
  const selected = configuredEntry
    || models.find((model) => model.isDefault)
    || models[0];
  const publicModels = models.map((model) => ({
    id: model.id,
    resolvedModel: model.model,
    displayName: model.displayName,
    description: model.description,
    isDefault: Boolean(model.isDefault),
    isConfigured: model.id === configuredModel,
    advertised: true,
    defaultEffort: model.defaultReasoningEffort,
    supportedEfforts: (model.supportedReasoningEfforts || []).map(
      (option) => option.reasoningEffort,
    ),
    effortDescriptions: Object.fromEntries(
      (model.supportedReasoningEfforts || []).map(
        (option) => [option.reasoningEffort, option.description],
      ),
    ),
  }));
  if (configuredModel && !configuredEntry) {
    publicModels.unshift({
      id: configuredModel,
      resolvedModel: configuredModel,
      displayName: configuredModel,
      description: "Configured in Codex but not advertised by App Server model/list.",
      isDefault: false,
      isConfigured: true,
      advertised: false,
      defaultEffort: configuredEffort,
      supportedEfforts: configuredEffort ? [configuredEffort] : [],
      effortDescriptions: {},
    });
  }
  return {
    provider: "codex",
    cwd,
    configuredModel,
    configuredEffort,
    selectedModel: selected?.id || configuredModel,
    configuredModelAdvertised: Boolean(configuredEntry),
    modelFallbackRequired: Boolean(
      configuredModel && selected?.id && configuredModel !== selected.id
    ),
    models: publicModels,
  };
}

export async function inspectCodexModels({
  processFactory = spawn,
  cliBinary = "codex",
  cwd = process.cwd(),
} = {}) {
  const child = processFactory(cliBinary, ["app-server", "--stdio"], {
    cwd,
    env: codexProcessEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new CodexAppServerClient({
    child,
    onNotification: async () => {},
    onServerRequest: async (message) => {
      if (message.method === "currentTime/read") {
        return { currentTimeAt: Math.floor(Date.now() / 1000) };
      }
      throw new Error(`Unsupported model-catalog request: ${message.method}`);
    },
  });
  try {
    await client.initialize();
    return publicCodexModelCatalog({ cwd, ...await readCodexModels(client, cwd) });
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function inspectCodexAppServer({
  processFactory = spawn,
  cliBinary = "codex",
  cwd = process.cwd(),
} = {}) {
  const child = processFactory(cliBinary, ["app-server", "--stdio"], {
    cwd,
    env: codexProcessEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new CodexAppServerClient({
    child,
    onNotification: async () => {},
    onServerRequest: async (message) => {
      if (message.method === "currentTime/read") {
        return { currentTimeAt: Math.floor(Date.now() / 1000) };
      }
      throw new Error(`Unsupported diagnostic request: ${message.method}`);
    },
  });
  try {
    const initialized = await client.initialize();
    const selection = await selectCodexModel(client, {
      cwd,
      metadata: {},
      providerState: {},
    });
    return {
      available: true,
      codexHome: initialized.codexHome,
      model: selection.model,
      configuredModel: selection.configured,
      configuredModelAdvertised: selection.configuredAdvertised,
      modelFallbackRequired: selection.fallback,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function mapDecision(decision, available = []) {
  if (decision === "allow_session" && available.includes("acceptForSession")) {
    return "acceptForSession";
  }
  if (["allow_once", "allow_session"].includes(decision)) return "accept";
  if (decision === "cancel") return "cancel";
  return "decline";
}

function answerList(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function publicCodexQuestions(questions = []) {
  return questions.map((question) => ({
    id: question.id,
    header: question.header,
    question: question.question,
    options: question.options,
    isOther: Boolean(question.isOther),
    isSecret: Boolean(question.isSecret),
  }));
}

async function handleCodexRequest({ message, approval, onRequest }) {
  const { method, params } = message;
  if (method === "currentTime/read") {
    return { currentTimeAt: Math.floor(Date.now() / 1000) };
  }
  if (method === "item/commandExecution/requestApproval") {
    if (approval === "autonomous") return { decision: "accept" };
    if (approval !== "on_request") return { decision: "decline" };
    const available = params.availableDecisions || [];
    const result = await onRequest({
      kind: "command_approval",
      title: "Codex wants to run a command",
      description: params.reason,
      tool: "commandExecution",
      input: {
        command: params.command,
        cwd: params.cwd,
        commandActions: params.commandActions,
        networkApprovalContext: params.networkApprovalContext,
        additionalPermissions: params.additionalPermissions,
        proposedExecpolicyAmendment: params.proposedExecpolicyAmendment,
        proposedNetworkPolicyAmendments: params.proposedNetworkPolicyAmendments,
      },
      availableDecisions: ["allow_once", "allow_session", "deny", "cancel"],
      transport: { method, requestId: message.id },
    });
    return { decision: mapDecision(result.decision, available) };
  }

  if (method === "item/fileChange/requestApproval") {
    if (approval === "autonomous") return { decision: "accept" };
    if (approval !== "on_request") return { decision: "decline" };
    const result = await onRequest({
      kind: "file_change_approval",
      title: "Codex wants to change files",
      description: params.reason,
      tool: "fileChange",
      input: { grantRoot: params.grantRoot },
      availableDecisions: ["allow_once", "allow_session", "deny", "cancel"],
      transport: { method, requestId: message.id },
    });
    return { decision: mapDecision(result.decision) };
  }

  if (method === "item/tool/requestUserInput") {
    const questions = publicCodexQuestions(params.questions);
    const result = await onRequest({
      kind: "question",
      title: "Codex needs input",
      description: "The agent needs an answer before it can continue.",
      tool: "request_user_input",
      questions,
      sensitive: questions.some((question) => question.isSecret),
      transport: { method, requestId: message.id },
    });
    const answers = {};
    for (const question of questions) {
      answers[question.id] = { answers: answerList(result.answers?.[question.id]) };
    }
    return { answers };
  }

  if (method === "mcpServer/elicitation/request") {
    const result = await onRequest({
      kind: "elicitation",
      title: `${params.serverName} needs input`,
      description: params.message,
      input: {
        serverName: params.serverName,
        mode: params.mode,
        url: params.url,
        requestedSchema: params.requestedSchema,
      },
      availableDecisions: ["allow_once", "deny", "cancel"],
      transport: { method, requestId: message.id },
    });
    const action = result.decision === "cancel"
      ? "cancel"
      : result.decision === "deny"
        ? "decline"
        : "accept";
    return { action, content: action === "accept" ? result.response || result.answers || null : null, _meta: null };
  }

  if (method === "item/permissions/requestApproval") {
    if (approval === "autonomous") {
      return {
        permissions: {
          ...(params.permissions.network ? { network: params.permissions.network } : {}),
          ...(params.permissions.fileSystem ? { fileSystem: params.permissions.fileSystem } : {}),
        },
        scope: "session",
      };
    }
    if (approval !== "on_request") return { permissions: {}, scope: "turn" };
    const result = await onRequest({
      kind: "permission_approval",
      title: "Codex requests additional permissions",
      description: params.reason,
      input: {
        cwd: params.cwd,
        permissions: params.permissions,
      },
      availableDecisions: ["allow_once", "allow_session", "deny", "cancel"],
      transport: { method, requestId: message.id },
    });
    const allowed = ["allow_once", "allow_session"].includes(result.decision);
    return {
      permissions: allowed
        ? {
            ...(params.permissions.network ? { network: params.permissions.network } : {}),
            ...(params.permissions.fileSystem ? { fileSystem: params.permissions.fileSystem } : {}),
          }
        : {},
      scope: result.decision === "allow_session" ? "session" : "turn",
    };
  }

  throw new AgentCallerError(
    "CODEX_SERVER_REQUEST_UNSUPPORTED",
    `Unsupported Codex App Server request: ${method}`,
  );
}

function turnFailure(turn) {
  const error = new Error(turn?.error?.message || "Codex turn failed");
  error.code = turn?.error?.codexErrorInfo || "CODEX_TURN_FAILED";
  return error;
}

export class CodexProvider {
  constructor({
    processFactory = spawn,
    syncRunner = spawnSync,
    cliBinary = "codex",
  } = {}) {
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
    const result = this.syncRunner(this.cliBinary, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const appServer = this.syncRunner(this.cliBinary, ["app-server", "--help"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      available: result.status === 0 && appServer.status === 0,
      runtime: "app-server",
      appServerAvailable: appServer.status === 0,
      version: result.status === 0
        ? String(result.stdout || result.stderr || "").trim()
        : undefined,
    };
  }

  async send({
    agent,
    message,
    sandbox,
    approval,
    access,
    model,
    effort,
    signal,
    onEvent,
    onProviderState,
    onRequest,
  }) {
    if (signal.aborted) throw abortError();
    const policy = resolvePolicy({ sandbox, approval, access });
    let turnId;
    let completedTurn;
    let output = "";
    let completedMessage = "";
    let resolveTurn;
    const turnDone = new Promise((resolve) => {
      resolveTurn = resolve;
    });

    const child = this.processFactory(this.cliBinary, buildCodexAppServerArgs(), {
      cwd: agent.cwd,
      env: codexProcessEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = new CodexAppServerClient({
      child,
      onServerRequest: (serverRequest) => handleCodexRequest({
        message: serverRequest,
        approval: policy.approval,
        onRequest,
      }),
      onNotification: async (notification) => {
        const params = notification.params || {};
        if (notification.method === "item/agentMessage/delta" && params.turnId === turnId) {
          const delta = String(params.delta || "");
          output += delta;
          if (delta) await onEvent({ type: "assistant_delta", text: delta });
        }
        if (
          notification.method === "item/completed" &&
          params.turnId === turnId &&
          params.item?.type === "agentMessage"
        ) {
          completedMessage = String(params.item.text || "");
        }
        if (notification.method === "turn/completed" && params.turn?.id === turnId) {
          completedTurn = params.turn;
          resolveTurn(params.turn);
        }
      },
    });

    const abort = () => client.terminate();
    signal.addEventListener("abort", abort, { once: true });
    try {
      await client.initialize();
      const modelSelection = await selectCodexModel(client, agent, model);
      const selectedEffort = effort || agent.metadata?.effort || modelSelection.effort;
      const threadParams = buildCodexThreadParams({
        agent,
        ...policy,
        model: modelSelection.model,
      });
      let threadResponse;
      if (agent.providerState?.threadId) {
        threadResponse = await client.request("thread/resume", {
          threadId: agent.providerState.threadId,
          ...threadParams,
          excludeTurns: true,
        });
      } else {
        threadResponse = await client.request("thread/start", threadParams);
      }
      const threadId = threadResponse?.thread?.id;
      if (!threadId) {
        throw new AgentCallerError("CODEX_THREAD_MISSING", "Codex App Server did not return a thread ID");
      }
      await onProviderState({
        runtime: "app-server",
        threadId,
        model: threadResponse.model || modelSelection.model,
        effort: selectedEffort || threadResponse.reasoningEffort,
      });

      const turnResponse = await client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: message, text_elements: [] }],
        cwd: agent.cwd,
        model: modelSelection.model,
        effort: selectedEffort,
        approvalPolicy: codexApproval(policy.approval),
        sandboxPolicy:
          policy.sandbox === "danger_full_access"
            ? { type: "dangerFullAccess" }
            : policy.sandbox === "workspace_write"
              ? {
                  type: "workspaceWrite",
                  writableRoots: [agent.cwd],
                  networkAccess: false,
                  excludeTmpdirEnvVar: false,
                  excludeSlashTmp: false,
                }
              : { type: "readOnly", networkAccess: false },
      });
      turnId = turnResponse?.turn?.id;
      if (!turnId) throw new AgentCallerError("CODEX_TURN_MISSING", "Codex did not start a turn");

      await Promise.race([
        turnDone,
        client.closed.then(({ code, signal: exitSignal }) => {
          if (signal.aborted) throw abortError();
          if (!completedTurn) {
            throw new AgentCallerError(
              "CODEX_APP_SERVER_EXITED",
              client.stderr.trim() || `Codex App Server exited (${code ?? exitSignal})`,
            );
          }
        }),
      ]);
      if (signal.aborted) throw abortError();
      if (completedTurn?.status === "failed") throw turnFailure(completedTurn);
      if (completedTurn?.status === "interrupted") throw abortError("Codex turn interrupted");

      const providerState = {
        runtime: "app-server",
        threadId,
        model: threadResponse.model || modelSelection.model,
        effort: selectedEffort || threadResponse.reasoningEffort,
      };
      return {
        output: completedMessage || output,
        providerState,
        metadata: {
          turnId,
          model: threadResponse.model || modelSelection.model,
          effort: selectedEffort || threadResponse.reasoningEffort,
          durationMs: completedTurn?.durationMs,
          status: completedTurn?.status,
          modelFallback: modelSelection.fallback
            ? { configured: modelSelection.configured, selected: modelSelection.model }
            : undefined,
          configuredModelAdvertised: modelSelection.configured
            ? modelSelection.configuredAdvertised
            : undefined,
        },
      };
    } finally {
      signal.removeEventListener("abort", abort);
      await client.close().catch(() => undefined);
    }
  }

  async listModels({ cwd = process.cwd() } = {}) {
    return inspectCodexModels({
      processFactory: this.processFactory,
      cliBinary: this.cliBinary,
      cwd,
    });
  }
}
