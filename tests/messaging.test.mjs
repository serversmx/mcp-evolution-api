import assert from "node:assert/strict";
import { test } from "node:test";
import { EvolutionClient, ToolInputError } from "../dist/client.js";
import { messageGroup } from "../dist/tools/message.js";
import { chatGroup } from "../dist/tools/chat.js";
import { profileGroup } from "../dist/tools/profile.js";

const client = new EvolutionClient({
  baseUrl: "https://evolution.test",
  apiKey: "test-key",
  defaultInstance: "instance / one",
  timeoutMs: 5000,
});
const mediaTool = messageGroup.tools.find((tool) => tool.name === "evolution_message_send_media");
const privacyTool = profileGroup.tools.find((tool) => tool.name === "evolution_profile_update_privacy");

test("multipart media sends decoded bytes, the file field, and scalar metadata", async (t) => {
  let request;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    request = { url, ...init };
    return new Response(JSON.stringify({ key: { id: "sent" } }), { status: 201 });
  });
  const bytes = Buffer.from([0, 1, 2, 3, 128, 255]);
  await mediaTool.handler(client, mediaTool.inputSchema.parse({
    number: "15551234567",
    mediatype: "video",
    media: bytes.toString("base64"),
    transport: "multipart",
    fileName: "clip.mp4",
    mimetype: "video/mp4",
    caption: "Uploaded video",
    gifPlayback: false,
    gifAttribution: 0,
    messageId: "custom-id",
  }));
  assert.equal(new URL(request.url).pathname, "/message/sendMedia/instance%20%2F%20one");
  assert.equal(request.method, "POST");
  assert.equal(new Headers(request.headers).get("Content-Type"), null);
  assert.equal(new Headers(request.headers).get("apikey"), "test-key");
  assert.ok(request.body instanceof FormData);
  assert.equal(request.body.get("number"), "15551234567");
  assert.equal(request.body.get("fileName"), "clip.mp4");
  assert.equal(request.body.get("gifPlayback"), "false");
  assert.equal(request.body.get("gifAttribution"), "0");
  assert.equal(request.body.get("messageId"), "custom-id");
  assert.equal(request.body.has("media"), false);
  assert.equal(request.body.has("transport"), false);
  const file = request.body.get("file");
  assert.equal(file.name, "clip.mp4");
  assert.equal(file.type, "video/mp4");
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
});

test("JSON media remains the default and transport is never sent to the API", async (t) => {
  let request;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    request = init;
    return new Response("{}", { status: 201 });
  });
  await mediaTool.handler(client, mediaTool.inputSchema.parse({
    number: "15551234567",
    mediatype: "image",
    media: "https://example.test/image.png",
    delay: 0,
    quoted: { key: { id: "original" } },
  }));
  assert.equal(new Headers(request.headers).get("Content-Type"), "application/json");
  assert.deepEqual(JSON.parse(request.body), {
    number: "15551234567",
    mediatype: "image",
    media: "https://example.test/image.png",
    delay: 0,
    quoted: { key: { id: "original" } },
  });
});

test("invalid multipart combinations fail before any request", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected network call");
  });
  const base = {
    number: "15551234567",
    mediatype: "image",
    media: "AQIDBA==",
    transport: "multipart",
  };
  for (const change of [
    { media: "https://example.test/image.png" },
    { media: "data:image/png;base64,AQIDBA==" },
    { media: "invalid base64" },
    { delay: 0 },
    { quoted: { key: { id: "original" } } },
    { mentionsEveryOne: false },
    { mentioned: ["15551234567@s.whatsapp.net"] },
    { mediatype: "document" },
  ]) {
    await assert.rejects(
      mediaTool.handler(client, mediaTool.inputSchema.parse({ ...base, ...change })),
      ToolInputError,
    );
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("privacy updates preserve all other settings and drop server metadata", async (t) => {
  const requests = [];
  const privacy = {
    readreceipts: "all", profile: "contacts", status: "contacts",
    online: "match_last_seen", last: "none", groupadd: "contacts", id: "server-only",
  };
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requests.push(init);
    return new Response(JSON.stringify(init.method === "GET" ? privacy : {}));
  });
  await privacyTool.handler(client, privacyTool.inputSchema.parse({ readreceipts: "none" }));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].method, "GET");
  assert.deepEqual(JSON.parse(requests[1].body), {
    readreceipts: "none", profile: "contacts", status: "contacts",
    online: "match_last_seen", last: "none", groupadd: "contacts",
  });
});

test("privacy updates refuse to overwrite incomplete server settings", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requests.push(init);
    return new Response(JSON.stringify({ readreceipts: "all", profile: null }));
  });
  await assert.rejects(
    privacyTool.handler(client, privacyTool.inputSchema.parse({ readreceipts: "none" })),
    ToolInputError,
  );
  assert.deepEqual(requests.map((request) => request.method), ["GET"]);
});

test("archive and unread accept a last message without redundant chat and preserve its timestamp", () => {
  const lastMessage = {
    key: { id: "message-id", remoteJid: "15551234567@s.whatsapp.net", fromMe: false },
    messageTimestamp: 1750000000,
  };
  for (const name of ["evolution_chat_archive", "evolution_chat_mark_unread"]) {
    const tool = chatGroup.tools.find((entry) => entry.name === name);
    assert.deepEqual(tool.inputSchema.parse({ lastMessage, archive: true }).lastMessage, lastMessage);
  }
});
