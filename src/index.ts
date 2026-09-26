#!/usr/bin/env node
/**
 * Evolution API MCP server (stdio).
 *
 * Exposes Evolution API v2 endpoints as MCP tools. Tool groups are selected via
 * the EVOLUTION_TOOLS env var (see config.ts / .env.example).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ZodError } from "zod";

import { loadConfig } from "./config.js";
import { EvolutionClient, EvolutionApiError } from "./client.js";
import { buildRegistry } from "./registry.js";

const PKG_NAME = "evolution-api-mcp";
const PKG_VERSION = "0.2.0";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new EvolutionClient(config);
  const registry = buildRegistry(config);

  console.error(
    `[${PKG_NAME}] ${registry.tools.length} tools from groups: ${registry.enabledGroups.join(", ")}`,
  );

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
      return {
        content: [{ type: "text", text: stringify(data) }],
      };
    } catch (err) {
      return errorResult(describeError(err));
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${PKG_NAME}] ready (stdio)`);
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

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function stringify(data: unknown): string {
  if (data === undefined || data === null) return "null";
  if (typeof data === "string") return data;
  return JSON.stringify(data, null, 2);
}

main().catch((err) => {
  console.error(`[${PKG_NAME}] fatal:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
