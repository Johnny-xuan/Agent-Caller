import assert from "node:assert/strict";
import path from "node:path";
import fsp from "node:fs/promises";
import test from "node:test";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(pluginRoot, "../..");

async function readJson(relativePath) {
  return JSON.parse(await fsp.readFile(path.resolve(repoRoot, relativePath), "utf8"));
}

async function exists(relativePath) {
  try {
    await fsp.access(path.resolve(repoRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}

test("both host manifests coexist and share one plugin identity", async () => {
  const [packageManifest, codexManifest, claudeManifest, claudeMarketplace] = await Promise.all([
    readJson("plugins/agent-caller/package.json"),
    readJson("plugins/agent-caller/.codex-plugin/plugin.json"),
    readJson("plugins/agent-caller/.claude-plugin/plugin.json"),
    readJson(".claude-plugin/marketplace.json"),
  ]);
  assert.equal(codexManifest.name, "agent-caller");
  assert.equal(claudeManifest.name, "agent-caller");
  const productVersion = packageManifest.version;
  assert.equal(claudeManifest.version, productVersion);
  assert.equal(codexManifest.version.split("+")[0], productVersion);
  const claudeEntry = claudeMarketplace.plugins.find((plugin) => plugin.name === "agent-caller");
  assert.equal(claudeEntry?.version, productVersion);
  assert.equal(
    typeof claudeManifest.description,
    "string",
    "Claude manifest must describe the plugin",
  );
  if (claudeManifest.license) {
    assert.ok(
      await exists("LICENSE") || await exists("LICENSE.md") || await exists("LICENSE.txt"),
      "a declared plugin license must have a repository license file",
    );
  }
});

test("each host manifest points at its own MCP config that shares one runtime entrypoint", async () => {
  const codexManifest = await readJson("plugins/agent-caller/.codex-plugin/plugin.json");
  const claudeManifest = await readJson("plugins/agent-caller/.claude-plugin/plugin.json");

  const codexMcpPath = codexManifest.mcpServers;
  const claudeMcpPath = claudeManifest.mcpServers;
  assert.equal(typeof codexMcpPath, "string");
  assert.equal(typeof claudeMcpPath, "string");
  assert.notEqual(codexMcpPath, claudeMcpPath, "hosts must not share one MCP config file");

  const [codexMcp, claudeMcp] = await Promise.all([
    readJson(`plugins/agent-caller/${codexMcpPath.replace(/^\.\/?/, "")}`),
    readJson(`plugins/agent-caller/${claudeMcpPath.replace(/^\.\/?/, "")}`),
  ]);

  const codexServer = codexMcp.mcpServers["agent-caller"];
  const claudeServer = claudeMcp.mcpServers["agent-caller"];
  assert.ok(codexServer, "Codex MCP config defines the agent-caller server");
  assert.ok(claudeServer, "Claude MCP config defines the agent-caller server");
  assert.equal(codexServer.command, "node");
  assert.equal(claudeServer.command, "node");

  const codexEntrypoint = codexServer.args.join(" ");
  const claudeEntrypoint = claudeServer.args.join(" ");
  assert.match(codexEntrypoint, /scripts\/start\.mjs$/);
  assert.match(claudeEntrypoint, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/start\.mjs/,
    "Claude MCP config must locate the entrypoint via ${CLAUDE_PLUGIN_ROOT}");

  assert.ok(await exists("plugins/agent-caller/scripts/start.mjs"),
    "both hosts share the same runtime entrypoint");
});

test("both marketplaces advertise agent-caller from the repository root", async () => {
  const [codexMarketplace, claudeMarketplace] = await Promise.all([
    readJson(".agents/plugins/marketplace.json"),
    readJson(".claude-plugin/marketplace.json"),
  ]);

  const codexEntry = codexMarketplace.plugins.find((plugin) => plugin.name === "agent-caller");
  const claudeEntry = claudeMarketplace.plugins.find((plugin) => plugin.name === "agent-caller");
  assert.ok(codexEntry, "Codex marketplace still lists agent-caller (no Codex regression)");
  assert.ok(claudeEntry, "Claude marketplace lists agent-caller");
  assert.equal(codexEntry.source?.path, "./plugins/agent-caller");
  assert.equal(claudeEntry.source, "./plugins/agent-caller");
  assert.equal(typeof claudeMarketplace.owner?.name, "string");
  assert.ok(claudeMarketplace.owner.name.trim());
});

test("the shared skill and all eleven tools remain host-neutral assets", async () => {
  const skillStat = await fsp.stat(path.join(pluginRoot, "skills/agent-caller/SKILL.md"));
  assert.ok(skillStat.isFile(), "shared SKILL.md remains in place for both hosts");

  const { TOOL_DEFINITIONS } = await import("../src/mcp/tools.mjs");
  assert.equal(TOOL_DEFINITIONS.length, 11);
  const expected = new Set([
    "create_agent", "send_message", "respond_to_request",
    "get_agent", "get_history", "list_agents", "list_models",
    "release_agent", "stop_run", "resume_agent", "delete_agent",
  ]);
  for (const tool of TOOL_DEFINITIONS) {
    assert.ok(expected.has(tool.name), `tool ${tool.name} is part of the documented surface`);
  }
});
