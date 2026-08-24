import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const requiredFiles = [
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "eslint.config.mjs",
  "prettier.config.mjs",
  "vitest.workspace.ts",
  ".env.example",
  "packages/domain/package.json"
];

await Promise.all(requiredFiles.map((file) => access(resolve(file))));

const domainPackage = JSON.parse(
  await readFile(resolve("packages/domain/package.json"), "utf8")
);

if (domainPackage.name !== "@somo/domain") {
  throw new Error("The domain package must be named @somo/domain.");
}

console.log("Workspace configuration verified.");
