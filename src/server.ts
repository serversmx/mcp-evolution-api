/**
 * MCP server wiring: ListTools/CallTool handlers backed by the tool registry.
 *
 * Importing this module has no side effects; the stdio entry point is index.ts.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ZodError } from "zod";

import type { EvolutionConfig } from "./config.js";
import { EvolutionClient, EvolutionApiError } from "./client.js";
import { buildRegistry, type Registry } from "./registry.js";

export const PKG_NAME = "evolution-api-mcp";
export const PKG_VERSION = "0.3.0";

export interface ServerDeps {
  client?: EvolutionClient;
  registry?: Registry;
}

/** Build the MCP server; the caller connects it to a transport. */
export function createServer(config: EvolutionConfig, deps: ServerDeps = {}): Server {
  const client = deps.client ?? new EvolutionClient(config);
  const registry = deps.registry ?? buildRegistry(config);

  const server = new Server(
    { name: PKG_NAME, version: PKG_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Tool[] = registry.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: toInputSchema(t.inputSchema),
    }));
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const tool = registry.byName.get(name);
    if (!tool) {
      return errorResult(`Unknown tool: ${name}`);
    }

    try {
      const args = tool.inputSchema.parse(rawArgs ?? {});
      const data = await tool.handler(client, args as Record<string, unknown>);
      const text = stringify(data);
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > config.maxResultBytes) {
        return oversizeResult(name, data, bytes, config.maxResultBytes);
      }
      return {
        content: [{ type: "text", text }],
      };
    } catch (err) {
      return errorResult(describeError(err));
    }
  });

  return server;
}

/** Convert a zod schema to a JSON Schema object suitable for MCP inputSchema. */
function toInputSchema(schema: Parameters<typeof zodToJsonSchema>[0]): Tool["inputSchema"] {
  const json = zodToJsonSchema(schema, { target: "jsonSchema7", $refStrategy: "none" }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  if (json.type !== "object") {
    return { type: "object", properties: {} };
  }
  return json as Tool["inputSchema"];
}

function describeError(err: unknown): string {
  if (err instanceof ZodError) {
    const issues = err.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return `Invalid arguments: ${issues}`;
  }
  if (err instanceof EvolutionApiError) {
    return `Evolution API error (HTTP ${err.status}): ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Its result is the media itself, so it is never pruned: returned whole or withheld. */
const MEDIA_TOOL = "evolution_chat_media_base64";

/** Strings above this many UTF-8 bytes are omitted from an oversized result. */
const MAX_KEPT_STRING_BYTES = 64 * 1024;

interface Omission {
  path: string;
  bytes: number;
}

/**
 * Result for data above EVOLUTION_MAX_RESULT_BYTES. Strings over 64 KiB (e.g. the file a media
 * send echoes in message.base64 when webhook base64 is on) are replaced by a placeholder and the
 * rest is returned as a normal result when it fits; otherwise an error summarizes the data.
 */
function oversizeResult(tool: string, data: unknown, bytes: number, limit: number) {
  if (tool !== MEDIA_TOOL && data !== null && typeof data === "object") {
    const omitted: Omission[] = [];
    const pruned = omitLargeStrings(data, "", omitted);
    if (omitted.length > 0) {
      const text = JSON.stringify(pruned);
      if (Buffer.byteLength(text, "utf8") <= limit) {
        const list = omitted.map((o) => `${o.path} (${o.bytes} bytes)`).join(", ");
        const note =
          `Omitted ${omitted.length} value${omitted.length === 1 ? "" : "s"} over 64 KiB to fit ` +
          `EVOLUTION_MAX_RESULT_BYTES=${limit} (full result: ${bytes} bytes): ${list}.`;
        return {
          content: [
            { type: "text" as const, text },
            { type: "text" as const, text: note },
          ],
        };
      }
    }
  }
  return errorResult(oversizeMessage(tool, data, bytes, limit));
}

/** Copy of `value` with every string over 64 KiB replaced by "<omitted: N bytes>". */
function omitLargeStrings(value: unknown, path: string, omitted: Omission[]): unknown {
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes <= MAX_KEPT_STRING_BYTES) return value;
    omitted.push({ path, bytes });
    return `<omitted: ${bytes} bytes>`;
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => omitLargeStrings(item, `${path}[${i}]`, omitted));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        omitLargeStrings(item, path ? `${path}.${key}` : key, omitted),
      ]),
    );
  }
  return value;
}

/** Fields that identify a withheld result: a sent message's key, media details. */
const SUMMARY_FIELDS = ["key", "mimetype", "fileName", "mediaType", "messageType", "size"];
const MAX_SUMMARY_KEYS = 20;

const MEDIA_HINT =
  "Download the media from its URL instead (message.mediaUrl when S3/MinIO storage is enabled), or, on " +
  "WHATSAPP-BAILEYS instances, receive new media as base64 in webhooks (evolution_webhook_set base64: true; " +
  "Evolution applies it after the instance reconnects, e.g. evolution_instance_restart). Raise the limit with care: " +
  "Claude Code drops MCP connections whose messages exceed 10 MiB (Claude Desktop: 32 MiB).";

/** The guard only runs after a 2xx response, so the send already went through. */
const SEND_HINT =
  "Evolution API accepted this send (HTTP 2xx); only its response is too large to return. " +
  "Do not retry it: a retry sends the message again.";

/** Error text for a result above EVOLUTION_MAX_RESULT_BYTES: its size, shape and an alternative. */
function oversizeMessage(tool: string, data: unknown, bytes: number, limit: number): string {
  const parts = [`Result too large: ${bytes} bytes exceeds EVOLUTION_MAX_RESULT_BYTES=${limit}.`];
  if (Array.isArray(data)) {
    parts.push(`Array of ${data.length} items.`);
  } else if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const keys = Object.keys(obj);
    const more = keys.length > MAX_SUMMARY_KEYS ? ` (+${keys.length - MAX_SUMMARY_KEYS} more)` : "";
    parts.push(`Top-level keys: ${keys.slice(0, MAX_SUMMARY_KEYS).join(", ")}${more}.`);
    const fields = SUMMARY_FIELDS.filter((k) => obj[k] !== undefined && obj[k] !== null).map(
      (k) => `${k}: ${typeof obj[k] === "string" ? obj[k] : JSON.stringify(obj[k])}`,
    );
    if (fields.length > 0) parts.push(`${fields.join("; ")}.`);
  }
  if (tool === MEDIA_TOOL) {
    parts.push(MEDIA_HINT);
  } else if (tool.startsWith("evolution_message_send_")) {
    parts.push(SEND_HINT);
  } else {
    parts.push("Narrow the request (filters, pagination) to get a smaller result.");
  }
  return parts.join(" ");
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

/** Compact JSON: indentation only costs the client's output-token budget. */
function stringify(data: unknown): string {
  if (data === undefined || data === null) return "null";
  if (typeof data === "string") return data;
  return JSON.stringify(data);
}
