import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  engines: { node: string };
  bin: { vibectx: string };
};

function jsonBlock(heading: string): Record<string, unknown> {
  const section = readme.split(`### ${heading}\n`)[1]?.split(/\n### |\n## /)[0];
  expect(section, `${heading} section exists`).toBeDefined();
  const block = section!.match(/```json\n([\s\S]*?)\n```/);
  expect(block, `${heading} has a copyable JSON block`).not.toBeNull();
  return JSON.parse(block![1]) as Record<string, unknown>;
}

describe("C3 portable source install and MCP-host documentation", () => {
  it("shows a near-one-command source install for the declared supported Node range", () => {
    const install = readme.split("## Install\n")[1]?.split("\n## Quickstart")[0];
    expect(install).toBeDefined();
    expect(pkg.engines.node).toBe("^20.19.0 || ^22.12.0 || >=24.0.0");
    expect(install).toContain(`\`${pkg.engines.node}\``);
    expect(install).toContain("git clone https://github.com/BlackRaptorAI-Labs/VibeCTX.git && cd VibeCTX && npm ci && npm run build");
    expect(pkg.bin.vibectx).toBe("dist/index.js");
    expect(install).not.toMatch(/npm (?:install|i) @blackraptorai\/vibectx|npx @blackraptorai\/vibectx/);
    // Decision 23: the npm route is a global install of the published package.
    expect(install).toContain("```bash\nnpm install -g @blackraptorai/vibectx\n```");
  });

  it("gives Claude Code and Cursor copyable commands for the same built stdio server", () => {
    expect(readme).toContain("claude mcp add vibectx -- node /absolute/path/to/VibeCTX/dist/index.js");
    const cursor = jsonBlock("Cursor");
    expect(cursor).toEqual({
      mcpServers: { vibectx: { command: "node", args: ["/absolute/path/to/VibeCTX/dist/index.js"] } },
    });
    expect(readme).toContain(".cursor/mcp.json");
  });

  it("gives a generic MCP stdio command/args pair without claiming host-specific config shape", () => {
    const generic = jsonBlock("Any MCP-speaking host");
    expect(generic).toEqual({ command: "node", args: ["/absolute/path/to/VibeCTX/dist/index.js"] });
    expect(readme).toContain("host-specific MCP settings");
    const quickstart = readme.split("## Quickstart\n")[1]?.split("\n## Tools")[0];
    expect(quickstart).toContain("The current documentation-source coverage is npm and PyPI packages, regardless of the\nproject language or MCP host.");
    expect(quickstart).not.toMatch(/\bRubyGems\b/i);
    expect(readme).toContain("PAR-930");
  });
});
