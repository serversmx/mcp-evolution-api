import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../dist/config.js";
import { createServer } from "../dist/server.js";

const requiredEnv = { EVOLUTION_BASE_URL: "https://evolution.test", EVOLUTION_API_KEY: "test-key" };
const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const serverConfig = {
  baseUrl: "https://evolution.test",
  apiKey: "test-key",
  defaultInstance: "main",
  timeoutMs: 1000,
  maxMessageBytes: 67108864,
  maxResultBytes: 4194304,
};

/** MCP client connected in-process to createServer(config). */
async function connect(t, overrides = {}) {
  const server = createServer({ ...serverConfig, ...overrides });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(() => client.close());
  return client;
}

/** Answer every fetch with `body` as JSON and record the requests. */
function mockEvolution(t, body, status = 200) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url: String(url), method: init.method, body: init.body });
    return new Response(JSON.stringify(body), { status });
  });
  return requests;
}

const labels = [{ id: "1", name: "New customer", color: 1, predefinedId: "1" }];

/** getBase64FromMediaMessage response (Evolution API 2.3.7). */
function mediaBase64(base64) {
  return {
    mediaType: "videoMessage",
    fileName: "clip.mp4",
    caption: "Vídeo 🎬",
    size: { fileLength: "4500000", height: 720, width: 1280 },
    mimetype: "video/mp4",
    base64,
    buffer: null,
  };
}

const sentKey = { remoteJid: "5215512345678@s.whatsapp.net", fromMe: true, id: "3EB0C767D26A1D0F7A71B2" };
const sendMediaArgs = { number: "5215512345678", mediatype: "video", media: "https://cdn.example.test/clip.mp4" };

/**
 * sendMedia response (Evolution API 2.3.7 prepareMessage of the sent video; buffers serialize as
 * indexed objects, Longs as {low, high, unsigned}). With webhook base64 enabled,
 * sendMessageWithTyping also echoes the file in message.base64. 671 bytes without base64.
 */
function sentVideo(base64) {
  return {
    key: sentKey,
    pushName: "Você",
    status: "PENDING",
    message: {
      videoMessage: {
        url: "https://mmg.whatsapp.net/v/t62.7161-24/12345678_clip.enc",
        mimetype: "video/mp4",
        fileSha256: { 0: 87, 1: 12, 2: 201, 3: 64 },
        fileLength: { low: 3225000, high: 0, unsigned: true },
        seconds: 12,
        mediaKey: { 0: 18, 1: 240, 2: 7, 3: 99 },
        caption: "Demo",
        directPath: "/v/t62.7161-24/12345678_clip.enc",
        mediaKeyTimestamp: { low: 1760000000, high: 0, unsigned: false },
      },
      base64,
    },
    messageType: "videoMessage",
    messageTimestamp: 1760000000,
    instanceId: "0b6a8c1e-3f5d-4b8a-9c2e-7d1f0a4e5b6c",
    source: "web",
  };
}

/** sendText response (Evolution API 2.3.7 stores extendedTextMessage as conversation). */
function sentText(text) {
  return {
    key: sentKey,
    pushName: "Você",
    status: "PENDING",
    message: { conversation: text },
    messageType: "conversation",
    messageTimestamp: 1760000000,
    instanceId: "0b6a8c1e-3f5d-4b8a-9c2e-7d1f0a4e5b6c",
    source: "web",
  };
}

test("tool calls hit the Evolution endpoint and return its response as text content", async (t) => {
  const requests = mockEvolution(t, labels);
  const client = await connect(t);
  const result = await client.callTool({ name: "evolution_label_find", arguments: {} });
  assert.deepEqual(requests, [
    { url: "https://evolution.test/label/findLabels/main", method: "GET", body: undefined },
  ]);
  assert.equal(result.isError, undefined);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  assert.deepEqual(JSON.parse(result.content[0].text), labels);
});

test("successful results are compact JSON; text passes through and empty bodies become null", async (t) => {
  const responses = [
    new Response(JSON.stringify(labels)),
    new Response("plain text reply"),
    new Response(null, { status: 204 }),
  ];
  t.mock.method(globalThis, "fetch", async () => responses.shift());
  const client = await connect(t);
  const call = () => client.callTool({ name: "evolution_label_find", arguments: {} });
  assert.deepEqual(await call(), {
    content: [{ type: "text", text: '[{"id":"1","name":"New customer","color":1,"predefinedId":"1"}]' }],
  });
  assert.deepEqual(await call(), { content: [{ type: "text", text: "plain text reply" }] });
  assert.deepEqual(await call(), { content: [{ type: "text", text: "null" }] });
});

