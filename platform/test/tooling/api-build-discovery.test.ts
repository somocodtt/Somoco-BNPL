import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const platformRoot = path.resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);
const apiDist = path.join(platformRoot, "apps", "api", "dist");
const vitest = path.join(platformRoot, "node_modules", "vitest", "vitest.mjs");

describe("API build and test discovery boundaries", () => {
  it("cleans production output and never emits source-located tests", () => {
    const staleTest = path.join(apiDist, "stale.test.js");
    mkdirSync(apiDist, { recursive: true });
    writeFileSync(
      staleTest,
      "throw new Error('stale build output was discovered');\n",
    );

    execFileSync(process.execPath, ["scripts/build-api.mjs"], {
      cwd: platformRoot,
      stdio: "pipe",
    });

    const emittedFiles = listFiles(apiDist);
    expect(emittedFiles).not.toContain(staleTest);
    expect(emittedFiles.filter((file) => /\.test\.js$/.test(file))).toEqual([]);
  }, 30_000);

  it("keeps API and cross-workspace pilot discovery on separate configs", () => {
    const apiFiles = listVitestFiles("apps/api/vitest.config.ts");
    expect(apiFiles.length).toBeGreaterThan(0);
    expect(apiFiles.every((file) => file.startsWith("apps/api/"))).toBe(true);
    expect(apiFiles.some((file) => file.includes("/dist/"))).toBe(false);

    const pilotFiles = listVitestFiles("vitest.pilot.config.mts");
    expect(pilotFiles).toEqual([
      "apps/api/test/task15-controlled-pilot.e2e.test.ts",
      "test/e2e/information-request.spec.ts",
      "test/e2e/ownership-transfer.spec.ts",
      "test/e2e/payment-replay.spec.ts",
      "test/e2e/recovery-control.spec.ts",
    ]);

    const packageJson = JSON.parse(
      readFileSync(path.join(platformRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts["test:pilot"]).toContain(
      "--config vitest.pilot.config.mts",
    );
  });
});

function listVitestFiles(config: string): string[] {
  const output = execFileSync(
    process.execPath,
    [vitest, "list", "--config", config, "--filesOnly", "--no-color"],
    { cwd: platformRoot, encoding: "utf8" },
  );
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim().replaceAll("\\", "/"))
    .filter(Boolean)
    .map((file) => path.relative(platformRoot, file).replaceAll("\\", "/"))
    .sort();
}

function listFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}
