import {
  claimOutboxBatch,
  completeOutboxAttempt,
  exceptOutboxAttempt,
  heartbeatOutboxClaim,
  scheduleOutboxRetry,
  type Database,
} from "@somo/db";
import type { OutboxClaimStore } from "./jobs/dispatch-outbox.js";

export function createDatabaseOutboxStore(db: Database): OutboxClaimStore {
  const store: OutboxClaimStore = {
    claim: (options) =>
      claimOutboxBatch(db, {
        workerId: options.workerId,
        limit: options.limit,
        claimLeaseMs: options.claimLeaseMs,
        maxAttempts: options.maxAttempts,
      }),
    heartbeat: (input) => heartbeatOutboxClaim(db, input),
    complete: (input) => completeOutboxAttempt(db, input),
    retry: (input) => scheduleOutboxRetry(db, input),
    except: (input) => exceptOutboxAttempt(db, input),
  };
  return Object.freeze(store);
}
