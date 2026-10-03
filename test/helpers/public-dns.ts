import { promises as dnsPromises } from "node:dns";
import { vi } from "vitest";

const PUBLIC_ADDRESS = { address: "93.184.216.34", family: 4 } as const;

/**
 * Test-only resolver double for code paths that deliberately use defaultLookup.
 * Tests must also stub fetch; this prevents the resolver itself from issuing DNS.
 */
export function stubPublicDns(): void {
  vi.spyOn(dnsPromises, "lookup").mockImplementation((async (_hostname: string, options?: unknown) => {
    const result = [PUBLIC_ADDRESS];
    return options && typeof options === "object" && "all" in options && options.all ? result : PUBLIC_ADDRESS;
  }) as typeof dnsPromises.lookup);
}
