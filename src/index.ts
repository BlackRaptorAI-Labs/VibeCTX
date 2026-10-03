#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configureActivityLog } from "./activity-log.js";
import { loadDiscoveredRegistry } from "./registry.js";
import { ConfigError } from "./config.js";
import { dispatchCli } from "./cli.js";
import { startServerWithReport } from "./server.js";
import { autowarmStatus } from "./autowarm.js";
import { createInterface } from "node:readline/promises";
import { writeStderrWarning } from "./redact-paths.js";

/** How long after the client closes stdin an in-flight autowarm fetch may keep the process
 *  alive before it is ended (R4). The timer is unref'd: when nothing is in flight the loop
 *  drains and the process exits naturally, sooner. Cache writes are atomic (temp + rename),
 *  so ending the process mid-fetch leaves nothing torn. ASSUMED. */
const CLOSE_GRACE_MS = 100;

// `vibectx doctor [...]` / `vibectx resolve <name>` / `vibectx warm [dir]` run and exit
// with their code; anything else starts the MCP stdio server exactly as before.
const cliExit = await dispatchCli(process.argv, {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  confirm: async (question) => {
    if (!process.stdin.isTTY) return false;
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await prompt.question(question);
      return /^(yes|y)$/i.test(answer.trim());
    } catch {
      return false;
    } finally {
      prompt.close();
    }
  },
});
if (cliExit !== undefined) {
  process.exitCode = cliExit;
} else {
  // PAR-657: an MCP client launches this with a fixed command line, so the config is
  // discovered — `--config` when the launch command carries one, else VIBECTX_CONFIG, else
  // the repo's committed vibectx.config.json layered over the user's.
  const configFlag = process.argv.indexOf("--config");
  const configValue = configFlag !== -1 ? process.argv[configFlag + 1] : undefined;
  // PAR-1044 I-29: a trailing `--config` with no path is refused, as the CLI refuses it,
  // rather than silently starting on the discovered config.
  if (configFlag !== -1 && (configValue === undefined || configValue.startsWith("--"))) {
    process.stderr.write("--config requires a value\n");
    process.exit(2);
  }
  let registry;
  try {
    registry = loadDiscoveredRegistry({
      cwd: process.cwd(),
      env: process.env,
      flag: configValue,
      warn: (note) => writeStderrWarning(note),
    });
  } catch (e) {
    // One line, never a stack: this is what the client surfaces to the user. A ConfigError
    // already names the file and the field (D-22), so it is not prefixed again.
    process.stderr.write(e instanceof ConfigError ? `${e.message}\n` : `could not load config: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
  configureActivityLog({ logArchives: registry.logArchives }); // PAR-1039: once, at startup
  const transport = new StdioServerTransport();
  const outcome = await startServerWithReport(registry, transport, { env: process.env });
  if (!outcome.ok) {
    process.stderr.write(`${outcome.text}\n`);
    process.exit(2);
  }
  const started = outcome.started;
  // The SDK's stdio transport does not watch for stdin ending; close the server ourselves so
  // the autowarm is aborted and a spawn-and-close client never leaves an orphan (R4).
  process.stdin.once("end", () => void started.server.close());
  void started.closed.then(() => {
    if (autowarmStatus().inFlight.size > 0) setTimeout(() => process.exit(0), CLOSE_GRACE_MS).unref();
  });
}
