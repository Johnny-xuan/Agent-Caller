import path from "node:path";

import { AgentCallerError, isAbortError } from "./errors.mjs";
import { makeId, timestamp } from "./ids.mjs";
import { KeyedLock } from "./keyed-lock.mjs";
import {
  assertPolicyWithin,
  normalizePersistedAgent,
  resolveAgentPolicy,
  resolvePolicy,
} from "./policy.mjs";
import {
  agentInScope,
  normalizePersistedAgentScope,
  normalizeScope,
  resolveWorkspaceRoot,
  scopeContext,
} from "./scope.mjs";

function normalizeAgent(agent) {
  return normalizePersistedAgentScope(normalizePersistedAgent(agent));
}

function requireText(value, field, maxLength = 100_000) {
  const text = String(value || "").trim();
  if (!text) throw new AgentCallerError("INVALID_INPUT", `${field} is required`);
  if (text.length > maxLength) {
    throw new AgentCallerError("INVALID_INPUT", `${field} exceeds ${maxLength} characters`);
  }
  return text;
}

function optionalText(value, field, maxLength) {
  return value === undefined || value === null
    ? undefined
    : requireText(value, field, maxLength);
}

function deferred() {
  let resolve;
  let reject;
  let settled = false;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = (value) => {
      if (settled) return false;
      settled = true;
      resolvePromise(value);
      return true;
    };
    reject = (error) => {
      if (settled) return false;
      settled = true;
      rejectPromise(error);
      return true;
    };
  });
  return {
    promise,
    resolve,
    reject,
    get settled() {
      return settled;
    },
  };
}

function publicError(error) {
  return {
    code: error.code || "PROVIDER_ERROR",
    message: error.message || String(error),
  };
}

export class AgentService {
  #activeRuns = new Map();
  #pendingResponses = new Map();
  #locks = new KeyedLock();

  constructor({ store, providers, clock = () => new Date() }) {
    this.store = store;
    this.providers = providers instanceof Map ? providers : new Map(Object.entries(providers || {}));
    this.clock = clock;
  }

  now() {
    return timestamp(this.clock);
  }

  async init() {
    await this.store.init();
    for (const agent of await this.store.listAgents()) {
      const normalized = normalizeAgent(agent);
      if (JSON.stringify(normalized) !== JSON.stringify(agent)) {
        await this.store.updateAgent(normalized);
      }
    }
    return this.store.recoverInterrupted(this.now());
  }

