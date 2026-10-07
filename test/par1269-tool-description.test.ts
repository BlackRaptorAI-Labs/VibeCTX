import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";

// PAR-1269 / plan D22 (decided 2026-10-06): the get_docs tool description and its `version`
// parameter description, as a client reads them from the live tool list, describe the version
// rules D6/D9b put in place (D-110, D-113): resolved packages match the exact release; curated
// entries match a listed major; a listed major whose sources fail with nothing cached does not
// fall back to latest. The old text promised an exact-release match with fallback for every entry.

async function getDocsTool() {
  const server = buildServer({ entries: new Map() });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "par1269-description", version: "1" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tool = (await client.listTools()).tools.find((t) => t.name === "get_docs");
    expect(tool, "get_docs is listed").toBeDefined();
    const version = (tool!.inputSchema.properties as Record<string, { description?: string }>).version;
    return { description: tool!.description ?? "", version: version?.description ?? "" };
  } finally {
    await client.close();
    await server.close();
  }
}

const OLD_PHRASES = [
  "Request version for an exact-release match",
  "a missing match falls back to latest and always says so",
  "curated entries state why matching is not applied",
  "Match documentation to this exact version",
  "falls back to the latest available document if none is found",
];

for (const field of ["description", "version"] as const) {
  it(`PAR-1269 D22: the get_docs ${field} text states the D6/D9b version rules`, async () => {
    const text = (await getDocsTool())[field];
    expect(text).toContain("resolved packages match the exact release");
    expect(text).toContain("curated entries match only a listed major");
    expect(text).toContain("no fallback to latest");
    for (const phrase of OLD_PHRASES) expect(text, phrase).not.toContain(phrase);
  });
}
