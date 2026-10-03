import { existsSync, readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";

it("PAR-820: Dependabot schedules github-actions updates at the repository root", () => {
  const path = new URL("../.github/dependabot.yml", import.meta.url);
  expect(existsSync(path), "the repository must configure action updates").toBe(true);
  // JSON is a YAML subset. Keeping this small document in that subset lets this test
  // inspect its actual data without adding another parser dependency.
  const config = JSON.parse(readFileSync(path, "utf8"));
  expect(config.version).toBe(2);
  expect(config.updates).toHaveLength(1);
  const update = config.updates[0];
  expect(update["package-ecosystem"]).toBe("github-actions");
  expect(update.directory).toBe("/");
  expect(update.schedule.interval).toBe("weekly");
  expect(update["open-pull-requests-limit"] ?? 5).toBeGreaterThan(0);
  expect(update.ignore ?? []).toEqual([]);
  expect(update["target-branch"]).toBeUndefined();
  expect(config.registries).toBeUndefined();
});

it("PAR-820: both covered workflows retain complete immutable action pins and version comments", () => {
  for (const filename of ["ci.yml", "doctor.yml"]) {
    const workflow = readFileSync(new URL(`../.github/workflows/${filename}`, import.meta.url), "utf8");
    const actions = [...workflow.matchAll(/^\s*(?:- )?uses:\s*(actions\/[^\n]+)/gm)].map((match) => match[1].trim());
    expect(actions.length).toBeGreaterThanOrEqual(2);
    for (const action of actions) expect(action).toMatch(/^actions\/[a-z-]+@[a-f0-9]{40}\s*#\s*v\d+\.\d+\.\d+$/);
  }
});


it("PAR-820: every external action in every workflow has an immutable commit pin", () => {
  const directory = new URL("../.github/workflows/", import.meta.url);
  const files = readdirSync(directory).filter((file) => /\.ya?ml$/.test(file));
  expect(files.length).toBeGreaterThan(0);
  let checked = 0;
  for (const file of files) {
    const workflow = readFileSync(new URL(file, directory), "utf8");
    const uses = [...workflow.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
    for (const action of uses) {
      if (action.startsWith("./")) continue;
      expect(action, `${file}: ${action}`).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?@[0-9a-f]{40}$/);
      checked++;
    }
  }
  expect(checked).toBeGreaterThanOrEqual(5);
});
