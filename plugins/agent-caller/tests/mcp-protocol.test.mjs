import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import readline from "node:readline";
import test from "node:test";

test("stdio MCP initializes and lists Agent Caller tools", async (t) => {
  const packageManifest = JSON.parse(
    await fsp.readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-caller-mcp-protocol-"));
  const child = spawn(process.execPath, ["scripts/start.mjs"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, AGENT_CALLER_DATA_DIR: dataRoot },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(async () => {
    child.kill("SIGTERM");
    await fsp.rm(dataRoot, { recursive: true, force: true });
  });

  const pending = new Map();
  const output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  output.on("line", (line) => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });
  let nextId = 1;
  const request = (method, params = {}) => {
    const id = nextId++;
    const response = new Promise((resolve) => pending.set(id, { resolve }));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  };

  const initialized = await request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  const tools = await request("tools/list");

  assert.equal(initialized.result.serverInfo.name, "Agent Caller");
  assert.equal(initialized.result.serverInfo.version, packageManifest.version);
  assert.match(initialized.result.instructions, /each host session/);
  assert.doesNotMatch(initialized.result.instructions, /parent Codex/);
  assert.equal(tools.result.tools.length, 11);
  assert.equal(tools.result.tools[0].name, "create_agent");
  const sendMessage = tools.result.tools.find((tool) => tool.name === "send_message");
  assert.deepEqual(sendMessage.inputSchema.properties.profile.enum, [
    "trusted",
    "guarded",
    "observer",
  ]);
});
