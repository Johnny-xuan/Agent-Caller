#!/usr/bin/env node
import os from "node:os";
import path from "node:path";

import { ClaudeCodeProvider } from "../src/providers/claude-code.mjs";
import {
  CodexProvider,
  inspectCodexAppServer,
} from "../src/providers/codex.mjs";

const dataRoot = path.resolve(
  process.env.AGENT_CALLER_DATA_DIR || path.join(os.homedir(), ".codex", "agent-caller"),
);
const result = {
  ok: true,
  dataRoot,
  node: process.version,
  providers: {
    "claude-code": new ClaudeCodeProvider().availability(),
    codex: new CodexProvider().availability(),
  },
};
try {
  result.providers.codex.appServer = await inspectCodexAppServer({ cwd: process.cwd() });
} catch (error) {
  result.providers.codex.appServer = { available: false, error: error.message };
  result.providers.codex.available = false;
}
result.ok = Object.values(result.providers).every((provider) => provider.available);
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
