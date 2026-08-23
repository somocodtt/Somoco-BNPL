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
  for (const required of [
    "applicant_legacy_id",
    "applicant_full_name",
    "applicant_phone_e164",
    "applicant_ghana_card_fingerprint",
    "applicant_date_of_birth",
    "guarantor_legacy_id",
    "guarantor_full_name",
    "guarantor_phone_e164",
    "guarantor_ghana_card_fingerprint",
    "guarantor_date_of_birth",
    "contract_legacy_id",
    "contract_reference",
    "contract_start_date",
    "contract_end_date",
    "contract_total_minor_units",
    "principal_minor_units",
    "opening_balance_minor_units",
    "repayment_frequency",
    "tenure_months",
    "vehicle_legacy_id",
    "somoco_vehicle_model",
    "current_balance_minor_units",
    "arrears_minor_units",
    "arrears_as_of_date",
    "total_paid_minor_units",
    "repayment_history_json",
    "installment_schedule_json",
    "attachment_document_id",
  ]) {
    assert.ok(first.schema.required.includes(required), required);
  }
  assert.deepEqual(first.schema.anyOf, [
    { required: ["vehicle_vin"] },
    { required: ["vehicle_chassis_number"] },
  ]);

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
