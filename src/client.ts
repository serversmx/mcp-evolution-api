/**
 * Thin HTTP client for the Evolution API v2.
 *
 * Responsibilities:
 *  - Inject the `apikey` header on every request.
 *  - Build URLs from the configured base URL + query params.
 *  - Parse JSON responses and surface API errors as a typed error.
 *  - Resolve the target instance (explicit arg or configured default).
 *
 * The API key is never included in error messages or logs.
 */

import type { EvolutionConfig } from "./config.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface RequestOptions {
  /** JSON object or multipart FormData for POST/PUT/DELETE. */
  body?: unknown;
  /** Query string params. Undefined/null values are skipped. */
  query?: Record<string, string | number | boolean | undefined | null>;
}

/** Error thrown for an HTTP error or an Evolution `{error:true}` response. */
export class EvolutionApiError extends Error {
  readonly status: number;
  readonly responseBody: unknown;
  /** Machine-readable error code when the server sends one (e.g. "LICENSE_REQUIRED"). */
  readonly code?: string;

  constructor(status: number, message: string, responseBody: unknown, code?: string) {
    super(message);
    this.name = "EvolutionApiError";
    this.status = status;
    this.responseBody = responseBody;
    this.code = code;
  }
}

/**
 * Error raised by a tool before any write request is sent, when the arguments
 * (merged with the current server state) still cannot satisfy the API contract.
 */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/** URL-encode a single path segment (instance names, bot ids, ...). */
export function seg(value: unknown): string {
  return encodeURIComponent(String(value));
}

export class EvolutionClient {
  constructor(private readonly config: EvolutionConfig) {}

  /**
   * Resolve the instance to operate on: explicit value wins, otherwise the
   * configured default. Throws a clear error if neither is available.
   *
   * Returns the name URL-encoded, ready to be used as a path segment
   * (`/message/sendText/${inst}`). Evolution reads it from the path only.
   */
  resolveInstance(explicit?: string): string {
    const inst = explicit?.trim() || this.config.defaultInstance;
    if (!inst) {
      throw new Error(
        "No instance provided and EVOLUTION_DEFAULT_INSTANCE is not set. " +
          "Pass `instance` in the tool call or configure a default.",
      );
    }
    return seg(inst);
  }

  get<T = unknown>(path: string, opts: Omit<RequestOptions, "body"> = {}): Promise<T> {
    return this.request<T>("GET", path, opts);
  }

  post<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("POST", path, opts);
  }

  put<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("PUT", path, opts);
  }

  delete<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("DELETE", path, opts);
  }

  async request<T = unknown>(
    method: HttpMethod,
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    const url = this.buildUrl(path, opts.query);

    const headers: Record<string, string> = {
      apikey: this.config.apiKey,
      Accept: "application/json",
    };

    let bodyInit: string | FormData | undefined;
    if (opts.body !== undefined && method !== "GET") {
      if (opts.body instanceof FormData) {
        // fetch must generate the multipart boundary and Content-Type together.
        bodyInit = opts.body;
      } else {
        headers["Content-Type"] = "application/json";
        bodyInit = JSON.stringify(opts.body);
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    let res: Response;
    let text: string;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: bodyInit,
        signal: controller.signal,
      });
      // Keep the timeout active until the response body has finished arriving.
      text = await res.text();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Request timed out after ${this.config.timeoutMs}ms: ${method} ${path}`);
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Network error calling Evolution API (${method} ${path}): ${reason}`);
    } finally {
      clearTimeout(timer);
    }

    const parsed = text ? safeJsonParse(text) : null;

    // connect/restart swallow controller exceptions and return HTTP 200.
    const reportedError = parsed && typeof parsed === "object" &&
      (parsed as Record<string, unknown>).error === true;
    if (!res.ok || reportedError) {
      throw buildApiError(res.status, parsed);
    }

    return parsed as T;
  }

  private buildUrl(path: string, query?: RequestOptions["query"]): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(this.config.baseUrl + normalizedPath);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Some endpoints may return plain text; preserve it.
    return text;
  }
}

/** Map a non-2xx response to an EvolutionApiError with the most useful message. */
function buildApiError(status: number, body: unknown): EvolutionApiError {
  const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;

  // 2.4+ license gate: every business route answers 503 until the server is activated.
  if (status === 503 && obj?.code === "LICENSE_REQUIRED") {
    const registerUrl = typeof obj.register_url === "string" ? obj.register_url : undefined;
    const message =
      "Evolution API server is not activated (503 LICENSE_REQUIRED, license gate of Evolution API 2.4+). " +
      (registerUrl ? `Activate it at ${registerUrl}. ` : "Open <server>/manager/login to activate it. ") +
      "Business API calls fail until the license is activated; retrying will not help.";
    return new EvolutionApiError(status, message, body, "LICENSE_REQUIRED");
  }

  let message = extractApiMessage(body, status);

  // Express answers "Cannot POST /x" for routes it does not know: the endpoint is not
  // available in this server version (e.g. a 2.4-only route called on 2.3.7).
  if (status === 404 && /Cannot (GET|POST|PUT|DELETE) \//.test(message)) {
    message +=
      " (this route does not exist on the server: the endpoint probably requires a newer " +
      "Evolution API version, e.g. 2.4+)";
  }

  const code = typeof obj?.code === "string" ? obj.code : undefined;
  return new EvolutionApiError(status, message, body, code);
}

/**
 * Pull a human-readable message out of Evolution's error response shapes.
 *
 * Standard envelope: `{status, error: "Bad Request", response: {message: [...]}}`.
 * `response.message` carries the validation details, so it wins over the generic
 * `error` text. `/template/*` and `/business/*` use `{message: <string>, details}`.
 */
export function extractApiMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    const response =
      obj.response && typeof obj.response === "object"
        ? (obj.response as Record<string, unknown>)
        : undefined;
    const candidates = [response?.message, obj.message, obj.error];
    for (const candidate of candidates) {
      const text = formatMessage(candidate);
      if (text) {
        const details = formatDetails(obj.details);
        return details ? `${text} (${details})` : text;
      }
    }
  }
  if (typeof body === "string" && body.trim()) return body;
  return `Evolution API returned HTTP ${status}`;
}

function formatMessage(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) {
    const parts = value.map((v) => formatMessage(v)).filter((v): v is string => Boolean(v));
    return parts.length > 0 ? parts.join("; ") : undefined;
  }
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    // Number not on WhatsApp: {jid, exists: false, number}
    if (o.exists === false && ("number" in o || "jid" in o)) {
      return `Number ${String(o.number ?? o.jid)} is not on WhatsApp (jid ${String(o.jid)})`;
    }
    // Group validation errors: {property, message}
    if (typeof o.message === "string") {
      return typeof o.property === "string" ? `${o.property}: ${o.message}` : o.message;
    }
    return JSON.stringify(value);
  }
  return String(value);
}

/** Meta Graph error details returned by /template/* and /business/*. */
function formatDetails(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const d = details as Record<string, unknown>;
  const userMsg = typeof d.error_user_msg === "string" ? d.error_user_msg : undefined;
  const waError = typeof d.whatsapp_error === "string" ? d.whatsapp_error : undefined;
  return userMsg ?? waError;
}
