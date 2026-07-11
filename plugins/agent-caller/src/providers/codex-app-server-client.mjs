import readline from "node:readline";

export class CodexAppServerClient {
  #nextId = 1;
  #pending = new Map();

  constructor({ child, onNotification, onServerRequest }) {
    this.child = child;
    this.onNotification = onNotification;
    this.onServerRequest = onServerRequest;
    this.stderr = "";
    this.closed = new Promise((resolve, reject) => {
      child.once("error", (error) => {
        this.#rejectPending(error);
        reject(error);
      });
      child.once("close", (code, signal) => {
        this.#rejectPending(
          new Error(this.stderr.trim() || `Codex App Server closed (${code ?? signal})`),
        );
        resolve({ code, signal });
      });
    });
    child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString();
    });
    this.lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => {
      if (!line.trim()) return;
      try {
        void this.#handle(JSON.parse(line));
      } catch {
        // App Server diagnostics belong on stderr; malformed stdout is ignored.
      }
    });
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}) {
    const id = this.#nextId;
    this.#nextId += 1;
    const pending = new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.send({ jsonrpc: "2.0", id, method, params });
    return pending;
  }

  notify(method, params) {
    const message = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    this.send(message);
  }

  async initialize() {
    const result = await this.request("initialize", {
      clientInfo: {
        name: "agent-caller",
        title: "Agent Caller",
        version: "0.2.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: true,
      },
    });
    this.notify("initialized");
    return result;
  }

  async #handle(message) {
    if (message.id !== undefined && !message.method) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message || "Codex App Server request failed");
        error.code = message.error.code || "CODEX_APP_SERVER_ERROR";
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      try {
        const result = await this.onServerRequest(message);
        this.send({ jsonrpc: "2.0", id: message.id, result });
      } catch (error) {
        this.send({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32000,
            message: error.message || String(error),
          },
        });
      }
      return;
    }

    if (message.method) await this.onNotification(message);
  }

  #rejectPending(error) {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  terminate() {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
    }
  }

  async close() {
    this.terminate();
    const result = await this.closed;
    this.lines.close();
    this.#rejectPending(new Error("Codex App Server closed"));
    return result;
  }
}
