import { readFileSync } from "node:fs";
import { networkInterfaces, platform } from "node:os";
import { expect, it } from "vitest";

it("PAR-1038: the hosted full suite has only loopback interfaces and runs as a normal user", () => {
  const interfaces = Object.values(networkInterfaces()).flat().filter((address) => address !== undefined);
  expect(interfaces.some((address) => address.internal && address.address === "127.0.0.1")).toBe(true);
  if ((process.env.GITHUB_ACTIONS === "true" && platform() === "linux")
    || process.env.VIBECTX_REQUIRE_NETWORK_ISOLATION === "1") {
    expect(interfaces.filter((address) => !address.internal)).toEqual([]);
    if (platform() === "linux") {
      // proc exposes this process's network namespace; inherited sysfs can still describe
      // the namespace in which it was mounted before unshare.
      const devices = readFileSync("/proc/self/net/dev", "utf8").split("\n").slice(2)
        .filter((line) => line.includes(":"))
        .map((line) => line.slice(0, line.indexOf(":")).trim()).sort();
      expect(devices).toEqual(["lo"]);
    }
    expect(process.getuid?.()).not.toBe(0);
  }
});
