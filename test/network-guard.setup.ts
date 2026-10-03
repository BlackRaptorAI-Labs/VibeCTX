import { promises as dnsPromises } from "node:dns";
import net from "node:net";
import { afterAll, beforeEach, expect } from "vitest";

const NETWORK_GUARD_MARKER = Symbol.for("vibectx.network-test-guard");
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

let blockedAttempts = 0;
const blockedTargets = new Set<string>();

function blocked(kind: string, target: string): never {
  blockedAttempts += 1;
  const testName = expect.getState().currentTestName ?? "test setup";
  const detail = `${testName}: ${kind} for "${target}"`;
  blockedTargets.add(detail);
  throw new Error(`network guard blocked ${detail}`);
}

function isLocalhost(hostname: string): boolean {
  return hostname.toLowerCase() === "localhost";
}

function hostnameFromFetch(input: RequestInfo | URL): string {
  if (typeof input === "string") return new URL(input).hostname;
  if (input instanceof URL) return input.hostname;
  return new URL(input.url).hostname;
}

function hostnameFromSocketArgs(args: unknown[]): string | undefined {
  const [optionsOrPort, host] = args;
  // Node socket factories pass their normalized [options, callback] tuple as one argument.
  if (Array.isArray(optionsOrPort)) return hostnameFromSocketArgs(optionsOrPort);
  if (typeof optionsOrPort === "number") return typeof host === "string" ? host : "localhost";
  if (typeof optionsOrPort !== "object" || optionsOrPort === null) return undefined;
  // A present but undefined/empty path still means TCP, including Undici connections.
  if ("path" in optionsOrPort && typeof optionsOrPort.path === "string" && optionsOrPort.path.length > 0) return undefined;
  const { host: optionHost } = optionsOrPort as { host?: unknown };
  return typeof optionHost === "string" ? optionHost : "localhost";
}

function assertLoopbackConnection(kind: string, args: unknown[]): void {
  const hostname = hostnameFromSocketArgs(args);
  if (hostname !== undefined && !LOOPBACK_HOSTS.has(hostname.toLowerCase())) blocked(kind, hostname);
}

const nativeLookup = dnsPromises.lookup;
const guardedLookup = (async (hostname: string, options?: object) => {
  if (!isLocalhost(hostname)) blocked("DNS lookup", hostname);
  return nativeLookup(hostname, options as Parameters<typeof nativeLookup>[1]);
}) as typeof dnsPromises.lookup;
Object.defineProperty(guardedLookup, NETWORK_GUARD_MARKER, { value: true });
dnsPromises.lookup = guardedLookup;

const nativeFetch = globalThis.fetch;
const guardedFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const hostname = hostnameFromFetch(input);
  if (!LOOPBACK_HOSTS.has(hostname.toLowerCase())) blocked("fetch", hostname);
  return nativeFetch(input, init);
}) as typeof fetch;
Object.defineProperty(guardedFetch, NETWORK_GUARD_MARKER, { value: true });

const nativeConnect = net.connect;
net.connect = ((...args: Parameters<typeof net.connect>) => {
  assertLoopbackConnection("net.connect", args);
  return nativeConnect(...args);
}) as typeof net.connect;

const nativeSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedSocketConnect(...args: Parameters<net.Socket["connect"]>) {
  assertLoopbackConnection("socket connect", args);
  return nativeSocketConnect.apply(this, args);
};

function installFetchGuard(): void {
  globalThis.fetch = guardedFetch;
}

installFetchGuard();
beforeEach(installFetchGuard);

afterAll(() => {
  expect(blockedAttempts, `network guard blocked attempt count: ${[...blockedTargets].join("; ")}`).toBe(0);
});
