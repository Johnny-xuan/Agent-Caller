#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdkEntry = path.join(
  pluginRoot,
  "node_modules",
  "@anthropic-ai",
  "claude-agent-sdk",
  "sdk.mjs",
);
const installLock = path.join(pluginRoot, ".agent-caller-install.lock");
const waitTimeoutMs = 180_000;
const staleLockMs = 120_000;

function runtimeReady() {
  return fs.existsSync(sdkEntry);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireInstallLock() {
  const deadline = Date.now() + waitTimeoutMs;
  while (!runtimeReady()) {
    try {
      await fsp.mkdir(installLock);
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const stat = await fsp.stat(installLock);
        if (Date.now() - stat.mtimeMs > staleLockMs) {
          await fsp.rm(installLock, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (statError.code !== "ENOENT") throw statError;
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for Agent Caller runtime dependencies");
      }
      await sleep(250);
    }
  }
  return false;
}

async function ensureRuntimeDependencies() {
  if (runtimeReady()) return;
  const ownsLock = await acquireInstallLock();
  if (!ownsLock) return;

  try {
    if (runtimeReady()) return;
    process.stderr.write("[agent-caller] Installing runtime dependencies...\n");
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const result = spawnSync(
      npm,
      ["ci", "--omit=optional", "--no-audit", "--no-fund"],
      {
        cwd: pluginRoot,
        env: { ...process.env, npm_config_update_notifier: "false" },
        encoding: "utf8",
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    if (result.status !== 0 || !runtimeReady()) {
      const detail = String(result.stderr || result.error?.message || "npm ci failed").trim();
      throw new Error(`Unable to install Agent Caller runtime dependencies: ${detail}`);
    }
  } finally {
    await fsp.rm(installLock, { recursive: true, force: true });
  }
}

await ensureRuntimeDependencies();
await import("../src/mcp/server.mjs");
