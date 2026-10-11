#!/usr/bin/env node
/**
 * Evolution API MCP server.
 *
 * Exposes Evolution API v2 endpoints as MCP tools. Tool groups are selected via
 * the EVOLUTION_TOOLS env var (see config.ts / .env.example).
 *
 * Transport: stdio by default; MCP_TRANSPORT=http serves Streamable HTTP (see http.ts).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig, loadTransport } from "./config.js";
import { buildRegistry } from "./registry.js";
import { PKG_NAME, createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const mode = loadTransport();
  const registry = buildRegistry(config);

  console.error(
    `[${PKG_NAME}] ${registry.tools.length} tools from groups: ${registry.enabledGroups.join(", ")}`,
  );

  if (mode === "http") {
    // Loaded lazily so stdio users never import express or jose.
    const { loadHttpConfig, startHttp } = await import("./http.js");
    const http = loadHttpConfig();
    await startHttp(config, registry, http);
    console.error(
      `[${PKG_NAME}] ready (http) on ${http.host}:${http.port}${http.path} auth=${http.auth.mode}` +
        (http.resource ? ` public=${http.resource}` : ""),
    );
    return;
  }

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
