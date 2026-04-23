import { randomBytes } from "node:crypto";

export function shortId(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
