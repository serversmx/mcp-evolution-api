/**
 * Opt-in Streamable HTTP mode (MCP_TRANSPORT=http), for hosting the server behind a reverse proxy
 * (Easypanel/Traefik, Cloudflare) so remote clients such as Claude and ChatGPT connectors can use it.
 *
 * Stateless: every POST gets a fresh Server + transport (the SDK refuses to reuse a stateless
 * transport, and a Server can only be connected to one transport at a time). The registry and the
 * Evolution client are immutable, so they are shared across requests.
 *
 * index.ts imports this module lazily, so stdio users never load express or jose.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { Server as HttpServer } from "node:http";

import express, { type Request, type RequestHandler, type Response } from "express";
import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
  type JWTVerifyOptions,
  type JWTVerifyResult,
} from "jose";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import type { EvolutionConfig } from "./config.js";
import { EvolutionClient } from "./client.js";
import type { Registry } from "./registry.js";
import { PKG_NAME, createServer } from "./server.js";

export type AuthMode = "bearer" | "oauth" | "none";

interface OAuthSettings {
  mode: "oauth";
  issuer: string;
  /** Accepted `aud` values: any one of them is enough. */
  audience: string | string[];
  jwksUrl?: URL;
  requiredScopes: string[];
  allowedSubjects?: Set<string>;
}

export interface HttpConfig {
  host: string;
  port: number;
  /** Route of the MCP endpoint: MCP_PATH, else the path of MCP_PUBLIC_URL, else /mcp. */
  path: string;
  /** Public URL of the MCP endpoint (MCP_PUBLIC_URL, normalized; a root URL has path "/"). */
  publicUrl?: URL;
  /** RFC 9728 `resource`: the public URL as users type it into Claude/ChatGPT, no trailing slash. */
  resource?: string;
  /** Hostnames accepted in the Host header; undefined disables the check. */
  allowedHosts?: string[];
  /** Origins accepted in the Origin header, in canonical form (see canonicalOrigin). */
  allowedOrigins: string[];
  jsonResponse: boolean;
  shutdownTimeoutMs: number;
  auth: { mode: "bearer"; tokenDigests: Buffer[] } | OAuthSettings | { mode: "none" };
}

const MIN_TOKEN_LENGTH = 32;
/** RFC 6750 b64token: a token with other characters can never arrive intact in an Authorization header. */
const TOKEN_CHARS = /^[A-Za-z0-9\-._~+/]+=*$/;
/** Literal route characters only, so Express never reads the path as a pattern. */
const PATH_CHARS = /^\/[A-Za-z0-9\-._~/]*$/;
/** Hosts that may use plain http, and that the Host check accepts next to the public hostname. */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1"];
const PRM_PATH = "/.well-known/oauth-protected-resource";
/** Allowed clock skew with the IdP for exp/nbf, in seconds. */
const CLOCK_TOLERANCE_S = 30;
/** Longest client-supplied value (Host, Origin) written to the log, in characters. */
const MAX_LOGGED_VALUE = 200;

/**
 * Text from a client or a token, made safe for a log line: C0 and C1 controls, DEL and U+2028/U+2029
 * become \uXXXX, so it can neither start a forged line nor send terminal escape sequences.
 */
