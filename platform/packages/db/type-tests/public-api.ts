import type { Database, DatabaseTransaction } from "../src/index.js";
import * as publicApi from "../src/index.js";

// @ts-expect-error @somo/db intentionally exposes no mutable schema subpath.
import type {} from "@somo/db/schema";

type AssertFalse<Value extends false> = Value;
type HasRawMutationSurface<Value> =
  Extract<"delete" | "execute" | "insert" | "update", keyof Value> extends never
    ? false
    : true;

type DatabaseIsOpaque = AssertFalse<HasRawMutationSurface<Database>>;
type TransactionIsOpaque = AssertFalse<
  HasRawMutationSurface<DatabaseTransaction>
>;
type SchemaDescriptorsAreHidden = AssertFalse<
  Extract<"auditEvent" | "ledgerEntry", keyof typeof publicApi> extends never
    ? false
    : true
>;
