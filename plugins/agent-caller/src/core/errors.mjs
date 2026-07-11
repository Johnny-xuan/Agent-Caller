export class AgentCallerError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "AgentCallerError";
    this.code = code;
    this.details = details;
  }
}

export function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

export function abortError(message = "Run stopped") {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}
