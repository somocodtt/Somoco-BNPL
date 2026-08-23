import { buildApp, type BuildAppOptions } from "./app.js";
import { loadConfig, validateConfig, type AppConfig } from "./config.js";
import {
  loadProductionIdentityComposition,
  validateProductionIdentityComposition,
  type ProductionIdentityComposition,
} from "./production-composition.js";
import { verifyPilotGates } from "./pilot-gates.js";

export { validateProductionIdentityComposition };

interface ListenableApp {
  listen(options: { host: string; port: number }): Promise<unknown>;
}

export async function bootstrapApi(
  options: {
    config?: AppConfig;
    env?: Readonly<Record<string, string | undefined>>;
    build?: (options: BuildAppOptions) => Promise<ListenableApp>;
    loadComposition?: () => Promise<unknown>;
  } = {},
): Promise<ListenableApp> {
  const env = options.env ?? process.env;
  const config =
    options.config === undefined
      ? loadConfig(env)
      : validateConfig(options.config);
  const productionRuntime =
    config.environment === "production" || env.NODE_ENV === "production";
  let identity: ProductionIdentityComposition | undefined;
  let applications: BuildAppOptions["applications"];
  if (productionRuntime) {
    const loaded =
      options.loadComposition === undefined
        ? await loadProductionIdentityComposition(env)
        : await options.loadComposition();
    identity = validateProductionIdentityComposition(loaded);
    applications = loadProductionApplicationPolicy(env);
    await verifyPilotGates({
      environment: "production",
      ...(env.PILOT_GATE_EVIDENCE_FILE === undefined
        ? {}
        : { evidenceFile: env.PILOT_GATE_EVIDENCE_FILE }),
      ...(env.PILOT_GATE_PUBLIC_KEY_PEM === undefined
        ? {}
        : { publicKey: env.PILOT_GATE_PUBLIC_KEY_PEM }),
    });
  }
  const build = options.build ?? buildApp;
  const app = await build({
    config,
    ...(identity === undefined ? {} : { identity }),
    ...(applications === undefined ? {} : { applications }),
  });
  await app.listen({ host: config.host, port: config.port });
  return app;
}

function loadProductionApplicationPolicy(
  env: Readonly<Record<string, string | undefined>>,
): NonNullable<BuildAppOptions["applications"]> {
  const invitationHashSecret = env.APPLICATION_INVITATION_HASH_SECRET;
  const ttlValue = env.APPLICATION_INVITATION_TTL_MS;
  const documentsValue = env.APPLICATION_REQUIRED_DOCUMENT_TYPES;
  const invitationTtlMs =
    ttlValue === undefined ? Number.NaN : Number(ttlValue);
  const requiredDocumentTypes =
    documentsValue
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ?? [];
  if (
    invitationHashSecret === undefined ||
    invitationHashSecret.length < 32 ||
    !Number.isSafeInteger(invitationTtlMs) ||
    invitationTtlMs < 1 ||
    requiredDocumentTypes.length === 0 ||
    requiredDocumentTypes.some((value) => !/^[A-Z][A-Z0-9_]{1,63}$/.test(value))
  ) {
    throw new Error("PRODUCTION_APPLICATION_POLICY_REQUIRED");
  }
  return { invitationHashSecret, invitationTtlMs, requiredDocumentTypes };
}
