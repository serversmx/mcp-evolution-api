/**
 * Loads and validates configuration from environment variables.
 */

export interface EvolutionConfig {
  baseUrl: string;
  apiKey: string;
  defaultInstance?: string;
  timeoutMs: number;
  /** Largest incoming message (bytes): stdio line or HTTP request body. */
  maxMessageBytes: number;
  /** Largest serialized tool result (bytes) returned to the client. */
  maxResultBytes: number;
  /** Raw allowlist string from EVOLUTION_TOOLS (parsed by the registry). */
  toolsAllowlist?: string;
}

export type Transport = "stdio" | "http";

/** MCP_TRANSPORT: stdio (default) or http (Streamable HTTP, see http.ts). */
export function loadTransport(env: NodeJS.ProcessEnv = process.env): Transport {
  const transport = env.MCP_TRANSPORT?.trim().toLowerCase() || "stdio";
  if (transport !== "stdio" && transport !== "http") {
    throw new Error(`MCP_TRANSPORT must be "stdio" or "http", got: ${env.MCP_TRANSPORT}`);
  }
  return transport;
}

/** claude.ai caps a tool result at about 150,000 characters; stdio clients accept far more. */
const DEFAULT_RESULT_BYTES: Record<Transport, number> = { stdio: 4 * 1024 * 1024, http: 150000 };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): EvolutionConfig {
  const baseUrl = env.EVOLUTION_BASE_URL?.trim();
  const apiKey = env.EVOLUTION_API_KEY?.trim();

  const missing: string[] = [];
  if (!baseUrl) missing.push("EVOLUTION_BASE_URL");
  if (!apiKey) missing.push("EVOLUTION_API_KEY");
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        `See .env.example for setup.`,
    );
  }

  const timeoutRaw = env.EVOLUTION_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : 30000;
  if (Number.isNaN(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`EVOLUTION_TIMEOUT_MS must be a positive integer, got: ${timeoutRaw}`);
  }

  return {
    // Strip a single trailing slash so we can join paths predictably.
    baseUrl: baseUrl!.replace(/\/+$/, ""),
    apiKey: apiKey!,
    defaultInstance: env.EVOLUTION_DEFAULT_INSTANCE?.trim() || undefined,
    timeoutMs,
    maxMessageBytes: byteLimit(env, "EVOLUTION_MAX_MESSAGE_BYTES", 64 * 1024 * 1024),
    maxResultBytes: byteLimit(env, "EVOLUTION_MAX_RESULT_BYTES", DEFAULT_RESULT_BYTES[loadTransport(env)]),
    toolsAllowlist: env.EVOLUTION_TOOLS?.trim() || undefined,
  };
}

/** Optional byte limit: digits only, so "64MB" fails loudly instead of meaning 64 bytes. */
function byteLimit(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer number of bytes, got: ${raw}`);
  }
  return value;
}
