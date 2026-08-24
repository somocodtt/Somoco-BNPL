import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { ProductionConnectorBoundary, SmsPort } from "@somo/integrations";
import { createClamAvMalwareScanner } from "./malware-scanner.js";
import { createS3ObjectStorage } from "./object-storage.js";
import {
  deriveOtpCode,
  otpDerivationKeyId,
  validateOtpDeliveryPolicy,
} from "./otp-delivery.js";
import {
  IntegrationTemporaryError,
  createCreditBureauSimulator,
  createErpSimulator,
  createNiaSimulator,
  createPaymentWebhookSimulator,
  createSmsSimulator,
  createTrackerSimulator,
} from "./simulators/index.js";

const checkedAt = "2026-08-14T12:00:00.000Z";

describe("deterministic integration simulators", () => {
  it("derives a stable OTP from a non-database secret and challenge id", () => {
    const secret = "synthetic-otp-delivery-secret-at-least-32-characters";
    const challengeId = "00000000-0000-4000-8000-000000000001";

    expect(deriveOtpCode(secret, challengeId, 6)).toMatch(/^[0-9]{6}$/);
    expect(deriveOtpCode(secret, challengeId, 6)).toBe(
      deriveOtpCode(secret, challengeId, 6),
    );
    expect(deriveOtpCode(secret, challengeId, 6)).not.toBe(
      deriveOtpCode(secret, "00000000-0000-4000-8000-000000000002", 6),
    );
    const derivationKeyId = otpDerivationKeyId(secret);
    expect(derivationKeyId).toMatch(/^otp-delivery-v1:[0-9a-f]{32}$/);
    expect(
      validateOtpDeliveryPolicy({
        derivationSecret: secret,
        derivationKeyId,
        codeLength: 6,
      }),
    ).toEqual({ derivationKeyId, codeLength: 6 });
    expect(() =>
      validateOtpDeliveryPolicy({
        derivationSecret: secret,
        derivationKeyId: "otp-delivery-v2:mismatch",
        codeLength: 6,
      }),
    ).toThrow("OTP_DERIVATION_KEY_ID_INVALID");
  });
  it("returns the configured NIA decision for an exact fixture", async () => {
    const nia = createNiaSimulator({
      environment: "test",
      fixtures: [
        {
          input: {
            correlationId: "correlation-1001",
            ghanaCardNumber: "GHA-000000001-1",
            consentId: "consent-1001",
          },
          result: {
            providerReference: "nia-sim-1001",
            decision: "MATCH",
            checkedAt,
          },
        },
      ],
    });

    await expect(
      nia.verify({
        correlationId: "correlation-1001",
        ghanaCardNumber: "GHA-000000001-1",
        consentId: "consent-1001",
      }),
    ).resolves.toEqual({
      providerReference: "nia-sim-1001",
      decision: "MATCH",
      checkedAt,
    });
    await expect(
      nia.verify({
        correlationId: "correlation-unknown",
        ghanaCardNumber: "GHA-999999999-9",
        consentId: "consent-unknown",
      }),
    ).rejects.toThrow("SIMULATOR_FIXTURE_NOT_FOUND");
  });

  it("returns one SMS acceptance for repeated idempotent sends", async () => {
    const sms = createSmsSimulator({
      environment: "test",
      fixtures: [
        {
          input: {
            idempotencyKey: "notification-1001",
            phoneE164: "+233201234567",
            template: "PAYMENT_RECEIPT",
            variables: { amount: "GHS 125.00" },
          },
          result: {
            providerReference: "sms-sim-1001",
            acceptedAt: checkedAt,
          },
        },
      ],
    });
    const input = {
      idempotencyKey: "notification-1001",
      phoneE164: "+233201234567",
      template: "PAYMENT_RECEIPT",
      variables: { amount: "GHS 125.00" },
    } as const;

    const first = await sms.send(input);
    const duplicate = await sms.send(input);

    expect(first).toEqual({
      providerReference: "sms-sim-1001",
      acceptedAt: checkedAt,
    });
    expect(duplicate).toEqual(first);
  });

  it("exposes tracker fixtures through a read-only lookup", async () => {
    const tracker = createTrackerSimulator({
      environment: "test",
      fixtures: [
        {
          trackerId: "tracker-1001",
          result: {
            latitude: "5.603717",
            longitude: "-0.186964",
            recordedAt: checkedAt,
            deviceStatus: "ONLINE",
          },
        },
      ],
    });

    const result = await tracker.getLastKnown({ trackerId: "tracker-1001" });

    expect(result).toEqual({
      latitude: "5.603717",
      longitude: "-0.186964",
      recordedAt: checkedAt,
      deviceStatus: "ONLINE",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(await tracker.getLastKnown({ trackerId: "missing" })).toBeNull();
  });

  it("keeps the credit-bureau adapter in explicit manual mode", () => {
    const bureau = createCreditBureauSimulator({ environment: "test" });

    expect(bureau.mode).toBe("MANUAL");
  });

  it("rejects a payment webhook that does not match a signature fixture", async () => {
    const rawBody = new TextEncoder().encode('{"eventId":"evt-1001"}');
    const verifier = createPaymentWebhookSimulator({
      environment: "test",
      fixtures: [
        {
          signature: "fixture-signature",
          requestTimestamp: checkedAt,
          rawBody,
          event: {
            eventId: "evt-1001",
            eventType: "PAYMENT_SUCCEEDED",
            channel: "MOBILE_MONEY",
            providerTransactionId: "txn-1001",
            payerPhoneE164: "+233201234567",
            customerReference: "customer-1001",
            amount: { currency: "GHS", minorUnits: "12500" },
            occurredAt: checkedAt,
          },
        },
      ],
    });

    await expect(
      verifier.verify({
        signature: "invalid-signature",
        requestTimestamp: checkedAt,
        rawBody,
      }),
    ).rejects.toThrow("PAYMENT_SIGNATURE_INVALID");
  });

  it("raises only the configured sanitized ERP temporary failure code", async () => {
    const erp = createErpSimulator({
      environment: "test",
      fixtures: [
        {
          eventId: "event-1001",
          outcome: {
            type: "TEMPORARY_FAILURE",
            code: "ERP_UNAVAILABLE",
          },
        },
      ],
    });

    const error = await erp
      .publish({
        eventId: "event-1001",
        eventType: "PaymentPosted",
        aggregateId: "contract-1001",
        occurredAt: checkedAt,
        payload: { amountMinorUnits: "12500" },
      })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(IntegrationTemporaryError);
    expect(error).toMatchObject({
      code: "ERP_UNAVAILABLE",
      retryable: true,
      message: "INTEGRATION_TEMPORARY_FAILURE",
    });
    expect(JSON.stringify(error)).not.toContain("12500");
  });

  it("rejects every simulator factory in production", () => {
    const factories = [
      () => createNiaSimulator({ environment: "production", fixtures: [] }),
      () => createSmsSimulator({ environment: "production", fixtures: [] }),
      () => createTrackerSimulator({ environment: "production", fixtures: [] }),
      () => createCreditBureauSimulator({ environment: "production" }),
      () =>
        createPaymentWebhookSimulator({
          environment: "production",
          fixtures: [],
        }),
      () => createErpSimulator({ environment: "production", fixtures: [] }),
    ];

    for (const create of factories) {
      expect(create).toThrow("SIMULATOR_FORBIDDEN_IN_PRODUCTION");
    }
  });

  it("rejects every simulator when the actual runtime is production despite a test assertion", () => {
    const priorNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const factories = [
        () => createNiaSimulator({ environment: "test", fixtures: [] }),
        () => createSmsSimulator({ environment: "test", fixtures: [] }),
        () => createTrackerSimulator({ environment: "test", fixtures: [] }),
        () => createCreditBureauSimulator({ environment: "test" }),
        () =>
          createPaymentWebhookSimulator({
            environment: "test",
            fixtures: [],
          }),
        () => createErpSimulator({ environment: "test", fixtures: [] }),
      ];

      for (const create of factories) {
        expect(create).toThrow("SIMULATOR_FORBIDDEN_IN_PRODUCTION");
      }
    } finally {
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorNodeEnv;
    }
  });
});

describe("production document adapters", () => {
  it("constructs legitimate external SMS and NIA connectors through a constrained package-root boundary", async () => {
    const api = (await import("@somo/integrations")) as Record<string, unknown>;
    expect(api["createProductionConnectorBoundary"]).toBeTypeOf("function");
    const createBoundary = api[
      "createProductionConnectorBoundary"
    ] as () => ProductionConnectorBoundary;
    const boundary = createBoundary();
    const sms = boundary.register({
      kind: "SMS",
      provenance: externalProvenance("ghana-sms"),
      adapter: {
        async send() {
          return {
            providerReference: "external-sms-1",
            acceptedAt: checkedAt,
          };
        },
      },
    });
    const nia = boundary.register({
      kind: "NIA",
      provenance: externalProvenance("ghana-nia"),
      adapter: {
        async verify() {
          return {
            providerReference: "external-nia-1",
            decision: "REVIEW" as const,
            checkedAt,
          };
        },
      },
    });
    const payments = boundary.register({
      kind: "PAYMENTS",
      provenance: externalProvenance("somoco-payments"),
      adapter: {
        async verify() {
          return {
            eventId: "event-1",
            eventType: "PAYMENT_SUCCEEDED" as const,
            channel: "MOBILE_MONEY" as const,
            providerTransactionId: "transaction-1",
            payerPhoneE164: "+233201234567",
            customerReference: "contract-1",
            amount: { currency: "GHS" as const, minorUnits: "10000" },
            occurredAt: checkedAt,
          };
        },
      },
    });

    expect(boundary.require(sms, "SMS")).toBe(sms);
    expect(boundary.require(nia, "NIA")).toBe(nia);
    expect(boundary.require(payments, "PAYMENTS")).toBe(payments);
    expect(Object.isFrozen(sms)).toBe(true);
    expect(Object.isFrozen(nia)).toBe(true);
    expect(() =>
      boundary.register({
        kind: "SMS",
        provenance: externalProvenance("wrong-method"),
        adapter: {
          verify: async () => undefined,
        } as unknown as SmsPort,
      }),
    ).toThrow("PRODUCTION_CONNECTOR_METHOD_INVALID");
  });

  it("constructs the attested allocation-policy verifier only through the external boundary", async () => {
    const boundary = (
      await import("./index.js")
    ).createProductionConnectorBoundary();
    let observed = false;
    const verifier = boundary.register({
      kind: "ALLOCATION_POLICY_EVIDENCE",
      provenance: externalProvenance("allocation-policy-verifier"),
      adapter: {
        async verify(input) {
          observed = input.signedBytes instanceof Uint8Array;
          return { attestationReference: "external-attestation-1001" };
        },
      },
    });

    expect(boundary.require(verifier, "ALLOCATION_POLICY_EVIDENCE")).toBe(
      verifier,
    );
    await expect(
      verifier.verify({
        signedBytes: new Uint8Array([1, 2, 3]),
        evidence: {
          artifactHash: "a".repeat(64),
          financeApprovedBy: "finance-1001",
          complianceApprovedBy: "compliance-1001",
          financeSignature: "finance-signature-1001",
          complianceSignature: "compliance-signature-1001",
          financeApprovedAt: checkedAt,
          complianceApprovedAt: checkedAt,
          policyVersion: "finance-policy-v1",
          executionKey: "SOMOCO_DEPOSIT_OR_INSTALLMENT_V1",
          allocationEngineDigest: "b".repeat(64),
        },
      }),
    ).resolves.toEqual({
      attestationReference: "external-attestation-1001",
    });
    expect(observed).toBe(true);
    expect(Object.isFrozen(verifier)).toBe(true);
  });

  it("constructs only the provider-neutral read-only tracker connector", async () => {
    const api = (await import("./index.js")) as Record<string, unknown>;
    const createBoundary = api[
      "createProductionConnectorBoundary"
    ] as () => ProductionConnectorBoundary;
    const boundary = createBoundary();
    const tracker = boundary.register({
      kind: "TRACKER",
      provenance: externalProvenance("ghana-tracker"),
      adapter: {
        async getLastKnown() {
          return {
            latitude: "5.6",
            longitude: "-0.1",
            recordedAt: checkedAt,
            deviceStatus: "ONLINE" as const,
          };
        },
        immobilize: async () => undefined,
      },
    });

    expect(boundary.require(tracker, "TRACKER")).toBe(tracker);
    expect(Object.keys(tracker)).toEqual(["getLastKnown"]);
    expect("immobilize" in tracker).toBe(false);
  });

  it("does not let direct or wrapped simulators cross the external connector boundary", async () => {
    const api = (await import("@somo/integrations")) as Record<string, unknown>;
    const createBoundary = api[
      "createProductionConnectorBoundary"
    ] as () => ProductionConnectorBoundary;
    const boundary = createBoundary();
    const simulator = createSmsSimulator({
      environment: "test",
      fixtures: [
        {
          input: {
            idempotencyKey: "wrapped-simulator",
            phoneE164: "+233201234567",
            template: "TEST",
            variables: {},
          },
          result: {
            providerReference: "simulator-result",
            acceptedAt: checkedAt,
          },
        },
      ],
    });
    expect(() =>
      boundary.register({
        kind: "SMS",
        provenance: externalProvenance("direct-simulator"),
        adapter: simulator,
      }),
    ).toThrow("SIMULATOR_FORBIDDEN_IN_PRODUCTION");

    const wrapped = boundary.register({
      kind: "SMS",
      provenance: externalProvenance("wrapped-simulator"),
      adapter: {
        send: (input: Parameters<typeof simulator.send>[0]) =>
          simulator.send(input),
      },
    });
    await expect(
      wrapped.send({
        idempotencyKey: "wrapped-simulator",
        phoneE164: "+233201234567",
        template: "TEST",
        variables: {},
      }),
    ).rejects.toThrow("SIMULATOR_FORBIDDEN_IN_PRODUCTION");
  });

  it("exposes a read-only production connector boundary without an attestation writer", async () => {
    const api = (await import("./index.js")) as Record<string, unknown>;

    expect(api["requireProductionConnector"]).toBeTypeOf("function");
    expect(api["markProductionAdapter"]).toBeUndefined();
    const requireConnector = api["requireProductionConnector"] as (
      adapter: object,
      capability: "OBJECT_STORAGE",
    ) => object;
    const storage = createS3ObjectStorage(s3Config("http://127.0.0.1:9000"));
    expect(requireConnector(storage, "OBJECT_STORAGE")).toBe(storage);
    const wrapper = {
      createUploadTicket: storage.createUploadTicket.bind(storage),
      readObject: storage.readObject.bind(storage),
      promoteToImmutable: storage.promoteToImmutable.bind(storage),
      createDownloadTicket: storage.createDownloadTicket.bind(storage),
    };
    expect(() => requireConnector(wrapper, "OBJECT_STORAGE")).toThrow(
      "PRODUCTION_CONNECTOR_CAPABILITY_REQUIRED",
    );
  });
  it("binds every required upload header into an expiring S3 signature", async () => {
    const storage = createS3ObjectStorage(s3Config("http://127.0.0.1:9000"));
    const requiredHeaders = {
      "content-length": "68",
      "content-type": "image/png",
      "x-amz-meta-somo-document-id": "document-1001",
      "x-amz-meta-somo-person-id": "person-1001",
      "x-amz-meta-somo-upload-ticket": "opaque-ticket-1001",
    } as const;

    const ticket = await storage.createUploadTicket({
      objectKey: "identity/person-1001/document-1001/evidence.png",
      expiresAt: new Date(Date.now() + 60_000),
      requiredHeaders,
    });
    const url = new URL(ticket.uploadUrl);

    expect(ticket.requiredHeaders).toEqual(requiredHeaders);
    expect(url.pathname).toBe(
      "/somo-test/identity/person-1001/document-1001/evidence.png",
    );
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
      [
        "content-length",
        "content-type",
        "host",
        ...Object.keys(requiredHeaders).slice(2),
      ]
        .sort()
        .join(";"),
    );
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stops a chunked S3 object read as soon as the bound byte limit is exceeded", async () => {
    const server = createHttpServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "x-amz-version-id": "version-bounded-1",
        etag: '"0123456789abcdef0123456789abcdef"',
      });
      response.write(Buffer.alloc(4, 1));
      response.end(Buffer.alloc(4, 2));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const storage = createS3ObjectStorage(
      s3Config(`http://127.0.0.1:${address.port}`),
    );
    try {
      await expect(
        storage.readObject({ objectKey: "bounded/object.bin", maxBytes: 5 }),
      ).rejects.toThrow("OBJECT_TOO_LARGE");
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("signs downloads for the exact immutable object version and ETag", async () => {
    const storage = createS3ObjectStorage(s3Config("http://127.0.0.1:9000"));
    const ticket = await storage.createDownloadTicket({
      objectKey: "identity-accepted/person-1001/document-1001/evidence.png",
      versionId: "opaque-version-1001",
      etag: "0123456789abcdef0123456789abcdef",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const url = new URL(ticket.downloadUrl);

    expect(url.searchParams.get("versionId")).toBe("opaque-version-1001");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain("if-match");
    expect(ticket.requiredHeaders).toEqual({
      "if-match": "0123456789abcdef0123456789abcdef",
    });
  });

  it("uses ClamAV INSTREAM framing and accepts only an explicit clean result", async () => {
    let request = Buffer.alloc(0);
    const server = createTcpServer((socket) => {
      socket.on("data", (chunk: Buffer) => {
        request = Buffer.concat([request, chunk]);
        if (request.subarray(-4).equals(Buffer.alloc(4))) {
          socket.end("stream: OK\0");
        }
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const scanner = createClamAvMalwareScanner({
      host: "127.0.0.1",
      port: address.port,
      timeoutMs: 2_000,
      maxBytes: 1_024,
      maxResponseBytes: 256,
    });
    try {
      await expect(
        scanner.scan({
          objectKey: "identity/document-1001",
          bytes: Uint8Array.from([1, 2, 3, 4]),
        }),
      ).resolves.toEqual({
        verdict: "CLEAN",
        scannerReference: "CLAMAV_OK",
      });
      expect(request.subarray(0, 10).toString()).toBe("zINSTREAM\0");
      expect(request.readUInt32BE(10)).toBe(4);
      expect(request.subarray(14, 18)).toEqual(Buffer.from([1, 2, 3, 4]));
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it.each([
    ["missing terminator", "stream: OK"],
    ["malformed prefix", "garbagestream: OK\0"],
    ["trailing data", "stream: OK\0TRAIL"],
    ["oversized response", `${"X".repeat(4_096)} OK\0`],
  ])("fails closed on a %s ClamAV response", async (_label, responseFrame) => {
    const server = createTcpServer((socket) => {
      socket.on("data", (chunk: Buffer) => {
        if (chunk.subarray(-4).equals(Buffer.alloc(4))) {
          socket.end(responseFrame);
        }
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const scanner = createClamAvMalwareScanner({
      host: "127.0.0.1",
      port: address.port,
      timeoutMs: 1_000,
      maxBytes: 1_024,
      maxResponseBytes: 256,
    });
    try {
      await expect(
        scanner.scan({
          objectKey: "identity/document-malformed",
          bytes: Uint8Array.from([1]),
        }),
      ).resolves.toMatchObject({ verdict: "ERROR" });
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("enforces an absolute ClamAV deadline despite response trickle", async () => {
    const server = createTcpServer({ allowHalfOpen: true }, (socket) => {
      let request = Buffer.alloc(0);
      let responding = false;
      socket.on("data", (chunk: Buffer) => {
        request = Buffer.concat([request, chunk]);
        if (responding || !request.subarray(-4).equals(Buffer.alloc(4))) return;
        responding = true;
        const interval = setInterval(() => socket.write("x"), 15);
        const completion = setTimeout(() => {
          clearInterval(interval);
          if (!socket.destroyed) socket.end("stream: OK\0");
        }, 150);
        socket.on("close", () => {
          clearInterval(interval);
          clearTimeout(completion);
        });
        socket.on("error", () => undefined);
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const scanner = createClamAvMalwareScanner({
      host: "127.0.0.1",
      port: address.port,
      timeoutMs: 50,
      maxBytes: 1_024,
      maxResponseBytes: 256,
    });
    try {
      await expect(
        scanner.scan({
          objectKey: "identity/document-trickle",
          bytes: Uint8Array.from([1]),
        }),
      ).rejects.toThrow("MALWARE_SCANNER_TIMEOUT");
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});

function externalProvenance(connectorId: string) {
  return {
    packageName: "@somo-external/synthetic-provider",
    packageVersion: "1.2.3",
    connectorId,
  };
}

function s3Config(endpoint: string) {
  return {
    endpoint,
    region: "test-region-1",
    bucket: "somo-test",
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
  };
}
