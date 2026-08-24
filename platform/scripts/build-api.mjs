import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const platformRoot = fileURLToPath(new URL("..", import.meta.url));
const apiRoot = fileURLToPath(new URL("../apps/api/", import.meta.url));
const typescript = fileURLToPath(
  new URL("../node_modules/typescript/bin/tsc", import.meta.url),
);

rmSync(new URL("../apps/api/dist/", import.meta.url), {
  force: true,
  recursive: true,
});

const result = spawnSync(
  process.execPath,
  [typescript, "-p", `${apiRoot}tsconfig.build.json`],
  { cwd: platformRoot, stdio: "inherit" },
);

if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