test("results are measured in UTF-8 bytes and a result exactly at the limit is returned", async (t) => {
  mockEvolution(t, [{ id: "1", name: "ñ".repeat(10) }]); // [{"id":"1","name":"ññññññññññ"}]: 32 chars, 42 bytes
  const atLimit = await connect(t, { maxResultBytes: 42 });
  assert.deepEqual(await atLimit.callTool({ name: "evolution_label_find", arguments: {} }), {
    content: [{ type: "text", text: '[{"id":"1","name":"ññññññññññ"}]' }],
  });
  const overLimit = await connect(t, { maxResultBytes: 41 });
  const result = await overLimit.callTool({ name: "evolution_label_find", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^Result too large: 42 bytes exceeds EVOLUTION_MAX_RESULT_BYTES=41\. /);
});

test("oversized media is withheld with its size, a summary and download guidance", async (t) => {
  // Its compact JSON is 4277 bytes.
  mockEvolution(t, mediaBase64("A".repeat(4096)));
  const client = await connect(t, { maxResultBytes: 4096 });
  const result = await client.callTool({
    name: "evolution_chat_media_base64",
    arguments: { message: { key: { id: "3EB0C767D26A1D0F7A71" } } },
  });
  assert.equal(result.isError, true);
  const [{ text }] = result.content;
  assert.match(text, /^Result too large: 4277 bytes exceeds EVOLUTION_MAX_RESULT_BYTES=4096\. /);
  assert.match(text, / Top-level keys: mediaType, fileName, caption, size, mimetype, base64, buffer\. /);
  assert.match(
    text,
    / mimetype: video\/mp4; fileName: clip\.mp4; mediaType: videoMessage; size: \{"fileLength":"4500000","height":720,"width":1280\}\. /,
  );
  assert.match(text, /mediaUrl/);
  assert.match(text, /webhook/);
  assert.match(text, /10 MiB/);
  assert.equal(text.includes("AAAA"), false, "the base64 payload is not returned");
});

test("oversized lists report their length and suggest narrowing instead of media guidance", async (t) => {
  mockEvolution(t, Array.from({ length: 50 }, (_, i) => ({
    id: String(i), name: `Label ${i}`, color: i % 20, predefinedId: null,
  })));
  const client = await connect(t, { maxResultBytes: 1024 });
  const result = await client.callTool({ name: "evolution_label_find", arguments: {} });
  assert.equal(result.isError, true);
  const [{ text }] = result.content;
  assert.match(text, /^Result too large: \d+ bytes exceeds EVOLUTION_MAX_RESULT_BYTES=1024\. Array of 50 items\. /);
  assert.match(text, /Narrow the request/);
  assert.equal(text.includes("mediaUrl"), false);
});

test("the oversize summary lists at most 20 top-level keys", async (t) => {
  mockEvolution(t, Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, "x".repeat(100)])));
  const client = await connect(t, { maxResultBytes: 1024 });
  const result = await client.callTool({ name: "evolution_label_find", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(
    result.content[0].text,
    / Top-level keys: k0, k1, k2, k3, k4, k5, k6, k7, k8, k9, k10, k11, k12, k13, k14, k15, k16, k17, k18, k19 \(\+5 more\)\. /,
  );
});

test("a delivered media send that echoes the file in message.base64 stays a success without the file", async (t) => {
  // 4300000 base64 bytes + 671 bytes of message: over the default 4 MiB limit.
  mockEvolution(t, sentVideo("A".repeat(4_300_000)), 201);
  const client = await connect(t);
  const result = await client.callTool({ name: "evolution_message_send_media", arguments: sendMediaArgs });
  assert.equal(result.isError, undefined);
  assert.equal(result.content.length, 2);
  assert.deepEqual(JSON.parse(result.content[0].text), sentVideo("<omitted: 4300000 bytes>"));
  const note = result.content[1].text;
  assert.match(note, /\b1 value\b/);
  assert.ok(note.includes("message.base64 (4300000 bytes)"), note);
  assert.ok(note.includes("4300671 bytes"), note);
  assert.ok(note.includes("EVOLUTION_MAX_RESULT_BYTES=4194304"), note);
});

