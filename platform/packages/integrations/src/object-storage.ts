import { createHash, createHmac } from "node:crypto";
import {
  CopyObjectCommand,
  GetObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { markProductionAdapter } from "./provenance.js";

export interface ImmutableObjectIdentity {
  objectKey: string;
  versionId: string;
  etag: string;
}

export interface ObjectStoragePort {
  createUploadTicket(input: {
    objectKey: string;
    expiresAt: Date;
    requiredHeaders: Readonly<Record<string, string>>;
  }): Promise<{
    uploadUrl: string;
    requiredHeaders: Readonly<Record<string, string>>;
  }>;
  readObject(input: {
    objectKey: string;
    maxBytes: number;
    versionId?: string;
  }): Promise<{
    bytes: Uint8Array;
    contentLength: number;
    contentType?: string;
    metadata: Readonly<Record<string, string>>;
    versionId: string;
    etag: string;
  }>;
  promoteToImmutable(input: {
    stagingObjectKey: string;
    stagingVersionId: string;
    stagingEtag: string;
    immutableObjectKey: string;
  }): Promise<ImmutableObjectIdentity>;
  createDownloadTicket(input: {
    objectKey: string;
    versionId: string;
    etag: string;
    expiresAt: Date;
  }): Promise<{
    downloadUrl: string;
    expiresAt: string;
    requiredHeaders: Readonly<Record<string, string>>;
  }>;
}

export interface S3ObjectStorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export function createS3ObjectStorage(
  input: S3ObjectStorageConfig,
): ObjectStoragePort {
  const config = validateS3Config(input);
  const credentials = {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    ...(config.sessionToken === undefined
      ? {}
      : { sessionToken: config.sessionToken }),
  };
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials,
    forcePathStyle: true,
  });

  return markProductionAdapter(
    {
      async createUploadTicket(ticket) {
        const requiredHeaders = Object.freeze(
          normalizeHeaders(ticket.requiredHeaders),
        );
        return {
          uploadUrl: presign({
            config,
            method: "PUT",
            objectKey: ticket.objectKey,
            expiresAt: ticket.expiresAt,
            requiredHeaders,
          }),
          requiredHeaders,
        };
      },

      async readObject(read) {
        positiveInteger(read.maxBytes, "maxBytes");
        const response = await client.send(
          new GetObjectCommand({
            Bucket: config.bucket,
            Key: validateObjectKey(read.objectKey),
            ...(read.versionId === undefined
              ? {}
              : { VersionId: validateVersionId(read.versionId) }),
          }),
        );
        if (
          response.ContentLength !== undefined &&
          response.ContentLength > read.maxBytes
        ) {
          throw new Error("OBJECT_TOO_LARGE");
        }
        if (response.Body === undefined) throw new Error("OBJECT_BODY_MISSING");
        if (response.VersionId === undefined || response.ETag === undefined) {
          throw new Error("OBJECT_VERSION_IDENTITY_MISSING");
        }
        const bytes = await readBoundedBody(response.Body, read.maxBytes);
        return {
          bytes,
          contentLength: response.ContentLength ?? bytes.byteLength,
          ...(response.ContentType === undefined
            ? {}
            : { contentType: response.ContentType }),
          metadata: Object.freeze({ ...(response.Metadata ?? {}) }),
          versionId: response.VersionId,
          etag: normalizeEtag(response.ETag),
        };
      },

      async promoteToImmutable(promote) {
        const stagingObjectKey = validateObjectKey(promote.stagingObjectKey);
        const stagingVersionId = validateVersionId(promote.stagingVersionId);
        const stagingEtag = normalizeEtag(promote.stagingEtag);
        const immutableObjectKey = validateObjectKey(
          promote.immutableObjectKey,
        );
        const response = await client.send(
          new CopyObjectCommand({
            Bucket: config.bucket,
            Key: immutableObjectKey,
            CopySource: encodeCopySource(
              config.bucket,
              stagingObjectKey,
              stagingVersionId,
            ),
            CopySourceIfMatch: stagingEtag,
            MetadataDirective: "COPY",
          }),
        );
        const copiedEtag = response.CopyObjectResult?.ETag;
        if (response.VersionId === undefined || copiedEtag === undefined) {
          throw new Error("IMMUTABLE_OBJECT_VERSION_IDENTITY_MISSING");
        }
        return Object.freeze({
          objectKey: immutableObjectKey,
          versionId: response.VersionId,
          etag: normalizeEtag(copiedEtag),
        });
      },

      async createDownloadTicket(ticket) {
        const requiredHeaders = Object.freeze({
          "if-match": normalizeEtag(ticket.etag),
        });
        return {
          downloadUrl: presign({
            config,
            method: "GET",
            objectKey: ticket.objectKey,
            versionId: ticket.versionId,
            expiresAt: ticket.expiresAt,
            requiredHeaders,
          }),
          expiresAt: ticket.expiresAt.toISOString(),
          requiredHeaders,
        };
      },
    },
    "OBJECT_STORAGE",
  );
}