function logSafe(text: string): string {
  return text.replace(
    /[\u0000-\u001f\u007f-\u009f\u{2028}\u{2029}]/gu,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** A client-supplied header value for the log: escaped, and cut to MAX_LOGGED_VALUE characters. */
function logValue(value: string): string {
  return value.length > MAX_LOGGED_VALUE ? `${logSafe(value.slice(0, MAX_LOGGED_VALUE))}…` : logSafe(value);
}

function list(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function flag(env: NodeJS.ProcessEnv, name: string): boolean {
  return env[name]?.trim().toLowerCase() === "true";
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}, got: ${raw}`);
  }
  return value;
}

/** A URL that must use https, except on loopback hosts (local testing). */
function httpsUrl(name: string, raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname))) {
    throw new Error(`${name} must use https (got ${raw})`);
  }
  return url;
}

function parsePublicUrl(raw: string | undefined): URL | undefined {
  if (!raw?.trim()) return undefined;
  const url = httpsUrl("MCP_PUBLIC_URL", raw.trim());
  if (url.search) throw new Error(`MCP_PUBLIC_URL must not have a query string (got ${raw.trim()})`);
  // Canonical form (see resourceOf): no fragment, no trailing slash after the path.
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url;
}

/**
 * The RFC 9728 `resource` must equal what users type: no fragment and no trailing slash, also for a
 * root URL (the MCP spec's canonical form is https://mcp.example.com, not https://mcp.example.com/).
 */
function resourceOf(url: URL): string {
  return url.pathname === "/" ? url.origin : url.href;
}

/** Hostname as the Host check compares it: lowercase, without scheme, port or path. */
function allowedHostname(entry: string): string {
  try {
    return new URL(entry.includes("://") ? entry : `http://${entry}`).hostname;
  } catch {
    throw new Error(`MCP_ALLOWED_HOSTS has an invalid host: ${entry}`);
  }
}

/**
 * Origin as the Origin check compares it: scheme://host[:port], lowercase and without a default port
 * or path, so "https://Claude.ai/" matches "https://claude.ai". "null" and values that are not URLs
 * are kept verbatim.
 */
function canonicalOrigin(value: string): string {
  try {
    const { origin } = new URL(value);
    return origin === "null" ? value : origin;
  } catch {
    return value;
  }
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function loadAuth(env: NodeJS.ProcessEnv, publicUrl: URL | undefined): HttpConfig["auth"] {
  let mode = env.MCP_AUTH_MODE?.trim().toLowerCase();
  if (!mode) {
    const hasToken = Boolean(env.MCP_AUTH_TOKEN?.trim());
    const hasIssuer = Boolean(env.MCP_OAUTH_ISSUER?.trim());
    if (hasToken && hasIssuer) {
      throw new Error(
        "MCP_AUTH_TOKEN and MCP_OAUTH_ISSUER are both set: choose one with MCP_AUTH_MODE=bearer or MCP_AUTH_MODE=oauth",
      );
    }
    mode = hasToken ? "bearer" : hasIssuer ? "oauth" : undefined;
  }

  switch (mode) {
    case "bearer": {
      const tokens = list(env.MCP_AUTH_TOKEN);
      if (tokens.length === 0) throw new Error("MCP_AUTH_MODE=bearer requires MCP_AUTH_TOKEN");
      if (tokens.some((t) => t.length < MIN_TOKEN_LENGTH)) {
        throw new Error(
          `MCP_AUTH_TOKEN values must be at least ${MIN_TOKEN_LENGTH} characters ` +
            "(generate one with: openssl rand -base64 32)",
        );
      }
      if (tokens.some((t) => !TOKEN_CHARS.test(t))) {
        throw new Error(
          "MCP_AUTH_TOKEN values may only contain letters, digits and - . _ ~ + / (and trailing =), " +
            "like the output of: openssl rand -base64 32",
        );
      }
      // A comma-separated list allows rotation: deploy new+old, update clients, drop old.
      return { mode, tokenDigests: tokens.map(sha256) };
    }
    case "oauth": {
      const issuer = env.MCP_OAUTH_ISSUER?.trim();
      if (!issuer) throw new Error("MCP_AUTH_MODE=oauth requires MCP_OAUTH_ISSUER");
      httpsUrl("MCP_OAUTH_ISSUER", issuer);
      if (!publicUrl) throw new Error("MCP_AUTH_MODE=oauth requires MCP_PUBLIC_URL (the RFC 9728 resource)");
      const subjects = list(env.MCP_OAUTH_ALLOWED_SUBJECTS);
      if (subjects.length === 0 && !flag(env, "MCP_OAUTH_ALLOW_ANY_SUBJECT")) {
        throw new Error(
          "MCP_AUTH_MODE=oauth requires MCP_OAUTH_ALLOWED_SUBJECTS (the `sub` of the users allowed to use " +
            "the global Evolution key), or MCP_OAUTH_ALLOW_ANY_SUBJECT=true if the IdP itself only admits them",
        );
      }
      const jwksUrl = env.MCP_OAUTH_JWKS_URL?.trim();
      const resource = resourceOf(publicUrl);
      return {
        mode,
        issuer,
        // A root resource is also accepted with the trailing slash that older clients add.
        audience: env.MCP_OAUTH_AUDIENCE?.trim() || (publicUrl.pathname === "/" ? [resource, `${resource}/`] : resource),
        jwksUrl: jwksUrl ? parseJwksUrl(jwksUrl) : undefined,
        requiredScopes: list(env.MCP_OAUTH_REQUIRED_SCOPES?.replace(/\s+/g, ",")),
        allowedSubjects: subjects.length > 0 ? new Set(subjects) : undefined,
      };
    }
    case "none":
      if (!flag(env, "MCP_ALLOW_UNAUTHENTICATED")) {
        throw new Error(
          "MCP_AUTH_MODE=none exposes the global Evolution API key to anyone who can reach this port; " +
            "set MCP_ALLOW_UNAUTHENTICATED=true only behind a gateway that authenticates every request",
        );
      }
      return { mode };
    case undefined:
      throw new Error(
        "MCP_TRANSPORT=http requires authentication: set MCP_AUTH_TOKEN (static bearer), " +
          "MCP_OAUTH_ISSUER (OAuth resource server) or MCP_AUTH_MODE explicitly",
      );
    default:
      throw new Error(`Unknown MCP_AUTH_MODE: ${mode} (expected bearer, oauth or none)`);
  }
}

/**
 * Hosts that a plain-http JWKS URL may name: loopback, a single-label name (a Docker or Easypanel
 * service such as `keycloak`), a .internal or .local name, or an RFC 1918 / ULA address. A guard
 * against a forgotten "s", not proof that the host is private: DNS can point any name anywhere.
 */
function isPrivateHost(hostname: string): boolean {
  // URL.hostname normalizes IPv4 to dotted decimal and keeps the brackets of an IPv6 address.
  if (hostname.startsWith("[")) return hostname === "[::1]" || /^\[f[cd][0-9a-f]{2}:/.test(hostname);
  const ipv4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(hostname);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return !hostname.includes(".") || /\.(internal|local)$/.test(hostname);
}

/** An operator-chosen JWKS endpoint: https, or plain http to a private host (isPrivateHost). */
function parseJwksUrl(raw: string): URL {
  const url = URL.canParse(raw) ? new URL(raw) : undefined;
  if (url?.protocol !== "https:" && url?.protocol !== "http:") {
    throw new Error(`MCP_OAUTH_JWKS_URL must be an http(s) URL, got: ${raw}`);
  }
  // The key set decides which signatures are trusted: never fetch it in clear over the internet.
  if (url.protocol === "http:" && !isPrivateHost(url.hostname)) {
    throw new Error(
      "MCP_OAUTH_JWKS_URL must use https; plain http is only allowed for loopback, a single-label host " +
        `(e.g. a Docker service), a .internal or .local name, or an RFC 1918/ULA address, got: ${raw}`,
    );
  }
  return url;
}

/** HTTP-only settings. Fails closed: HTTP mode never starts without an explicit auth decision. */
export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const publicUrl = parsePublicUrl(env.MCP_PUBLIC_URL);

  const explicitPath = env.MCP_PATH?.trim();
  const path = explicitPath ? explicitPath.replace(/\/+$/, "") || "/" : (publicUrl?.pathname ?? "/mcp");
  if (!PATH_CHARS.test(path)) {
    throw new Error(
      `MCP_PATH (or the MCP_PUBLIC_URL path) must start with "/" and use only letters, digits and - . _ ~ /, ` +
        `got: ${path}`,
    );
  }
  if (publicUrl && publicUrl.pathname !== path) {
    throw new Error(`MCP_PATH (${path}) must match the path of MCP_PUBLIC_URL (${publicUrl.pathname})`);
  }

  const explicitHosts = list(env.MCP_ALLOWED_HOSTS).map(allowedHostname);
  const allowedHosts =
    explicitHosts.length > 0 ? explicitHosts : publicUrl ? [publicUrl.hostname, ...LOOPBACK_HOSTS] : undefined;

  return {
    host: env.MCP_HOST?.trim() || "127.0.0.1",
    port: positiveInt(env, env.MCP_PORT?.trim() ? "MCP_PORT" : "PORT", 3000, 65535),
    path,
    publicUrl,
    resource: publicUrl && resourceOf(publicUrl),
    allowedHosts,
    allowedOrigins: list(env.MCP_ALLOWED_ORIGINS).map(canonicalOrigin),
    jsonResponse: flag(env, "MCP_JSON_RESPONSE"),
    shutdownTimeoutMs: positiveInt(env, "MCP_SHUTDOWN_TIMEOUT_MS", 8000),
    auth: loadAuth(env, publicUrl),
  };
}

/** Static bearer token(s): constant-time comparison of SHA-256 digests (equal lengths by construction). */
function staticTokenVerifier(digests: Buffer[]): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const candidate = sha256(token);
      // Compare with every digest, so the timing does not reveal which one matched.
      const match = digests.reduce((found, digest) => timingSafeEqual(candidate, digest) || found, false);
      if (!match) throw new InvalidTokenError("Invalid access token");
      // requireBearerAuth rejects tokens without expiresAt; a static token is valid until rotated.
      return { token, clientId: "static-token", scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 3600 };
    },
  };
}

