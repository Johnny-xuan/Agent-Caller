import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { AgentCallerError } from "./errors.mjs";

async function ensureDir(directory) {
  await fsp.mkdir(directory, { recursive: true });
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  await ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(temporary, file);
}

async function appendJsonLine(file, value) {
  await ensureDir(path.dirname(file));
  await fsp.appendFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

async function readJsonLines(file) {
  let contents;
  try {
    contents = await fsp.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  return contents
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function byCreatedAt(left, right) {
  return String(left.createdAt).localeCompare(String(right.createdAt));
}

function safeId(value, field) {
  const id = String(value || "");
  if (!/^[A-Za-z][A-Za-z0-9_-]{1,127}$/.test(id)) {
    throw new AgentCallerError("INVALID_ID", `Invalid ${field}: ${id}`);
  }
  return id;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class AgentStore {
  constructor({ root }) {
    this.root = path.resolve(root);
    this.agentsRoot = path.join(this.root, "agents");
  }

  async init() {
    await ensureDir(this.agentsRoot);
  }

  agentDirectory(agentId) {
    return path.join(this.agentsRoot, safeId(agentId, "agent ID"));
  }

  agentFile(agentId) {
    return path.join(this.agentDirectory(agentId), "agent.json");
  }

  runFile(agentId, runId) {
    return path.join(
      this.agentDirectory(agentId),
      "runs",
      `${safeId(runId, "run ID")}.json`,
    );
  }

  eventsFile(agentId, runId) {
    return path.join(
      this.agentDirectory(agentId),
      "runs",
      `${safeId(runId, "run ID")}.events.jsonl`,
    );
  }

  requestDirectory(agentId) {
    return path.join(this.agentDirectory(agentId), "requests");
  }

  requestFile(agentId, requestId) {
    return path.join(
      this.requestDirectory(agentId),
      `${safeId(requestId, "request ID")}.json`,
    );
  }

  messagesFile(agentId) {
    return path.join(this.agentDirectory(agentId), "messages.jsonl");
  }

  claimFile(agentId) {
    return path.join(this.agentDirectory(agentId), "active-run.lock");
  }

  async getAgentClaim(agentId) {
    try {
      return await readJson(this.claimFile(agentId));
    } catch {
      return { unreadable: true };
    }
  }

  async claimAgent(agentId, runId) {
    const file = this.claimFile(agentId);
    await ensureDir(path.dirname(file));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let handle;
      try {
        handle = await fsp.open(file, "wx");
        const claim = {
          agentId,
          runId,
          ownerPid: process.pid,
          ownerToken: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
        };
        await handle.writeFile(
          `${JSON.stringify(claim)}\n`,
          "utf8",
        );
        await handle.close();
        return claim;
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if (error.code !== "EEXIST") throw error;
        const claim = await this.getAgentClaim(agentId);
        if (!claim?.unreadable && !processAlive(claim?.ownerPid)) {
          await fsp.rm(file, { force: true });
          continue;
        }
        throw new AgentCallerError(
          "AGENT_BUSY",
          `Agent already has active run ${claim?.runId || "owned by another process"}`,
        );
      }
    }
    throw new AgentCallerError("AGENT_BUSY", `Could not claim agent ${agentId}`);
  }

  async releaseAgentClaim(agentId, runId) {
    const claim = await this.getAgentClaim(agentId);
    if (!claim || claim.unreadable) return;
    if (claim.runId === runId) await fsp.rm(this.claimFile(agentId), { force: true });
  }

  runOwnerAlive(run, claim) {
    return Boolean(
      run &&
      claim &&
      !claim.unreadable &&
      claim.agentId === run.agentId &&
      claim.runId === run.id &&
      claim.ownerPid === run.ownerPid &&
      claim.ownerToken === run.ownerToken &&
      processAlive(run.ownerPid),
    );
  }

  async createAgent(agent) {
    const directory = this.agentDirectory(agent.id);
    if (fs.existsSync(directory)) {
      throw new AgentCallerError("AGENT_EXISTS", `Agent already exists: ${agent.id}`);
    }
    await ensureDir(path.join(directory, "runs"));
    await ensureDir(path.join(directory, "requests"));
    await writeJsonAtomic(this.agentFile(agent.id), agent);
    return agent;
  }

  async updateAgent(agent) {
    if (!fs.existsSync(this.agentFile(agent.id))) {
      throw new AgentCallerError("AGENT_NOT_FOUND", `Unknown agent: ${agent.id}`);
    }
    await writeJsonAtomic(this.agentFile(agent.id), agent);
    return agent;
  }

  async getAgentById(agentId) {
    return readJson(this.agentFile(agentId));
  }

  async listAgents() {
    let entries = [];
    try {
      entries = await fsp.readdir(this.agentsRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const agents = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const agent = await this.getAgentById(entry.name);
      if (agent) agents.push(agent);
    }
    return agents.sort(byCreatedAt);
  }

  async resolveAgent(reference) {
    const value = String(reference || "").trim();
    if (!value) throw new AgentCallerError("AGENT_REQUIRED", "Agent ID or name is required");

    if (/^agt_[A-Za-z0-9_-]+$/.test(value)) {
      const byId = await this.getAgentById(value);
      if (byId) return byId;
    }

    const normalized = value.toLocaleLowerCase();
    const matches = (await this.listAgents()).filter(
      (agent) => agent.name.toLocaleLowerCase() === normalized,
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new AgentCallerError("AGENT_AMBIGUOUS", `Agent name is ambiguous: ${value}`);
    }
    throw new AgentCallerError("AGENT_NOT_FOUND", `Unknown agent: ${value}`);
  }

  async deleteAgent(agentId) {
    await fsp.rm(this.agentDirectory(agentId), { recursive: true, force: true });
  }

  async createRun(run) {
    const file = this.runFile(run.agentId, run.id);
    if (fs.existsSync(file)) {
      throw new AgentCallerError("RUN_EXISTS", `Run already exists: ${run.id}`);
    }
    await writeJsonAtomic(file, run);
    return run;
  }

  async updateRun(run) {
    await writeJsonAtomic(this.runFile(run.agentId, run.id), run);
    return run;
  }

  async getRun(agentId, runId) {
    return readJson(this.runFile(agentId, runId));
  }

  async listRuns(agentId) {
    const directory = path.join(this.agentDirectory(agentId), "runs");
    let entries = [];
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const runs = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const run = await readJson(path.join(directory, entry.name));
      if (run) runs.push(run);
    }
    return runs.sort(byCreatedAt);
  }

  async findRun(runId) {
    safeId(runId, "run ID");
    for (const agent of await this.listAgents()) {
      const run = await this.getRun(agent.id, runId);
      if (run) return { agent, run };
    }
    return undefined;
  }

  async createRequest(request) {
    const file = this.requestFile(request.agentId, request.id);
    if (fs.existsSync(file)) {
      throw new AgentCallerError("REQUEST_EXISTS", `Request already exists: ${request.id}`);
    }
    await writeJsonAtomic(file, request);
    return request;
  }

  async updateRequest(request) {
    await writeJsonAtomic(this.requestFile(request.agentId, request.id), request);
    return request;
  }

  async getRequest(agentId, requestId) {
    return readJson(this.requestFile(agentId, requestId));
  }

  async listRequests(agentId) {
    const directory = this.requestDirectory(agentId);
    let entries = [];
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const requests = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const request = await readJson(path.join(directory, entry.name));
      if (request) requests.push(request);
    }
    return requests.sort(byCreatedAt);
  }

  async findRequest(requestId) {
    safeId(requestId, "request ID");
    for (const agent of await this.listAgents()) {
      const request = await this.getRequest(agent.id, requestId);
      if (request) return { agent, request };
    }
    return undefined;
  }

  async appendMessage(agentId, message) {
    await appendJsonLine(this.messagesFile(agentId), message);
    return message;
  }

  async listMessages(agentId) {
    return (await readJsonLines(this.messagesFile(agentId))).sort(byCreatedAt);
  }

  async appendEvent(agentId, runId, event) {
    await appendJsonLine(this.eventsFile(agentId, runId), event);
    return event;
  }

  async listEvents(agentId, runId) {
    return readJsonLines(this.eventsFile(agentId, runId));
  }

  async recoverInterrupted(now) {
    const recovered = [];
    for (const agent of await this.listAgents()) {
      const runs = await this.listRuns(agent.id);
      for (const run of runs) {
        if (!["queued", "running", "waiting_for_input"].includes(run.status)) continue;
        const claim = await this.getAgentClaim(agent.id);
        if (this.runOwnerAlive(run, claim)) {
          continue;
        }
        const interrupted = {
          ...run,
          status: "interrupted",
          finishedAt: now,
          updatedAt: now,
          error: {
            code: "SERVICE_RESTART",
            message: "Agent Caller restarted before this run completed",
          },
        };
        await this.updateRun(interrupted);
        await this.releaseAgentClaim(agent.id, run.id);
        for (const request of await this.listRequests(agent.id)) {
          if (request.runId !== run.id || request.status !== "pending") continue;
          await this.updateRequest({
            ...request,
            status: "expired",
            resolution: {
              code: "SERVICE_RESTART",
              message: "The provider request expired when Agent Caller restarted",
            },
            resolvedAt: now,
            updatedAt: now,
          });
        }
        recovered.push(interrupted);
      }

      if (["running", "waiting_for_input"].includes(agent.status) || agent.activeRunId) {
        const activeRun = agent.activeRunId
          ? await this.getRun(agent.id, agent.activeRunId)
          : undefined;
        const activeClaim = await this.getAgentClaim(agent.id);
        if (
          activeRun &&
          ["queued", "running", "waiting_for_input"].includes(activeRun.status) &&
          this.runOwnerAlive(activeRun, activeClaim)
        ) {
          continue;
        }
        await this.updateAgent({
          ...agent,
          status: "inactive",
          activeRunId: null,
          updatedAt: now,
        });
      }
    }
    return recovered;
  }
}
