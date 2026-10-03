import { lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isRegularFile, newerSchemaVersion, writeAtomic } from "./atomic-store.js";
import { cacheRoot, cacheRootReadable, ensureCacheRoot, readBoundedRegularFile } from "./cache.js";

export type NetworkDecision = "allowed" | "declined" | "disclosed";
export type ConsentVia = "elicitation" | "fallback" | "cli";
export interface ConsentRecord {
  schemaVersion: 1;
  network: NetworkDecision;
  decidedAt: string;
  via: ConsentVia;
}

const MAX_CONSENT_BYTES = 4096;
export const CONSENT_SCHEMA_VERSION = 1;

export function consentPath(): string {
  return join(cacheRoot(), "consent.json");
}

/** A symlink or an oversized/foreign store is not a decision. Never follow it. */
export function readConsent(): ConsentRecord | undefined {
  if (!cacheRootReadable()) return undefined;
  const path = consentPath();
  if (!isRegularFile(path)) return undefined;
  const raw = readBoundedRegularFile(path, MAX_CONSENT_BYTES);
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (record.schemaVersion !== CONSENT_SCHEMA_VERSION) return undefined;
    if (record.network !== "allowed" && record.network !== "declined" && record.network !== "disclosed") return undefined;
    if (record.via !== "elicitation" && record.via !== "fallback" && record.via !== "cli") return undefined;
    if (typeof record.decidedAt !== "string" || record.decidedAt.length > 64) return undefined;
    return record as unknown as ConsentRecord;
  } catch {
    return undefined;
  }
}

/** Best effort for MCP; CLI reports false. Existing non-regular/newer/oversized files are never replaced. */
export function saveConsent(network: NetworkDecision, via: ConsentVia): boolean {
  try {
    const root = cacheRoot();
    if (!ensureCacheRoot(root)) return false;
    const path = consentPath();
    let exists = false;
    try { lstatSync(path); exists = true; } catch { /* absent */ }
    if (exists && (!isRegularFile(path) || readBoundedRegularFile(path, MAX_CONSENT_BYTES) === undefined)) return false;
    if (newerSchemaVersion(path, CONSENT_SCHEMA_VERSION, MAX_CONSENT_BYTES) !== undefined) return false;
    const record: ConsentRecord = { schemaVersion: 1, network, decidedAt: new Date().toISOString(), via };
    writeAtomic(path, JSON.stringify(record), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Reset is exact-target only: a symlink must be refused, never unlinked as a shortcut. */
export function resetConsent(): boolean {
  if (!cacheRootReadable()) return false;
  const path = consentPath();
  try {
    lstatSync(path);
  } catch {
    return true; // already none
  }
  if (!isRegularFile(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