const INVALID_JWT = [
  joseErrors.JWTExpired,
  joseErrors.JWTClaimValidationFailed,
  joseErrors.JWTInvalid,
  joseErrors.JWSInvalid,
  joseErrors.JWSSignatureVerificationFailed,
  joseErrors.JWKSNoMatchingKey,
  joseErrors.JOSEAlgNotAllowed,
  joseErrors.JOSENotSupported,
];

/** Map jose failures: bad token -> 401 invalid_token; IdP/JWKS unreachable -> 500 (no re-auth loop). */
function toAuthError(err: unknown): Error {
  if (err instanceof InvalidTokenError || err instanceof ServerError) return err;
  if (INVALID_JWT.some((cls) => err instanceof cls)) return new InvalidTokenError("Invalid access token");
  return new ServerError("Could not verify the access token (JWKS unavailable)");
}

/** jwks_uri from the issuer's OIDC discovery document, else its RFC 8414 metadata. */
async function discoverJwksUri(issuer: string): Promise<URL> {
  const base = new URL(issuer);
  const candidates = [
    new URL(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`),
    new URL(`/.well-known/oauth-authorization-server${base.pathname.replace(/\/+$/, "")}`, base),
  ];
  for (const url of candidates) {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
    if (!res?.ok) {
      await res?.body?.cancel();
      continue;
    }
    const meta = (await res.json().catch(() => ({}))) as { issuer?: unknown; jwks_uri?: unknown };
    if (meta.issuer === issuer && typeof meta.jwks_uri === "string") return new URL(meta.jwks_uri);
  }
  throw new ServerError(`Could not discover jwks_uri for issuer ${issuer}`);
}

/** The issuer's key set: MCP_OAUTH_JWKS_URL or discovered; memoized once found, retried after a failure. */
function issuerKeys(auth: OAuthSettings): () => Promise<ReturnType<typeof createRemoteJWKSet>> {
  let keys: Promise<ReturnType<typeof createRemoteJWKSet>> | undefined;
  return () => {
    keys ??= (auth.jwksUrl ? Promise.resolve(auth.jwksUrl) : discoverJwksUri(auth.issuer))
      .then((url) => createRemoteJWKSet(url))
      .catch((err: unknown) => {
        keys = undefined;
        throw err;
      });
    return keys;
  };
}

function scopesOf(payload: JWTPayload): string[] {
  const { scope, scp } = payload as { scope?: unknown; scp?: unknown };
  if (typeof scope === "string") return scope.split(" ").filter(Boolean);
  if (Array.isArray(scp)) return scp.filter((s): s is string => typeof s === "string");
  return [];
}

/** Failure reason for the log: the error message plus its cause code (e.g. ECONNREFUSED), never the token. */
function reasonOf(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err.cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? `${err.message} (${code})` : err.message;
}

/** Log reason when MCP_OAUTH_ALLOWED_SUBJECTS does not list a token's `sub` (null when it has none). */
function subjectReason(sub: unknown): string {
  return `sub ${JSON.stringify(sub ?? null)} is not in MCP_OAUTH_ALLOWED_SUBJECTS`;
}

/**
 * jwtVerify against the issuer's key set. A token without a string `kid` can match several keys (two
 * keys of one type during a rotation): jose then hands over the candidates, and each one is tried.
 */
async function verifyJwt(token: string, keys: JWTVerifyGetKey, options: JWTVerifyOptions): Promise<JWTVerifyResult> {
  try {
    return await jwtVerify(token, keys, options);
  } catch (err) {
    if (!(err instanceof joseErrors.JWKSMultipleMatchingKeys)) throw err;
    for await (const key of err) {
      try {
        return await jwtVerify(token, key, options);
      } catch (inner) {
        if (!(inner instanceof joseErrors.JWSSignatureVerificationFailed)) throw inner;
      }
    }
    throw new joseErrors.JWSSignatureVerificationFailed();
  }
}

function oauthVerifier(auth: OAuthSettings, resource: URL): OAuthTokenVerifier {
  const keys = issuerKeys(auth);
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      // Why a token failed, for the operator only; clients get a generic error.
      let reason: string | undefined;
      try {
        const { payload } = await verifyJwt(token, await keys(), {
          issuer: auth.issuer,
          audience: auth.audience,
          clockTolerance: CLOCK_TOLERANCE_S,
          requiredClaims: ["exp"],
        });
        // Without a string sub the token is malformed for this server (401). A valid token for an
        // account that is not listed gets 403 from subjectGuard instead.
        if (auth.allowedSubjects && (typeof payload.sub !== "string" || !payload.sub)) {
          reason = subjectReason(payload.sub);
          throw new InvalidTokenError("Token has no subject");
        }
        const claims = payload as Record<string, unknown>;
        return {
          token,
          clientId: String(claims.client_id ?? claims.azp ?? "unknown"),
          scopes: scopesOf(payload),
          // requireBearerAuth re-checks expiry without leeway: give it the same tolerance as jwtVerify.
          expiresAt: (payload.exp as number) + CLOCK_TOLERANCE_S,
          resource,
          extra: { sub: payload.sub },
        };
      } catch (err) {
        const authError = toAuthError(err);
        const outcome = authError instanceof ServerError ? "token check unavailable" : "token rejected";
        // jose quotes parts of the token in some messages (e.g. an unknown "crit" name): escape them.
        console.error(`[${PKG_NAME}] ${outcome}: ${logSafe(reason ?? reasonOf(err))}`);
        throw authError;
      }
    },
  };
}

/**
 * MCP_OAUTH_ALLOWED_SUBJECTS, checked after the token: a valid token for an account that is not listed
 * gets 403 without a WWW-Authenticate challenge. A 401 would make clients sign in again as the same
 * account, in a loop, and insufficient_scope would start a step-up flow that cannot help either.
 */
function subjectGuard(allowed: Set<string>): RequestHandler {
  return (req, res, next) => {
    const sub = req.auth?.extra?.sub;
    if (typeof sub === "string" && allowed.has(sub)) return next();
    console.error(`[${PKG_NAME}] token rejected: ${logSafe(subjectReason(sub))}`);
    jsonRpcError(res, 403, "This account is not allowed to use this server");
  };
}

/** The middleware every request to the MCP endpoint goes through first (none for MCP_AUTH_MODE=none). */
function authGuard(http: HttpConfig, resourceMetadataUrl: string | undefined): RequestHandler[] {
  switch (http.auth.mode) {
    case "bearer":
      return [requireBearerAuth({ verifier: staticTokenVerifier(http.auth.tokenDigests) })];
    case "oauth": {
      const bearer = requireBearerAuth({
        verifier: oauthVerifier(http.auth, http.publicUrl!),
        requiredScopes: http.auth.requiredScopes,
        resourceMetadataUrl,
      });
      return http.auth.allowedSubjects ? [bearer, subjectGuard(http.auth.allowedSubjects)] : [bearer];
    }
    case "none":
      return [];
  }
}

/**
 * DNS-rebinding / misrouting guard: the Host header must name an allowed hostname (any port). Same
 * checks and 403 bodies as the SDK's hostHeaderValidation, plus a log line with the rejected value.
 */
function hostGuard(allowedHosts: string[]): RequestHandler {
  return (req, res, next) => {
    const host = req.headers.host ?? "";
    let hostname: string | undefined;
    try {
      hostname = new URL(`http://${host}`).hostname;
    } catch {
      // Not a host at all: rejected below.
    }
    if (host && hostname !== undefined && allowedHosts.includes(hostname)) return next();
    console.error(`[${PKG_NAME}] rejected Host "${logValue(host)}": not in MCP_ALLOWED_HOSTS / MCP_PUBLIC_URL`);
    if (!host) return jsonRpcError(res, 403, "Missing Host header");
    jsonRpcError(res, 403, hostname === undefined ? `Invalid Host header: ${host}` : `Invalid Host: ${hostname}`);
  };
}

