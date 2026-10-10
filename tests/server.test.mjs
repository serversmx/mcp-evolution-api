import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../dist/config.js";

const requiredEnv = { EVOLUTION_BASE_URL: "https://evolution.test", EVOLUTION_API_KEY: "test-key" };
const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

test("size limits default to 64 MiB per incoming message and 4 MiB per tool result", () => {
  const config = loadConfig(requiredEnv);
  assert.equal(config.maxMessageBytes, 67108864);
  assert.equal(config.maxResultBytes, 4194304);
});

test("size limits accept positive integer byte counts", () => {
  const config = loadConfig({
    ...requiredEnv,
    EVOLUTION_MAX_MESSAGE_BYTES: " 1048576 ",
    EVOLUTION_MAX_RESULT_BYTES: "2000000",
  });
  assert.equal(config.maxMessageBytes, 1048576);
  assert.equal(config.maxResultBytes, 2000000);
});

test("size limits reject values that are not positive integers instead of truncating them", () => {
  for (const name of ["EVOLUTION_MAX_MESSAGE_BYTES", "EVOLUTION_MAX_RESULT_BYTES"]) {
    for (const value of ["0", "-5", "abc", "64MB", "1.5"]) {
      assert.throws(
        () => loadConfig({ ...requiredEnv, [name]: value }),
        new RegExp(`^Error: ${name} must be a positive integer number of bytes, got: ${value}$`),
        `${name}=${value}`,
      );
    }
  }
});

test("an incoming message over EVOLUTION_MAX_MESSAGE_BYTES is logged as a transport error", { timeout: 10000 }, async () => {
  // Port 9 (discard) refuses connections: no Evolution instance is ever contacted.
  const child = spawn(process.execPath, [entry], {
    env: {
      PATH: process.env.PATH,
      EVOLUTION_BASE_URL: "http://127.0.0.1:9",
      EVOLUTION_API_KEY: "x",
      EVOLUTION_DEFAULT_INSTANCE: "t",
      EVOLUTION_MAX_MESSAGE_BYTES: "4096",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.resume();
  const exited = new Promise((resolve) => child.on("exit", resolve));

  const initialize = {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0.0.0" } },
  };
  const call = {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "evolution_message_send_text", arguments: { number: "15551234567", text: "x".repeat(8192) } },
  };
  child.stdin.write(`${JSON.stringify(initialize)}\n`);
  child.stdin.end(`${JSON.stringify(call)}\n`);
  await exited;

  assert.match(stderr, /\[evolution-api-mcp\] transport error: ReadBuffer exceeded maximum size of 4096 bytes/);
});
