#!/usr/bin/env node
/**
 * Evolution API MCP server (stdio).
 *
 * Exposes Evolution API v2 endpoints as MCP tools. Tool groups are selected via
 * the EVOLUTION_TOOLS env var (see config.ts / .env.example).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { buildRegistry } from "./registry.js";
import { PKG_NAME, createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const registry = buildRegistry(config);

  console.error(
    `[${PKG_NAME}] ${registry.tools.length} tools from groups: ${registry.enabledGroups.join(", ")}`,
  );

  const server = createServer(config, { registry });

  // The SDK closes the transport when a message exceeds maxBufferSize; without
  // onerror the process would exit silently.
  server.onerror = (err) => console.error(`[${PKG_NAME}] transport error: ${err.message}`);
  const transport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: config.maxMessageBytes,
  });
  await server.connect(transport);
  console.error(`[${PKG_NAME}] ready (stdio)`);
}

main().catch((err) => {
  console.error(`[${PKG_NAME}] fatal:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
