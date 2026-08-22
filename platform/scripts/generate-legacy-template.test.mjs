import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  generateLegacyTemplate,
  writeLegacyTemplate,
} from "./generate-legacy-template.mjs";

test("legacy migration template is deterministic and non-executable", async () => {
  const first = generateLegacyTemplate();
  const second = generateLegacyTemplate();
  assert.equal(first.csvSha256, second.csvSha256);
  assert.equal(first.schemaSha256, second.schemaSha256);
  assert.equal(first.containsMacros, false);
  assert.equal(first.containsFormulas, false);
  assert.equal(first.csv, `${first.headers.join(",")}\r\n`);

  const directory = await mkdtemp(join(tmpdir(), "somo-legacy-template-"));
  try {
    await writeLegacyTemplate(directory);
    const csv = await readFile(
      join(directory, "somo-legacy-legacy-v1.csv"),
      "utf8",
    );
    const schema = await readFile(
      join(directory, "somo-legacy-legacy-v1.schema.json"),
      "utf8",
    );
    assert.equal(csv, first.csv);
    assert.equal(JSON.parse(schema).$id, "somo://migration/legacy-v1");
    assert.doesNotMatch(csv, /[=+@][^,\r\n]*/);
    assert.doesNotMatch(schema, /\b(formula|macro|vba)\b/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
