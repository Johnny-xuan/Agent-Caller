import { AgentCallerError } from "../core/errors.mjs";

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

function objectSchema(properties, required = []) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

const agentReference = {
  type: "string",
  minLength: 1,
  description: "Stable Agent Caller ID or unique agent name.",
};

const scopeProperty = {
  type: "string",
  enum: ["project", "global"],
  default: "project",
  description: "Agent namespace. Defaults to the caller's opened Workspace; global must be explicit.",
};

const callerCwdProperty = {
  type: "string",
  minLength: 1,
  description:
    "Current opened Workspace path used to enforce Agent scope. It does not change the Agent's working directory.",
};

export const TOOL_DEFINITIONS = [
  {
    name: "create_agent",
    title: "Create Durable Agent",
    description:
      "Create a durable Claude Code or Codex team member with its own role, trust profile, context, working directory, and recoverable provider conversation. Defaults to the trusted profile for autonomous local coding work.",
    inputSchema: objectSchema(
      {
        name: { type: "string", minLength: 1, maxLength: 80 },
        provider: { type: "string", enum: ["claude-code", "codex"] },
        role: { type: "string", minLength: 1, maxLength: 20_000 },
        cwd: { type: "string", minLength: 1 },
        scope: scopeProperty,
        profile: {
          type: "string",
          enum: ["trusted", "guarded", "observer"],
          default: "trusted",
          description:
            "Named authority profile. Defaults to trusted; guarded pauses for approvals and observer is read-only.",
        },
        sandbox: {
          type: "string",
          enum: ["read_only", "workspace_write", "danger_full_access"],
          description: "Advanced maximum-resource override for the selected profile.",
        },
        approval: {
          type: "string",
          enum: ["fail_closed", "on_request", "autonomous"],
          description:
            "Advanced approval-behavior override for the selected profile.",
        },
        model: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Persistent provider model ID. Use list_models first.",
        },
        effort: {
          type: "string",
          minLength: 1,
          maxLength: 80,
          description: "Persistent provider-defined reasoning effort. Use list_models first.",
        },
        runtime: { type: "string", enum: ["auto", "sdk", "cli"] },
        skip_git_check: { type: "boolean" },
      },
      ["name", "provider", "role", "cwd"],
    ),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "send_message",
    title: "Message Durable Agent",
    description:
      "Send one new turn to an existing agent, optionally selecting a Run-only authority profile. Wait for the reply by default, or return the persisted running Run immediately for parallel work.",
    inputSchema: objectSchema(
      {
        agent: agentReference,
        message: { type: "string", minLength: 1, maxLength: 100_000 },
        cwd: callerCwdProperty,
        scope: scopeProperty,
        profile: {
          type: "string",
          enum: ["trusted", "guarded", "observer"],
          description:
            "Optional authority profile for this Run. When omitted, the Agent's default profile is used.",
        },
        sandbox: {
          type: "string",
          enum: ["read_only", "workspace_write", "danger_full_access"],
          description: "Advanced sandbox override for this Run's selected profile.",
        },
        approval: {
          type: "string",
          enum: ["fail_closed", "on_request", "autonomous"],
          description: "Advanced approval override for this Run's selected profile.",
        },
        model: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Optional model override for this Run. Use list_models first.",
        },
        effort: {
          type: "string",
          minLength: 1,
          maxLength: 80,
          description: "Optional provider-defined effort override for this Run.",
        },
        wait: { type: "boolean", default: true },
      },
      ["agent", "message", "cwd"],
    ),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "respond_to_request",
    title: "Respond To Agent Request",
    description:
      "Approve, deny, cancel, or answer a pending request, then wait by default for the Run to finish or ask again.",
    inputSchema: objectSchema(
      {
        request_id: { type: "string", minLength: 1 },
        cwd: callerCwdProperty,
        scope: scopeProperty,
        decision: {
          type: "string",
          enum: ["allow_once", "allow_session", "deny", "cancel"],
        },
        answers: {
          type: "object",
          additionalProperties: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
          },
        },
        response: {
          description: "Opaque structured response for a provider dialog or elicitation.",
        },
        wait: { type: "boolean", default: true },
      },
      ["request_id", "cwd"],
    ),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "get_agent",
    title: "Get Agent Status",
    description: "Inspect one agent plus its current and most recent Run.",
    inputSchema: objectSchema(
      { agent: agentReference, cwd: callerCwdProperty, scope: scopeProperty },
      ["agent", "cwd"],
    ),
    annotations: readOnlyAnnotations,
  },
  {
    name: "get_history",
    title: "Get Agent History",
    description: "Read recent messages and Run records for one durable agent.",
    inputSchema: objectSchema(
      {
        agent: agentReference,
        cwd: callerCwdProperty,
        scope: scopeProperty,
        limit: { type: "integer", minimum: 1, maximum: 100, default: 6 },
      },
      ["agent", "cwd"],
    ),
    annotations: readOnlyAnnotations,
  },
  {
    name: "list_agents",
    title: "List Agent Team",
    description: "List durable team members and safe provider availability diagnostics.",
    inputSchema: objectSchema(
      { cwd: callerCwdProperty, scope: scopeProperty },
      ["cwd"],
    ),
    annotations: readOnlyAnnotations,
  },
  {
    name: "list_models",
    title: "List Provider Models",
    description:
      "Query Claude Code or Codex for the models currently switchable in the user's active configuration, including custom compatible-endpoint mappings and supported reasoning efforts.",
    inputSchema: objectSchema({
      provider: { type: "string", enum: ["claude-code", "codex"] },
      cwd: {
        type: "string",
        minLength: 1,
        description: "Project directory whose provider settings should be loaded.",
      },
    }, ["cwd"]),
    annotations: readOnlyAnnotations,
  },
  {
    name: "release_agent",
    title: "Release Idle Agent",
    description:
      "Release an idle agent while preserving its role, history, and provider conversation for later resume.",
    inputSchema: objectSchema(
      { agent: agentReference, cwd: callerCwdProperty, scope: scopeProperty },
      ["agent", "cwd"],
    ),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "stop_run",
    title: "Stop Active Agent Run",
    description:
      "Stop active work by Run ID or agent name without deleting the durable agent or provider conversation.",
    inputSchema: objectSchema({
      run_id: { type: "string", minLength: 1 },
      agent: agentReference,
      cwd: callerCwdProperty,
      scope: scopeProperty,
    }, ["cwd"]),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "resume_agent",
    title: "Resume Durable Agent",
    description: "Restore a released, stopped, or restart-recovered agent for later messages.",
    inputSchema: objectSchema(
      { agent: agentReference, cwd: callerCwdProperty, scope: scopeProperty },
      ["agent", "cwd"],
    ),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "delete_agent",
    title: "Delete Durable Agent",
    description:
      "Permanently delete one non-running agent and its local history. Use only when the user explicitly wants the member forgotten.",
    inputSchema: objectSchema(
      { agent: agentReference, cwd: callerCwdProperty, scope: scopeProperty },
      ["agent", "cwd"],
    ),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];

