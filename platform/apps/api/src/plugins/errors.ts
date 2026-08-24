import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    readonly publicDetail: string,
  ) {
    super(code);
    this.name = "AppError";
  }
}

interface ProblemDetails {
  type: "about:blank";
  title: string;
  status: number;
  detail: string;
  instance: string;
  requestId: string;
  code?: string;
}

export async function registerProblemErrors(
  app: FastifyInstance,
): Promise<void> {
  app.setNotFoundHandler(async (request, reply) => {
    await sendProblem(request, reply, 404, "Route not found.");
  });

  app.setErrorHandler(
    async (error: FastifyError | AppError, request, reply) => {
      const mapped = mapError(error);
      if (mapped.status >= 500) {
        request.log.error({ err: error }, "request failed");
      }
      await sendProblem(
        request,
        reply,
        mapped.status,
        mapped.detail,
        mapped.code,
      );
    },
  );
}

function mapError(error: FastifyError | AppError): {
  status: number;
  code?: string;
  detail: string;
} {
  if (error instanceof AppError) {
    return {
      status: error.statusCode,
      code: error.code,
      detail: error.publicDetail,
    };
  }
  if (error.validation !== undefined) {
    return {
      status: 400,
      code: "VALIDATION_ERROR",
      detail: "Request validation failed.",
    };
  }
  if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
    return {
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
      detail: "Request body is too large.",
    };
  }
  if (error.statusCode === 429) {
    return {
      status: 429,
      code: "RATE_LIMITED",
      detail: "Too many requests.",
    };
  }
  return {
    status:
      error.statusCode !== undefined && error.statusCode < 500
        ? error.statusCode
        : 500,
    code: error.code,
    detail:
      error.statusCode !== undefined && error.statusCode < 500
        ? "Request could not be processed."
        : "An unexpected error occurred.",
  };
}

async function sendProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  detail: string,
  code?: string,
): Promise<void> {
  const problem: ProblemDetails = {
    type: "about:blank",
    title: titleForStatus(status),
    status,
    detail,
    instance: request.url,
    requestId: request.id,
    ...(code === undefined ? {} : { code }),
  };
  await reply
    .code(status)
    .type("application/problem+json; charset=utf-8")
    .send(problem);
}

function titleForStatus(status: number): string {
  switch (status) {
    case 400:
      return "Bad Request";
    case 401:
      return "Unauthorized";
    case 403:
      return "Forbidden";
    case 404:
      return "Not Found";
    case 409:
      return "Conflict";
    case 413:
      return "Payload Too Large";
    case 429:
      return "Too Many Requests";
    case 503:
      return "Service Unavailable";
    default:
      return status >= 500 ? "Internal Server Error" : "Request Error";
  }
}
