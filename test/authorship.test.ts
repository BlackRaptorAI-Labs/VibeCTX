import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function repoFile(name: string): string {
  return readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
}

describe("C7 authorship attribution", () => {
  it("README byline links the BlackRaptorAI handle", () => {
    const byline = repoFile("README.md").match(/^By .+$/m)?.[0];
    expect(byline).toContain("Tom Hanks");
    expect(byline).toContain("[BlackRaptorAI](https://github.com/BlackRaptorAI)");
  });

  it("README license summary names Tom Hanks and BlackRaptorAI", () => {
    const licenseSection = repoFile("README.md").split("\n## License\n")[1];
    expect(licenseSection).toBeDefined();
    expect(licenseSection.trimStart().split("\n")[0]).toBe("MIT © 2026 Tom Hanks / BlackRaptorAI");
  });

  it("package author names Tom Hanks and BlackRaptorAI", () => {
    const pkg = JSON.parse(repoFile("package.json")) as { author?: string };
    expect(pkg.author).toBe("Tom Hanks (BlackRaptorAI)");
  });

  it("LICENSE copyright line names Tom Hanks and BlackRaptorAI", () => {
    const copyright = repoFile("LICENSE").match(/^Copyright \(c\) .+$/m)?.[0];
    expect(copyright).toBe("Copyright (c) 2026 Tom Hanks / BlackRaptorAI");
  });

  it("AUTHORS identifies the person, handle, and GitHub home", () => {
    const authors = repoFile("AUTHORS");
    const [attribution, profileUrl] = authors.split("\n");
    expect(attribution).toBe("Tom Hanks / BlackRaptorAI");
    expect(profileUrl).toBe("https://github.com/BlackRaptorAI");
  });

  it("CONTRIBUTING license note agrees with the authorship attribution", () => {
    const licenseSection = repoFile("CONTRIBUTING.md").split("\n## License\n")[1];
    expect(licenseSection).toBeDefined();
    expect(licenseSection.trimStart().split("\n")[0]).toBe(
      "MIT © 2026 Tom Hanks / BlackRaptorAI. By contributing you agree your contribution is licensed",
    );
  });
});