async function readBoundedBody(
  body: unknown,
  maxBytes: number,
): Promise<Uint8Array> {
  if (
    typeof body !== "object" ||
    body === null ||
    !(Symbol.asyncIterator in body)
  ) {
    throw new Error("OBJECT_BODY_UNSUPPORTED");
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const value of body as AsyncIterable<unknown>) {
    const chunk = toBytes(value);
    length += chunk.byteLength;
    if (length > maxBytes) throw new Error("OBJECT_TOO_LARGE");
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return new TextEncoder().encode(value);
  throw new Error("OBJECT_BODY_INVALID");
}

function presign(input: {
  config: Readonly<S3ObjectStorageConfig>;
  method: "GET" | "PUT";
  objectKey: string;
  versionId?: string;
  expiresAt: Date;
  requiredHeaders: Readonly<Record<string, string>>;
}): string {
  const now = new Date();
  const expiresSeconds = Math.ceil(
    (input.expiresAt.getTime() - now.getTime()) / 1_000,
  );
  if (expiresSeconds <= 0 || expiresSeconds > 604_800) {
    throw new Error("S3_PRESIGN_EXPIRY_INVALID");
  }
  const endpoint = new URL(input.config.endpoint);
  const path = `${endpoint.pathname.replace(/\/$/, "")}/${encodePathSegment(
    input.config.bucket,
  )}/${canonicalObjectKey(input.objectKey)}`;
  const host = endpoint.host;
  const amzDate = now
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, "")
    .replace("Z", "Z");
  const shortDate = amzDate.slice(0, 8);
  const scope = `${shortDate}/${input.config.region}/s3/aws4_request`;
  const headers = normalizeHeaders({ host, ...input.requiredHeaders });
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${headers[name]}\n`)
    .join("");
  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${input.config.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresSeconds),
    "X-Amz-SignedHeaders": signedHeaders,
    ...(input.versionId === undefined
      ? {}
      : { versionId: validateVersionId(input.versionId) }),
    ...(input.config.sessionToken === undefined
      ? {}
      : { "X-Amz-Security-Token": input.config.sessionToken }),
  };
  const canonicalQuery = encodeQuery(query);
  const canonicalRequest = [
    input.method,
    path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join("\n");
  const signature = createHmac(
    "sha256",
    signingKey(input.config.secretAccessKey, shortDate, input.config.region),
  )
    .update(stringToSign)
    .digest("hex");
  return `${endpoint.protocol}//${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

function signingKey(secret: string, date: string, region: string): Uint8Array {
  const dateKey = createHmac("sha256", `AWS4${secret}`).update(date).digest();
  const regionKey = createHmac("sha256", Uint8Array.from(dateKey))
    .update(region)
    .digest();
  const serviceKey = createHmac("sha256", Uint8Array.from(regionKey))
    .update("s3")
    .digest();
  return Uint8Array.from(
    createHmac("sha256", Uint8Array.from(serviceKey))
      .update("aws4_request")
      .digest(),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function encodeQuery(query: Readonly<Record<string, string>>): string {
  return Object.entries(query)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${encode(name)}=${encode(value)}`)
    .join("&");
}

function canonicalObjectKey(key: string): string {
  return validateObjectKey(key).split("/").map(encodePathSegment).join("/");
}

function encodePathSegment(value: string): string {
  return encode(value);
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function normalizeHeaders(
  input: Readonly<Record<string, string>>,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = rawName.trim().toLowerCase();
    if (!/^[a-z0-9-]+$/.test(name) || name === "authorization") {
      throw new Error("S3_SIGNED_HEADER_INVALID");
    }
    const value = rawValue.trim().replace(/\s+/g, " ");
    if (value === "" || /[\r\n]/.test(rawValue)) {
      throw new Error("S3_SIGNED_HEADER_INVALID");
    }
    output[name] = value;
  }
  return output;
}

function validateS3Config(
  input: S3ObjectStorageConfig,
): Readonly<S3ObjectStorageConfig> {
  const endpoint = new URL(input.endpoint);
  if (!["https:", "http:"].includes(endpoint.protocol)) {
    throw new Error("S3 endpoint must use HTTP or HTTPS");
  }
  for (const [name, value] of Object.entries({
    region: input.region,
    bucket: input.bucket,
    accessKeyId: input.accessKeyId,
    secretAccessKey: input.secretAccessKey,
  })) {
    if (value.trim() === "") throw new Error(`S3 ${name} is required`);
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket)) {
    throw new Error("S3 bucket is invalid");
  }
  return Object.freeze({ ...input, endpoint: endpoint.toString() });
}

function validateObjectKey(key: string): string {
  if (
    key.length === 0 ||
    key.length > 1_024 ||
    key.startsWith("/") ||
    key.includes("\\") ||
    key.split("/").some((segment) => segment === "" || segment === "..")
  ) {
    throw new Error("OBJECT_KEY_INVALID");
  }
  return key;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function encodeCopySource(
  bucket: string,
  objectKey: string,
  versionId: string,
): string {
  return `/${encodePathSegment(bucket)}/${canonicalObjectKey(objectKey)}?versionId=${encode(
    versionId,
  )}`;
}

function validateVersionId(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 1_024) {
    throw new Error("OBJECT_VERSION_ID_INVALID");
  }
  return normalized;
}

function normalizeEtag(value: string): string {
  const normalized = value.trim();
  if (!/^(?:"[0-9a-fA-F]{32,64}"|[0-9a-fA-F]{32,64})$/.test(normalized)) {
    throw new Error("OBJECT_ETAG_INVALID");
  }
  return normalized;
}
