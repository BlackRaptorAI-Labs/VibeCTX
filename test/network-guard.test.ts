import { promises as dnsPromises } from "node:dns";
import { describe, expect, it } from "vitest";

describe("PAR-1038 network test guard", () => {
  it("installs DNS and fetch wrappers before tests run", () => {
    const marker = Symbol.for("vibectx.network-test-guard");
    expect((dnsPromises.lookup as typeof dnsPromises.lookup & { [marker: symbol]: unknown })[marker]).toBe(true);
    expect((globalThis.fetch as typeof globalThis.fetch & { [marker: symbol]: unknown })[marker]).toBe(true);
  });
});
