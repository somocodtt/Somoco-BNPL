/* global process */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TEMPLATE_VERSION = "legacy-v1";
export const HEADERS = Object.freeze([
  "source_record_id",
  "source_row_number",
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
  "repayment_frequency",
  "tenure_months",
  "vehicle_legacy_id",
  "vehicle_vin",
  "vehicle_chassis_number",
  "somoco_vehicle_model",
  "current_balance_minor_units",
  "arrears_minor_units",
  "repayment_history_json",
  "attachment_document_id",
]);

export function generateLegacyTemplate(version = TEMPLATE_VERSION) {
  if (version !== TEMPLATE_VERSION) throw new Error("UNKNOWN_TEMPLATE_VERSION");
  const csv = `${HEADERS.join(",")}\r\n`;
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `somo://migration/${version}`,
    title: "Somo legacy BNPL migration row",
    type: "object",
    additionalProperties: false,
    required: [
      "source_record_id",
      "source_row_number",
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
      "repayment_frequency",
      "tenure_months",
      "vehicle_legacy_id",
      "somoco_vehicle_model",
      "current_balance_minor_units",
      "arrears_minor_units",
      "repayment_history_json",
      "attachment_document_id",
    ],
    properties: Object.fromEntries(
      HEADERS.map((header) => [
        header,
        { type: header === "source_row_number" ? "integer" : "string" },
      ]),
    ),
    anyOf: [
      { required: ["vehicle_vin"] },
      { required: ["vehicle_chassis_number"] },
    ],
  };
  const schemaJson = `${JSON.stringify(schema, null, 2)}\n`;
  return Object.freeze({
    version,
    headers: HEADERS,
    csv,
    schema,
    schemaJson,
    csvSha256: sha256(csv),
    schemaSha256: sha256(schemaJson),
    containsMacros: false,
    containsFormulas: false,
  });
}

export async function writeLegacyTemplate(outputDirectory) {
  const directory = resolve(outputDirectory);
  const template = generateLegacyTemplate();
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, `somo-legacy-${template.version}.csv`),
    template.csv,
    "utf8",
  );
  await writeFile(
    resolve(directory, `somo-legacy-${template.version}.schema.json`),
    template.schemaJson,
    "utf8",
  );
  return template;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const output = process.argv[2] ?? "./generated-legacy-template";
  const template = await writeLegacyTemplate(output);
  process.stdout.write(
    JSON.stringify({
      version: template.version,
      csvSha256: template.csvSha256,
      schemaSha256: template.schemaSha256,
    }) + "\n",
  );
}
