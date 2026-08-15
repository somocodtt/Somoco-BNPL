import { buildApp, type BuildAppOptions } from "./app.js";
import { loadConfig, validateConfig, type AppConfig } from "./config.js";
import {
  loadProductionIdentityComposition,
  validateProductionIdentityComposition,
  type ProductionIdentityComposition,
} from "./production-composition.js";

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
  if (productionRuntime) {
    const loaded =
      options.loadComposition === undefined
        ? await loadProductionIdentityComposition(env)
        : await options.loadComposition();
    identity = validateProductionIdentityComposition(loaded);
  }
  const build = options.build ?? buildApp;
  const app = await build({
    config,
    ...(identity === undefined ? {} : { identity }),
  });
  await app.listen({ host: config.host, port: config.port });
  return app;
}
