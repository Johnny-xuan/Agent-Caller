import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { AgentService } from "../core/agent-service.mjs";
import { AgentStore } from "../core/store.mjs";
import { ClaudeCodeProvider } from "../providers/claude-code.mjs";
import { CodexProvider } from "../providers/codex.mjs";
import {
  callAgentTool,
  summarizeToolResult,
  TOOL_DEFINITIONS,
} from "./tools.mjs";

const pluginManifest = JSON.parse(
  await fsp.readFile(new URL("../../.codex-plugin/plugin.json", import.meta.url), "utf8"),
);
const dataRoot = path.resolve(
  process.env.AGENT_CALLER_DATA_DIR || path.join(os.homedir(), ".codex", "agent-caller"),
);
const providers = new Map([
  ["claude-code", new ClaudeCodeProvider()],
  ["codex", new CodexProvider()],
]);
const service = new AgentService({
  store: new AgentStore({ root: dataRoot }),
  providers,
});
await service.init();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleRequest(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: params?.protocolVersion || "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "Agent Caller", version: pluginManifest.version },
      instructions:
        "Pass the current project cwd on every scoped tool call. Agents default to project scope; use global only when the user explicitly wants cross-project sharing. On first provider use in each parent Codex task, query live models and ask the user to choose model and effort before delegating; reuse that choice within the task. Create trusted durable agents, use narrower profiles when needed, continue multi-turn conversations, and preserve recoverable identities.",
    });
    return;
  }
  if (method === "ping") {
    sendResult(id, {});
    return;
  }
  if (method === "tools/list") {
    sendResult(id, { tools: TOOL_DEFINITIONS });
    return;
  }
  if (method === "tools/call") {
    try {
      const result = await callAgentTool(
        { service, providers },
        params?.name,
        params?.arguments || {},
      );
      sendResult(id, {
        content: [{ type: "text", text: summarizeToolResult(params?.name, result) }],
        structuredContent: { ok: true, ...result },
      });
    } catch (error) {
      sendResult(id, {
        isError: true,
        content: [{ type: "text", text: error.message || String(error) }],
        structuredContent: {
          ok: false,
          error: {
            code: error.code || "AGENT_CALLER_ERROR",
            message: error.message || String(error),
          },
        },
      });
    }
    return;
  }
  if (id !== undefined) sendError(id, -32601, `Method not found: ${method}`);
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  try {
    void handleRequest(JSON.parse(line));
  } catch {
    // Invalid notification lines cannot be answered without a request id.
  }
});

async function shutdown() {
  lines.close();
  await service.shutdown();
}

process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