function publicAgent(agent) {
  if (!agent) return undefined;
  const providerState = agent.providerState || {};
  const { providerState: _providerState, ...visible } = agent;
  return {
    ...visible,
    runtime: providerState.runtime,
    recoverable: Boolean(providerState.sessionId || providerState.threadId),
  };
}

function safeAvailability(provider) {
  try {
    return typeof provider.availability === "function"
      ? provider.availability()
      : { available: true };
  } catch (error) {
    return { available: false, error: error.message };
  }
}

function requiredString(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new AgentCallerError("INVALID_INPUT", `${name} is required`);
  return text;
}

function publicRun(run) {
  if (!run) return undefined;
  const { ownerPid: _ownerPid, ...visible } = run;
  return visible;
}

function publicRequest(request) {
  if (!request) return undefined;
  const { transport: _transport, ...visible } = request;
  return visible;
}

export async function callAgentTool({ service, providers }, name, input = {}) {
  if (name === "create_agent") {
    const metadata = {};
    if (input.model) metadata.model = input.model;
    if (input.effort) metadata.effort = input.effort;
    if (input.runtime) metadata.runtime = input.runtime;
    if (input.skip_git_check !== undefined) metadata.skipGitCheck = Boolean(input.skip_git_check);
    const agent = await service.createAgent({
      name: input.name,
      provider: input.provider,
      role: input.role,
      cwd: input.cwd,
      scope: input.scope,
      profile: input.profile,
      sandbox: input.sandbox,
      approval: input.approval,
      metadata,
    });
    return { agent: publicAgent(agent) };
  }

  if (name === "send_message") {
    const args = {
      agent: requiredString(input.agent, "agent"),
      message: requiredString(input.message, "message"),
      profile: input.profile,
      sandbox: input.sandbox,
      approval: input.approval,
      model: input.model,
      effort: input.effort,
      scope: input.scope,
      contextCwd: requiredString(input.cwd, "cwd"),
    };
    if (input.wait === false) {
      const started = await service.startRun(args);
      return {
        agent: publicAgent((await service.getAgent(args.agent, {
          scope: input.scope,
          cwd: args.contextCwd,
        })).agent),
        run: publicRun(started.run),
        pendingRequests: [],
        waiting: false,
      };
    }
    const completed = await service.sendMessage(args);
    return {
      agent: publicAgent(completed.agent),
      run: publicRun(completed.run),
      pendingRequests: (completed.pendingRequests || []).map(publicRequest),
      waiting: true,
    };
  }

  if (name === "get_agent") {
    const result = await service.getAgent(requiredString(input.agent, "agent"), {
      scope: input.scope,
      cwd: requiredString(input.cwd, "cwd"),
    });
    return {
      agent: publicAgent(result.agent),
      currentRun: publicRun(result.currentRun),
      lastRun: publicRun(result.lastRun),
      pendingRequests: (result.pendingRequests || []).map(publicRequest),
    };
  }

  if (name === "get_history") {
    const history = await service.getHistory(requiredString(input.agent, "agent"), {
      scope: input.scope,
      cwd: requiredString(input.cwd, "cwd"),
    });
    const limit = Math.max(1, Math.min(100, Number(input.limit) || 6));
    return {
      agent: publicAgent(history.agent),
      messages: history.messages.slice(-limit),
      runs: history.runs.slice(-limit).map(publicRun),
      requests: history.requests.slice(-limit).map(publicRequest),
    };
  }

  if (name === "list_agents") {
    const availability = {};
    for (const [providerName, provider] of providers) {
      availability[providerName] = safeAvailability(provider);
    }
    return {
      agents: (await service.listAgents({
        scope: input.scope,
        cwd: requiredString(input.cwd, "cwd"),
      })).map(publicAgent),
      providers: availability,
    };
  }

  if (name === "list_models") {
    const requested = input.provider
      ? [[input.provider, providers.get(input.provider)]]
      : Array.from(providers.entries());
    const catalogs = {};
    for (const [providerName, provider] of requested) {
      if (!provider || typeof provider.listModels !== "function") {
        catalogs[providerName] = {
          available: false,
          error: `Provider does not expose a model catalog: ${providerName}`,
        };
        continue;
      }
      try {
        catalogs[providerName] = {
          available: true,
          ...await provider.listModels({ cwd: input.cwd }),
        };
      } catch (error) {
        catalogs[providerName] = {
          available: false,
          error: error.message || String(error),
        };
      }
    }
    return { providers: catalogs };
  }

  if (name === "release_agent") {
    return {
      agent: publicAgent(await service.releaseAgent(requiredString(input.agent, "agent"), {
        scope: input.scope,
        cwd: requiredString(input.cwd, "cwd"),
      })),
    };
  }

  if (name === "respond_to_request") {
    const result = await service.respondToRequest({
      requestId: requiredString(input.request_id, "request_id"),
      decision: input.decision,
      answers: input.answers,
      response: input.response,
      wait: input.wait !== false,
      scope: input.scope,
      contextCwd: requiredString(input.cwd, "cwd"),
    });
    return {
      agent: publicAgent(result.agent),
      run: publicRun(result.run),
      request: publicRequest(result.request),
      pendingRequests: (result.pendingRequests || []).map(publicRequest),
      waiting: input.wait !== false,
    };
  }

  if (name === "stop_run") {
    if (!input.run_id && !input.agent) {
      throw new AgentCallerError("INVALID_INPUT", "run_id or agent is required");
    }
    const result = await service.stopRun({
      runId: input.run_id,
      agent: input.agent,
      scope: input.scope,
      contextCwd: requiredString(input.cwd, "cwd"),
    });
    return { agent: publicAgent(result.agent), run: publicRun(result.run) };
  }

  if (name === "resume_agent") {
    return {
      agent: publicAgent(await service.resumeAgent(requiredString(input.agent, "agent"), {
        scope: input.scope,
        cwd: requiredString(input.cwd, "cwd"),
      })),
    };
  }

  if (name === "delete_agent") {
    return {
      deleted: await service.deleteAgent(requiredString(input.agent, "agent"), {
        scope: input.scope,
        cwd: requiredString(input.cwd, "cwd"),
      }),
    };
  }

  throw new AgentCallerError("TOOL_NOT_FOUND", `Unknown Agent Caller tool: ${name}`);
}

export function summarizeToolResult(name, result) {
  if (name === "create_agent") {
    return `Created ${result.agent.name} (${result.agent.provider}) as ${result.agent.id}.`;
  }
  if (name === "send_message") {
    return `${result.agent.name} run ${result.run.id}: ${result.run.status}.`;
  }
  if (name === "respond_to_request") {
    return `${result.agent.name} run ${result.run.id}: ${result.run.status}.`;
  }
  if (name === "list_agents") return `${result.agents.length} durable agent(s).`;
  if (name === "list_models") {
    const count = Object.values(result.providers).reduce(
      (total, catalog) => total + (catalog.models?.length || 0),
      0,
    );
    return `${count} switchable model(s) across ${Object.keys(result.providers).length} provider(s).`;
  }
  if (name === "get_history") return `${result.messages.length} recent message(s) for ${result.agent.name}.`;
  if (result.agent) return `${result.agent.name}: ${result.agent.status}.`;
  if (result.deleted) return `Deleted ${result.deleted.name}.`;
  return "Agent Caller operation completed.";
}