function jsonRpcError(res: Response, status: number, message: string, headers: Record<string, string> = {}) {
  res.status(status).set(headers).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

export async function startHttp(config: EvolutionConfig, registry: Registry, http: HttpConfig): Promise<HttpServer> {
  const client = new EvolutionClient(config);
  const app = express();
  app.disable("x-powered-by");

  // No cache may replay a response: a CDN that stores GETs by default would otherwise keep serving a
  // stale /health, or a 404 for the OAuth metadata, long after the server changed.
  app.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  // Access log on stderr: method, path, status, duration. Never headers or bodies (tokens, messages).
  app.use((req, res, next) => {
    if (req.path === "/health") return next(); // container healthchecks every 30 s
    const started = process.hrtime.bigint();
    res.on("close", () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      console.error(`[${PKG_NAME}] ${req.method} ${req.path} ${res.statusCode} ${ms.toFixed(1)}ms`);
    });
    next();
  });

  // Liveness only: does not call Evolution, needs no auth, answers any Host (container healthchecks).
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // RFC 9728 protected resource metadata (OAuth mode): path-suffixed and root, as Claude probes both.
  let resourceMetadataUrl: string | undefined;
  if (http.auth.mode === "oauth" && http.publicUrl) {
    const metadata = {
      resource: http.resource,
      authorization_servers: [http.auth.issuer],
      bearer_methods_supported: ["header"],
      resource_name: "Evolution API MCP",
      ...(http.auth.requiredScopes.length > 0 && { scopes_supported: http.auth.requiredScopes }),
    };
    // RFC 9728 section 3.1: the suffix goes between host and path; a root resource has no path to add.
    const suffixed = http.path === "/" ? PRM_PATH : `${PRM_PATH}${http.path}`;
    resourceMetadataUrl = new URL(suffixed, http.publicUrl).href;
    app.get([...new Set([suffixed, PRM_PATH])], (_req, res) => {
      res.set("Access-Control-Allow-Origin", "*").json(metadata);
    });
  }

  // DNS-rebinding / misrouting guard: Host must be the public hostname (port-agnostic).
  if (http.allowedHosts) app.use(hostGuard(http.allowedHosts));
  else console.error(`[${PKG_NAME}] warning: Host header not validated (set MCP_PUBLIC_URL or MCP_ALLOWED_HOSTS)`);

  // MCP spec: an Origin that is present and not allowed MUST get 403. Hosted clients such as claude.ai
  // have been seen sending one, so a rejection is logged with the value to add to MCP_ALLOWED_ORIGINS.
  app.use((req, res, next) => {
    const origin = req.header("origin");
    if (!origin || http.allowedOrigins.includes(canonicalOrigin(origin))) return next();
    console.error(`[${PKG_NAME}] rejected Origin "${logValue(origin)}": not in MCP_ALLOWED_ORIGINS`);
    jsonRpcError(res, 403, `Origin not allowed: ${origin}`);
  });

  const guard = authGuard(http, resourceMetadataUrl);

  app.post(http.path, ...guard, async (req: Request, res: Response) => {
    const server = createServer(config, { registry, client });
    // Transport errors can echo client input (e.g. the MCP-Protocol-Version header): escape it.
    server.onerror = (err) => console.error(`[${PKG_NAME}] mcp: ${logSafe(err.message)}`);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: http.jsonResponse,
      // No express.json(): the transport reads the body itself, bounded like the stdio buffer.
      maxRequestBodySize: config.maxMessageBytes,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error(`[${PKG_NAME}] request failed: ${logSafe(err instanceof Error ? err.message : String(err))}`);
      if (!res.headersSent) jsonRpcError(res, 500, "Internal server error");
    }
  });

  // Stateless: no standalone SSE stream (GET) and no sessions to delete (DELETE).
  app.all(http.path, ...guard, (_req, res) => jsonRpcError(res, 405, "Method not allowed.", { Allow: "POST" }));

  app.use((_req, res) => jsonRpcError(res, 404, "Not found"));

  const httpServer = await new Promise<HttpServer>((resolve, reject) => {
    const server = app.listen(http.port, http.host, (err?: Error) => (err ? reject(err) : resolve(server)));
  });

  const shutdown = (signal: string) => {
    // Stop accepting connections first, then let in-flight requests finish.
    httpServer.close(() => process.exit(0));
    console.error(`[${PKG_NAME}] ${signal}: draining in-flight requests (max ${http.shutdownTimeoutMs}ms)`);
    // Keep-alive sockets become idle as responses finish; sweep them so close() can complete.
    setInterval(() => httpServer.closeIdleConnections(), 100).unref();
    setTimeout(() => {
      httpServer.closeAllConnections();
      process.exit(0);
    }, http.shutdownTimeoutMs).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  return httpServer;
}
