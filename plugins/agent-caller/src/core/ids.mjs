import crypto from "node:crypto";

export function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function timestamp(clock = () => new Date()) {
  return clock().toISOString();
}