test("only strings over 64 KiB of UTF-8 are omitted, with paths that index array items", async (t) => {
  // "x" x 65536 is exactly 64 KiB and stays; "ñ" x 32769 is 65538 bytes. 131177 bytes in all.
  mockEvolution(t, [
    { id: "1", name: "x".repeat(65536), color: 1, predefinedId: null },
    { id: "2", name: "ñ".repeat(32769), color: 2, predefinedId: null },
  ]);
  const client = await connect(t, { maxResultBytes: 70000 });
  const result = await client.callTool({ name: "evolution_label_find", arguments: {} });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), [
    { id: "1", name: "x".repeat(65536), color: 1, predefinedId: null },
    { id: "2", name: "<omitted: 65538 bytes>", color: 2, predefinedId: null },
  ]);
  const note = result.content[1].text;
  assert.ok(note.includes("[1].name (65538 bytes)"), note);
  assert.equal(note.includes("[0].name"), false, note);
});

test("evolution_chat_media_base64 is never pruned: oversized media is withheld with download guidance", async (t) => {
  // 100181 bytes; without its 100000 base64 bytes it would fit in 4096, but the media is the result.
  mockEvolution(t, mediaBase64("A".repeat(100_000)));
  const client = await connect(t, { maxResultBytes: 4096 });
  const result = await client.callTool({
    name: "evolution_chat_media_base64",
    arguments: { message: { key: { id: "3EB0C767D26A1D0F7A71" } } },
  });
  assert.equal(result.isError, true);
  assert.equal(result.content.length, 1);
  const [{ text }] = result.content;
  assert.match(text, /^Result too large: 100181 bytes exceeds EVOLUTION_MAX_RESULT_BYTES=4096\. /);
  assert.equal(text.includes("<omitted"), false);
  assert.match(text, /mediaUrl/);
  // Evolution caches webhook base64 when the instance connects, and only new messages carry it.
  assert.match(text, /new media/);
  assert.match(text, /reconnect/);
  assert.match(text, /evolution_instance_restart/);
});

test("an oversized send that omitting values cannot fit is reported as accepted with its key", async (t) => {
  // Without its base64 the video response is 694 bytes, and the text response has nothing to omit.
  const responses = [sentVideo("A".repeat(100_000)), sentText("Hola ".repeat(200))];
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(responses.shift()), { status: 201 }));
  const client = await connect(t, { maxResultBytes: 512 });
  for (const [name, args] of [
    ["evolution_message_send_media", sendMediaArgs],
    ["evolution_message_send_text", { number: "5215512345678", text: "Hola ".repeat(200) }],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
    const [{ text }] = result.content;
    assert.match(text, /accepted/, name);
    assert.ok(
      text.includes('key: {"remoteJid":"5215512345678@s.whatsapp.net","fromMe":true,"id":"3EB0C767D26A1D0F7A71B2"}'),
      `${name}: ${text}`,
    );
    assert.doesNotMatch(text, /Narrow the request/, name);
  }
});

test("unknown tools, invalid arguments and API errors become isError results", async (t) => {
  const requests = mockEvolution(t, { status: 400, error: "Bad Request", response: { message: ["labelId is required"] } }, 400);
  const client = await connect(t);
  assert.deepEqual(await client.callTool({ name: "evolution_nope", arguments: {} }), {
    content: [{ type: "text", text: "Unknown tool: evolution_nope" }],
    isError: true,
  });
  assert.deepEqual(await client.callTool({ name: "evolution_label_handle", arguments: { number: "1", labelId: "5" } }), {
    content: [{ type: "text", text: "Invalid arguments: action: Required" }],
    isError: true,
  });
  assert.equal(requests.length, 0, "invalid arguments never reach the API");
  assert.deepEqual(
    await client.callTool({ name: "evolution_label_handle", arguments: { number: "1", labelId: "5", action: "add" } }),
    { content: [{ type: "text", text: "Evolution API error (HTTP 400): labelId is required" }], isError: true },
  );
});

test("tools/list exposes each enabled tool with its JSON input schema", async (t) => {
  const client = await connect(t, { toolsAllowlist: "label" });
  const { tools } = await client.listTools();
  const handle = tools.find((tool) => tool.name === "evolution_label_handle");
  assert.equal(handle.inputSchema.type, "object");
  assert.deepEqual(handle.inputSchema.required, ["number", "labelId", "action"]);
  assert.equal(tools.some((tool) => tool.name === "evolution_message_send_text"), false, "message group not enabled");
});

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

test("an incoming message over EVOLUTION_MAX_MESSAGE_BYTES is logged as a transport error", { timeout: 10000 }, async (t) => {
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
  t.after(() => child.kill());
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

  // The SDK's message names the configured limit.
  assert.match(stderr, /\[evolution-api-mcp\] transport error: .*\b4096\b/);
});