  async createAgent({
    name,
    provider,
    role = "General-purpose coding agent",
    cwd,
    scope,
    profile,
    sandbox,
    approval,
    access,
    metadata = {},
  }) {
    return this.#locks.withKey("__agent_names__", async () => {
      const cleanName = requireText(name, "name", 80);
      const cleanProvider = requireText(provider, "provider", 80);
      const cleanCwd = path.resolve(cwd || process.cwd());
      const cleanScope = normalizeScope(scope);
      const workspaceRoot = cleanScope === "project" ? resolveWorkspaceRoot(cleanCwd) : null;
      const providerAdapter = this.providers.get(cleanProvider);
      if (!providerAdapter) {
        throw new AgentCallerError("PROVIDER_NOT_FOUND", `Unknown provider: ${cleanProvider}`);
      }

      const duplicate = (await this.store.listAgents()).map(normalizeAgent).find(
        (agent) =>
          agent.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase() &&
          agent.scope === cleanScope &&
          agent.workspaceRoot === workspaceRoot,
      );
      if (duplicate) {
        throw new AgentCallerError("AGENT_NAME_EXISTS", `Agent name already exists: ${cleanName}`);
      }

      const now = this.now();
      const policy = resolveAgentPolicy({ profile, sandbox, approval, access });
      const agent = {
        id: makeId("agt"),
        name: cleanName,
        provider: cleanProvider,
        role: requireText(role, "role", 20_000),
        cwd: cleanCwd,
        scope: cleanScope,
        workspaceRoot,
        ...policy,
        status: "ready",
        activeRunId: null,
        lastRunId: null,
        providerState: {},
        capabilities: providerAdapter.capabilities || {},
        metadata: metadata && typeof metadata === "object" ? metadata : {},
        createdAt: now,
        updatedAt: now,
      };
      return this.store.createAgent(agent);
    });
  }

  async listAgents(context) {
    const agents = (await this.store.listAgents()).map(normalizeAgent);
    if (!context) return agents;
    const normalizedContext = scopeContext(context);
    return agents.filter((agent) => agentInScope(agent, normalizedContext));
  }

  async #resolveAgent(reference, context) {
    if (!context) return normalizeAgent(await this.store.resolveAgent(reference));

    const value = String(reference || "").trim();
    if (!value) {
      throw new AgentCallerError("AGENT_REQUIRED", "Agent ID or name is required");
    }
    const normalizedContext = scopeContext(context);
    let candidates;
    if (/^agt_[A-Za-z0-9_-]+$/.test(value)) {
      const byId = await this.store.getAgentById(value);
      candidates = byId ? [normalizeAgent(byId)] : [];
    } else {
      const normalizedName = value.toLocaleLowerCase();
      candidates = (await this.store.listAgents())
        .map(normalizeAgent)
        .filter((agent) => agent.name.toLocaleLowerCase() === normalizedName);
    }
    const matches = candidates.filter((agent) => agentInScope(agent, normalizedContext));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new AgentCallerError("AGENT_AMBIGUOUS", `Agent name is ambiguous: ${value}`);
    }
    throw new AgentCallerError("AGENT_NOT_FOUND", `Unknown agent: ${value}`);
  }

  async getAgent(reference, context) {
    const agent = await this.#resolveAgent(reference, context);
    const currentRun = agent.activeRunId
      ? await this.store.getRun(agent.id, agent.activeRunId)
      : undefined;
    const lastRun = agent.lastRunId
      ? await this.store.getRun(agent.id, agent.lastRunId)
      : undefined;
    const pendingRequests = (await this.store.listRequests(agent.id)).filter(
      (request) => request.status === "pending",
    );
    return { agent, currentRun, lastRun, pendingRequests };
  }

  async getHistory(reference, context) {
    const agent = await this.#resolveAgent(reference, context);
    return {
      agent,
      messages: await this.store.listMessages(agent.id),
      runs: await this.store.listRuns(agent.id),
      requests: await this.store.listRequests(agent.id),
    };
  }

  async startRun({
    agent: reference,
    message,
    sandbox,
    approval,
    access,
    model,
    effort,
    scope,
    contextCwd,
  }) {
    const context = contextCwd ? { scope, cwd: contextCwd } : undefined;
    const initialAgent = await this.#resolveAgent(reference, context);
    const cleanMessage = requireText(message, "message");
    const now = this.now();
    const runId = makeId("run");
    const userMessageId = makeId("msg");
    let runningAgent;
    let runningRun;

    const claim = await this.store.claimAgent(initialAgent.id, runId);
    try {
      await this.#locks.withKey(initialAgent.id, async () => {
        const agent = normalizeAgent(await this.store.resolveAgent(initialAgent.id));
        if (["running", "waiting_for_input"].includes(agent.status) || agent.activeRunId) {
          throw new AgentCallerError(
            "AGENT_BUSY",
            `Agent ${agent.name} is already running ${agent.activeRunId || "another task"}`,
          );
        }
        if (agent.status === "stopped" || agent.status === "inactive") {
          throw new AgentCallerError(
            "AGENT_NOT_READY",
            `Agent ${agent.name} must be resumed before receiving another message`,
          );
        }

        const runPolicy = assertPolicyWithin(agent, resolvePolicy({
          sandbox: sandbox || (access ? undefined : agent.sandbox),
          approval: approval || agent.approval,
          access,
        }));
        const runModel = optionalText(model, "model", 200) || agent.metadata?.model;
        const runEffort = optionalText(effort, "effort", 80) || agent.metadata?.effort;
        runningRun = {
          id: runId,
          agentId: agent.id,
          provider: agent.provider,
          status: "queued",
          ...runPolicy,
          model: runModel || null,
          effort: runEffort || null,
          ownerPid: process.pid,
          ownerToken: claim.ownerToken,
          requestMessageId: userMessageId,
          responseMessageId: null,
          output: "",
          error: null,
          pendingRequestIds: [],
          createdAt: now,
          startedAt: null,
          finishedAt: null,
          updatedAt: now,
        };
        await this.store.createRun(runningRun);
        await this.store.appendMessage(agent.id, {
          id: userMessageId,
          agentId: agent.id,
          runId,
          role: "user",
          content: cleanMessage,
          createdAt: now,
        });

        runningRun = {
          ...runningRun,
          status: "running",
          startedAt: now,
          updatedAt: now,
        };
        await this.store.updateRun(runningRun);
        runningAgent = {
          ...agent,
          status: "running",
          activeRunId: runId,
          lastRunId: runId,
          updatedAt: now,
        };
        await this.store.updateAgent(runningAgent);
      });
    } catch (error) {
      await this.store.releaseAgentClaim(initialAgent.id, runId);
      throw error;
    }

    const controller = new AbortController();
    const attention = deferred();
    const completion = Promise.resolve().then(() =>
      this.#executeRun({
        agent: runningAgent,
        run: runningRun,
        message: cleanMessage,
        controller,
      }),
    );
    this.#activeRuns.set(runId, {
      agentId: runningAgent.id,
      controller,
      completion,
      attention,
    });

    return { run: runningRun, completion };
  }

  async sendMessage(input) {
    const { run, completion } = await this.startRun(input);
    return this.#waitForRunProgress(run.id, completion);
  }

  async #executeRun({ agent, run, message, controller }) {
    const provider = this.providers.get(agent.provider);
    let partialOutput = "";
    const onEvent = async (providerEvent) => {
      const event = {
        id: makeId("evt"),
        agentId: agent.id,
        runId: run.id,
        createdAt: this.now(),
        ...providerEvent,
      };
      if (typeof providerEvent.text === "string") partialOutput += providerEvent.text;
      await this.store.appendEvent(agent.id, run.id, event);
    };
    const onProviderState = async (patch) => {
      if (!patch || typeof patch !== "object") return;
      await this.#locks.withKey(agent.id, async () => {
        const latestAgent = await this.store.resolveAgent(agent.id);
        await this.store.updateAgent({
          ...latestAgent,
          providerState: {
            ...(latestAgent.providerState || {}),
            ...patch,
          },
          updatedAt: this.now(),
        });
      });
    };
    const onRequest = async (providerRequest) =>
      this.#openRequest({ agent, run, providerRequest, controller });

    try {
      const result = await provider.send({
        agent,
        message,
        sandbox: run.sandbox,
        approval: run.approval,
        model: run.model || undefined,
        effort: run.effort || undefined,
        signal: controller.signal,
        onEvent,
        onProviderState,
        onRequest,
      });
      const output = String(result?.output ?? partialOutput ?? "");
      const finishedAt = this.now();
      const responseMessage = {
        id: makeId("msg"),
        agentId: agent.id,
        runId: run.id,
        role: "assistant",
        content: output,
        createdAt: finishedAt,
      };
      await this.store.appendMessage(agent.id, responseMessage);

      let completedRun;
      let completedAgent;
      await this.#locks.withKey(agent.id, async () => {
        const latestRun = (await this.store.getRun(agent.id, run.id)) || run;
        completedRun = {
          ...latestRun,
          status: "completed",
          responseMessageId: responseMessage.id,
          output,
          providerMetadata: result?.metadata || {},
          pendingRequestIds: [],
          finishedAt,
          updatedAt: finishedAt,
        };
        await this.store.updateRun(completedRun);
        const latestAgent = await this.store.resolveAgent(agent.id);
        completedAgent = {
          ...latestAgent,
          status: "ready",
          activeRunId: null,
          providerState: {
            ...(latestAgent.providerState || {}),
            ...(result?.providerState || {}),
          },
          updatedAt: finishedAt,
        };
        await this.store.updateAgent(completedAgent);
      });
      return { agent: completedAgent, run: completedRun };
    } catch (error) {
      const stopped = controller.signal.aborted || isAbortError(error);
      const finishedAt = this.now();
      let responseMessageId = null;
      if (partialOutput) {
        const responseMessage = {
          id: makeId("msg"),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: partialOutput,
          partial: true,
          createdAt: finishedAt,
        };
        await this.store.appendMessage(agent.id, responseMessage);
        responseMessageId = responseMessage.id;
      }

      let failedRun;
      let failedAgent;
      await this.#locks.withKey(agent.id, async () => {
        const latestRun = (await this.store.getRun(agent.id, run.id)) || run;
        failedRun = {
          ...latestRun,
          status: stopped ? "stopped" : "failed",
          responseMessageId,
          output: partialOutput,
          error: publicError(error),
          pendingRequestIds: [],
          finishedAt,
          updatedAt: finishedAt,
        };
        await this.store.updateRun(failedRun);
        const latestAgent = await this.store.resolveAgent(agent.id);
        failedAgent = {
          ...latestAgent,
          status: stopped ? "stopped" : "ready",
          activeRunId: null,
          updatedAt: finishedAt,
        };
        await this.store.updateAgent(failedAgent);
      });
      return { agent: failedAgent, run: failedRun };
    } finally {
      await this.#expireRunRequests(run.id, controller.signal.aborted ? "cancelled" : "expired");
      this.#activeRuns.delete(run.id);
      await this.store.releaseAgentClaim(agent.id, run.id).catch(() => undefined);
    }
  }

  async #snapshotRun(runId) {
    const found = await this.store.findRun(runId);
    if (!found) throw new AgentCallerError("RUN_NOT_FOUND", `Unknown run: ${runId}`);
    const requests = (await this.store.listRequests(found.agent.id)).filter(
      (request) => request.runId === runId && request.status === "pending",
    );
    return {
      agent: normalizeAgent(found.agent),
      run: found.run,
      pendingRequests: requests,
    };
  }

  async #waitForRunProgress(runId, knownCompletion) {
    const snapshot = await this.#snapshotRun(runId);
    if (snapshot.pendingRequests.length || !["queued", "running", "waiting_for_input"].includes(snapshot.run.status)) {
      return snapshot;
    }
    const active = this.#activeRuns.get(runId);
    if (!active) return snapshot;
    const completion = knownCompletion || active.completion;
    return Promise.race([
      completion.then(() => this.#snapshotRun(runId)),
      active.attention.promise.then(() => this.#snapshotRun(runId)),
    ]);
  }

  async #openRequest({ agent, run, providerRequest, controller }) {
    if (controller.signal.aborted) throw new AgentCallerError("RUN_STOPPED", "Run stopped");
    const active = this.#activeRuns.get(run.id);
    if (!active) throw new AgentCallerError("RUN_NOT_ACTIVE", `Run is no longer active: ${run.id}`);

    const now = this.now();
    const request = {
      id: makeId("req"),
      agentId: agent.id,
      runId: run.id,
      provider: agent.provider,
      status: "pending",
      kind: requireText(providerRequest?.kind, "request kind", 80),
      title: providerRequest?.title ? String(providerRequest.title) : undefined,
      description: providerRequest?.description ? String(providerRequest.description) : undefined,
      tool: providerRequest?.tool ? String(providerRequest.tool) : undefined,
      input: providerRequest?.input,
      questions: providerRequest?.questions,
      availableDecisions: providerRequest?.availableDecisions,
      sensitive: Boolean(providerRequest?.sensitive),
      transport: providerRequest?.transport,
      resolution: null,
      createdAt: now,
      resolvedAt: null,
      updatedAt: now,
    };
    await this.store.createRequest(request);

    await this.#locks.withKey(agent.id, async () => {
      const latestRun = await this.store.getRun(agent.id, run.id);
      const pendingRequestIds = Array.from(
        new Set([...(latestRun.pendingRequestIds || []), request.id]),
      );
      await this.store.updateRun({
        ...latestRun,
        status: "waiting_for_input",
        pendingRequestIds,
        updatedAt: now,
      });
      const latestAgent = await this.store.resolveAgent(agent.id);
      await this.store.updateAgent({
        ...latestAgent,
        status: "waiting_for_input",
        updatedAt: now,
      });
    });
    await this.store.appendEvent(agent.id, run.id, {
      id: makeId("evt"),
      agentId: agent.id,
      runId: run.id,
      type: "request_opened",
      requestId: request.id,
      kind: request.kind,
      createdAt: now,
    });

    const response = deferred();
    const abort = () => {
      void this.#locks.withKey(agent.id, async () => {
        response.reject(new AgentCallerError("RUN_STOPPED", "Run stopped"));
      });
    };
    controller.signal.addEventListener("abort", abort, { once: true });
    this.#pendingResponses.set(request.id, {
      agentId: agent.id,
      runId: run.id,
      response,
      abort,
      signal: controller.signal,
    });
    active.attention.resolve(request);

    try {
      return await response.promise;
    } finally {
      controller.signal.removeEventListener("abort", abort);
      this.#pendingResponses.delete(request.id);
    }
  }

  async #expireRunRequests(runId, status) {
    const found = await this.store.findRun(runId);
    if (!found) return;
    const now = this.now();
    for (const request of await this.store.listRequests(found.agent.id)) {
      if (request.runId !== runId || request.status !== "pending") continue;
      await this.store.updateRequest({
        ...request,
        status,
        resolution: { code: "RUN_ENDED", message: `Request ${status} when its Run ended` },
        resolvedAt: now,
        updatedAt: now,
      });
    }
  }

  async respondToRequest({
    requestId,
    decision,
    answers,
    response,
    wait = true,
    scope,
    contextCwd,
  }) {
    const cleanRequestId = requireText(requestId, "requestId", 128);
    const found = await this.store.findRequest(cleanRequestId);
    if (!found) {
      throw new AgentCallerError("REQUEST_NOT_FOUND", `Unknown request: ${cleanRequestId}`);
    }
    if (contextCwd) {
      await this.#resolveAgent(found.agent.id, { scope, cwd: contextCwd });
    }
    if (found.request.status !== "pending") {
      throw new AgentCallerError(
        "REQUEST_ALREADY_RESOLVED",
        `Request ${cleanRequestId} is ${found.request.status}`,
      );
    }
    if (
      !this.#pendingResponses.has(cleanRequestId) ||
      !this.#activeRuns.has(found.request.runId)
    ) {
      throw new AgentCallerError(
        "REQUEST_NOT_ACTIVE",
        "The provider callback is no longer active; resume the agent with a new message",
      );
    }

    const providerResponse = { decision, answers, response };
    if (!decision && !answers && response === undefined) {
      throw new AgentCallerError(
        "REQUEST_RESPONSE_REQUIRED",
        "decision, answers, or response is required",
      );
    }
    const now = this.now();
    const persistedAnswers = found.request.sensitive && answers
      ? Object.fromEntries(Object.keys(answers).map((key) => [key, "[REDACTED]"]))
      : answers;
    let resolvedRequest;
    let active;
    await this.#locks.withKey(found.agent.id, async () => {
      const current = await this.store.getRequest(found.agent.id, cleanRequestId);
      const pending = this.#pendingResponses.get(cleanRequestId);
      active = this.#activeRuns.get(found.request.runId);
      if (
        current?.status !== "pending" ||
        !pending ||
        pending.response.settled ||
        !active ||
        active.controller.signal.aborted
      ) {
        throw new AgentCallerError(
          "REQUEST_NOT_ACTIVE",
          "The provider callback expired before the response could be delivered",
        );
      }

      resolvedRequest = {
        ...current,
        status: decision === "cancel" ? "cancelled" : "resolved",
        resolution: {
          decision,
          answers: persistedAnswers,
          response: current.sensitive && response !== undefined ? "[REDACTED]" : response,
        },
        resolvedAt: now,
        updatedAt: now,
      };
      await this.store.updateRequest(resolvedRequest);
      const latestRun = await this.store.getRun(found.agent.id, found.request.runId);
      const pendingRequestIds = (latestRun.pendingRequestIds || []).filter(
        (id) => id !== cleanRequestId,
      );
      const stillPending = (await this.store.listRequests(found.agent.id)).some(
        (request) =>
          request.runId === found.request.runId &&
          request.id !== cleanRequestId &&
          request.status === "pending",
      );
      await this.store.updateRun({
        ...latestRun,
        status: stillPending ? "waiting_for_input" : "running",
        pendingRequestIds,
        updatedAt: now,
      });
      const latestAgent = await this.store.resolveAgent(found.agent.id);
      await this.store.updateAgent({
        ...latestAgent,
        status: stillPending ? "waiting_for_input" : "running",
        updatedAt: now,
      });
      active.attention = deferred();
      if (!pending.response.resolve(providerResponse)) {
        throw new AgentCallerError(
          "REQUEST_NOT_ACTIVE",
          "The provider callback expired before the response could be delivered",
        );
      }
    });
    await this.store.appendEvent(found.agent.id, found.request.runId, {
      id: makeId("evt"),
      agentId: found.agent.id,
      runId: found.request.runId,
      type: "request_resolved",
      requestId: cleanRequestId,
      decision,
      createdAt: now,
    });

    if (!wait) {
      return { ...(await this.#snapshotRun(found.request.runId)), request: resolvedRequest };
    }
    const result = await this.#waitForRunProgress(found.request.runId, active.completion);
    return { ...result, request: resolvedRequest };
  }

  async getRun(runId, context) {
    const found = await this.store.findRun(runId);
    if (!found) throw new AgentCallerError("RUN_NOT_FOUND", `Unknown run: ${runId}`);
    if (context) await this.#resolveAgent(found.agent.id, context);
    return {
      agent: normalizeAgent(found.agent),
      run: found.run,
      events: await this.store.listEvents(found.agent.id, runId),
      requests: (await this.store.listRequests(found.agent.id)).filter(
        (request) => request.runId === runId,
      ),
    };
  }

  async stopRun({ runId, agent: agentReference, scope, contextCwd }) {
    const context = contextCwd ? { scope, cwd: contextCwd } : undefined;
    let found;
    if (runId) {
      found = await this.store.findRun(runId);
      if (found && context) await this.#resolveAgent(found.agent.id, context);
    }
    else if (agentReference) {
      const agent = await this.#resolveAgent(agentReference, context);
      if (!agent.activeRunId) {
        throw new AgentCallerError("RUN_NOT_ACTIVE", `Agent ${agent.name} has no active run`);
      }
      found = { agent, run: await this.store.getRun(agent.id, agent.activeRunId) };
    } else {
      throw new AgentCallerError("RUN_REQUIRED", "runId or agent is required");
    }
    if (!found?.run) throw new AgentCallerError("RUN_NOT_FOUND", `Unknown run: ${runId}`);

    const active = this.#activeRuns.get(found.run.id);
    if (active) {
      active.controller.abort();
      return active.completion;
    }

    if (!["queued", "running", "waiting_for_input"].includes(found.run.status)) {
      return { agent: found.agent, run: found.run };
    }
    const claim = await this.store.getAgentClaim(found.agent.id);
    if (this.store.runOwnerAlive(found.run, claim)) {
      throw new AgentCallerError(
        "RUN_OWNED_BY_ANOTHER_PROCESS",
        "The active run belongs to another Agent Caller process",
      );
    }

    const now = this.now();
    const stoppedRun = {
      ...found.run,
      status: "stopped",
      pendingRequestIds: [],
      finishedAt: now,
      updatedAt: now,
      error: { code: "RUN_STOPPED", message: "Run stopped" },
    };
    await this.store.updateRun(stoppedRun);
    const stoppedAgent = {
      ...found.agent,
      status: "stopped",
      activeRunId: null,
      updatedAt: now,
    };
    await this.store.updateAgent(stoppedAgent);
    await this.#expireRunRequests(found.run.id, "cancelled");
    await this.store.releaseAgentClaim(found.agent.id, found.run.id);
    return { agent: stoppedAgent, run: stoppedRun };
  }

  async resumeAgent(reference, context) {
    const agent = await this.#resolveAgent(reference, context);
    if (["running", "waiting_for_input"].includes(agent.status)) {
      throw new AgentCallerError("AGENT_BUSY", `Agent ${agent.name} is still running`);
    }
    if (agent.status === "ready") return agent;

    const resumed = {
      ...agent,
      status: "ready",
      activeRunId: null,
      updatedAt: this.now(),
    };
    await this.store.updateAgent(resumed);
    return resumed;
  }

  async releaseAgent(reference, context) {
    const initialAgent = await this.#resolveAgent(reference, context);
    return this.#locks.withKey(initialAgent.id, async () => {
      const agent = await this.store.resolveAgent(initialAgent.id);
      if (["running", "waiting_for_input"].includes(agent.status) || agent.activeRunId) {
        throw new AgentCallerError(
          "AGENT_BUSY",
          `Stop agent ${agent.name} before releasing it`,
        );
      }
      if (agent.status === "inactive") return agent;

      const released = {
        ...agent,
        status: "inactive",
        activeRunId: null,
        updatedAt: this.now(),
      };
      await this.store.updateAgent(released);
      return released;
    });
  }

  async deleteAgent(reference, context) {
    return this.#locks.withKey("__agent_names__", async () => {
      const agent = await this.#resolveAgent(reference, context);
      if (["running", "waiting_for_input"].includes(agent.status) || agent.activeRunId) {
        throw new AgentCallerError(
          "AGENT_BUSY",
          `Stop agent ${agent.name} before deleting it`,
        );
      }
      await this.store.deleteAgent(agent.id);
      return { id: agent.id, name: agent.name, deleted: true };
    });
  }

  async shutdown() {
    const active = [...this.#activeRuns.values()];
    for (const entry of active) entry.controller.abort();
    await Promise.allSettled(active.map((entry) => entry.completion));
  }
}
