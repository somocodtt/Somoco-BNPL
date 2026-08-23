import type { FastifyInstance } from "fastify";
import type { ApiRequest, ApiResponse } from "./pilot-client.js";

export function createApiRequest(app: FastifyInstance): ApiRequest {
  return {
    get: (url, options) => inject(app, "GET", url, options),
    post: (url, options) => inject(app, "POST", url, options),
    patch: (url, options) => inject(app, "PATCH", url, options),
  };
}

async function inject(
  app: FastifyInstance,
  method: "GET" | "POST" | "PATCH",
  url: string,
  options: Record<string, unknown> = {},
): Promise<ApiResponse> {
  const headers = (options.headers ?? {}) as Record<string, string>;
  const payload =
    options.data === undefined ? undefined : JSON.stringify(options.data);
  const response = await app.inject({
    method,
    url: new URL(url).pathname,
    headers,
    ...(payload === undefined ? {} : { payload }),
  });
  return {
    status: () => response.statusCode,
    json: async () => response.json(),
    text: async () => response.body,
  };
}
