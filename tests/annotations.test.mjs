import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { buildRegistry } from "../dist/registry.js";
import { createServer } from "../dist/server.js";
import { toolAnnotations } from "../dist/tools/annotations.js";

const serverConfig = {
  baseUrl: "https://evolution.test",
  apiKey: "test-key",
  defaultInstance: "main",
  timeoutMs: 1000,
  maxMessageBytes: 67108864,
  maxResultBytes: 4194304,
  toolsAllowlist: "all",
};

const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];

/** Every tool the server can expose (EVOLUTION_TOOLS=all), in listing order. */
const ALL_TOOLS = buildRegistry(serverConfig).tools.map((tool) => tool.name);

/** Words of a tool name after the prefix: evolution_chat_find_messages -> ["chat", "find", "messages"]. */
function hasWord(name, list) {
  return name.replace(/^evolution_/, "").split("_").some((word) => list.includes(word));
}

/** The four hints of a tool, without its title. */
function hintsOf(name) {
  const { title: _title, ...hints } = toolAnnotations[name];
  return hints;
}

/** MCP client connected in-process to createServer(config, deps). */
async function connect(t, deps) {
  const server = createServer(serverConfig, deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(() => client.close());
  return client;
}

test("every tool of EVOLUTION_TOOLS=all has an annotation entry and no entry is stale", () => {
  const annotated = Object.keys(toolAnnotations);
  assert.deepEqual(
    {
      missing: ALL_TOOLS.filter((name) => !annotated.includes(name)),
      stale: annotated.filter((name) => !ALL_TOOLS.includes(name)),
    },
    { missing: [], stale: [] },
  );
});

test("every hint is explicit, read-only tools are never destructive, and titles are short, human and unique", () => {
  const owners = new Map();
  for (const [name, annotations] of Object.entries(toolAnnotations)) {
    // An omitted hint takes the MCP default (destructive, open-world write).
    for (const hint of HINTS) assert.equal(typeof annotations[hint], "boolean", `${name}.${hint}`);
    if (annotations.readOnlyHint) {
      assert.equal(annotations.destructiveHint, false, `${name}: read-only tools cannot be destructive`);
      assert.equal(annotations.idempotentHint, true, `${name}: read-only tools are idempotent`);
    }
    // A capitalized label of at most 40 characters, not the snake_case name.
    assert.match(annotations.title, /^[A-Z][^_]{2,39}$/, name);
    assert.equal(owners.get(annotations.title), undefined, `${name} reuses the title of ${owners.get(annotations.title)}`);
    owners.set(annotations.title, name);
  }
});

/** Name words that announce a read. */
const READ_WORDS = ["find", "fetch", "get", "check", "search", "list"];

/** Tools with a read word in the name that change state. */
const READ_NAMED_WRITES = new Map([
  ["evolution_message_send_list", "'list' is the interactive list message it sends"],
]);

/** Read-only tools without a read word in the name. */
const OTHER_READS = new Map([
  ["evolution_server_verify_creds", "POST /verify-creds only checks the API key"],
  ["evolution_instance_connection_state", "returns the in-memory connection state"],
  ["evolution_chat_profile_picture_url", "POST /chat/fetchProfilePictureUrl"],
  ["evolution_chat_media_base64", "POST /chat/getBase64FromMediaMessage downloads the media"],
  ["evolution_group_invite_code", "returns the current invite link; revoking is a separate tool"],
  ["evolution_group_invite_info", "previews an invite without joining"],
  ["evolution_group_participants", "lists the members of a group"],
]);

test("read-named tools are read-only and read-only tools are read-named, except the listed ones", () => {
  for (const name of ALL_TOOLS) {
    const readNamed = hasWord(name, READ_WORDS);
    const expected = readNamed ? !READ_NAMED_WRITES.has(name) : OTHER_READS.has(name);
    assert.equal(toolAnnotations[name].readOnlyHint, expected, name);
  }
  // A stale exception (renamed or removed tool) would silently exempt nothing.
  for (const name of READ_NAMED_WRITES.keys()) assert.ok(ALL_TOOLS.includes(name) && hasWord(name, READ_WORDS), name);
  for (const name of OTHER_READS.keys()) assert.ok(ALL_TOOLS.includes(name) && !hasWord(name, READ_WORDS), name);
});

test("tools named for a removal are destructive writes, with no exceptions", () => {
  // Undoing a removal later (re-adding, re-joining) does not make it non-destructive.
  const removals = ALL_TOOLS.filter((name) => hasWord(name, ["delete", "logout", "leave", "revoke", "remove"]));
  assert.ok(removals.includes("evolution_instance_delete") && removals.includes("evolution_group_leave"));
  for (const name of removals) {
    const { readOnlyHint, destructiveHint } = toolAnnotations[name];
    assert.deepEqual({ readOnlyHint, destructiveHint }, { readOnlyHint: false, destructiveHint: true }, name);
  }
});

/** Send tools that are not destructive. */
const NON_DESTRUCTIVE_SENDS = new Map([
  ["evolution_chat_send_presence", "a typing/recording indicator: no content, cleared by 'paused' after the delay"],
]);

test("send tools reach other people irreversibly: destructive, open-world and never idempotent", () => {
  const sends = ALL_TOOLS.filter((name) => hasWord(name, ["send"]) && !NON_DESTRUCTIVE_SENDS.has(name));
  assert.ok(sends.includes("evolution_message_send_text") && sends.includes("evolution_group_send_invite"));
  for (const name of sends) {
    assert.deepEqual(
      hintsOf(name),
      { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      name,
    );
  }
  for (const name of NON_DESTRUCTIVE_SENDS.keys()) {
    assert.ok(hasWord(name, ["send"]), name);
    assert.equal(toolAnnotations[name].destructiveHint, false, name);
  }
});

/**
 * Hand-checked against the Evolution API 2.3.7 source: endpoints whose HTTP verb or name misleads,
 * and the edges of the destructive and open-world rules.
 */
const CLASSIFIED = {
  // POST reads of Evolution's own database.
  evolution_chat_find_messages: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  evolution_server_verify_creds: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // POST reads that query WhatsApp (onWhatsApp lookup, media download).
  evolution_chat_check_numbers: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  evolution_chat_media_base64: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  // GET /group/acceptInviteCode joins the group: every member is notified and sees the number.
  evolution_group_accept_invite: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  // GET /instance/connect starts a WhatsApp connection; repeating it returns the pending QR code.
  evolution_instance_connect: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  // Each call stores and delivers a new reaction message.
  evolution_message_send_reaction: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  // A flag that the opposite call restores exactly.
  evolution_chat_archive: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  // Deleting a credential cascades to the OpenAI bots that use it.
  evolution_openai_creds_delete: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  // Storing a webhook URL is closed-world even though Evolution posts to it later.
  evolution_webhook_set: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  // The proxy is tested against an external IP echo service before it is saved.
  evolution_proxy_set: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  // Evolution reconnects the WhatsApp session after every privacy write.
  evolution_profile_update_privacy: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  // Creating a bot only stores it.
  evolution_typebot_create: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

test("tools/list gives every tool a title and the annotations of the map", async (t) => {
  const client = await connect(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ALL_TOOLS);
  for (const tool of tools) {
    assert.equal(typeof tool.title, "string", tool.name);
    assert.equal(tool.annotations?.title, tool.title, tool.name);
    assert.deepEqual(tool.annotations, toolAnnotations[tool.name], tool.name);
  }
  for (const [name, hints] of Object.entries(CLASSIFIED)) {
    const { title: _title, ...listed } = tools.find((tool) => tool.name === name).annotations;
    assert.deepEqual(listed, hints, name);
  }
});

test("a tool missing from the map is still listed, without hints, so clients treat it as a write", async (t) => {
  const unmapped = {
    name: "evolution_test_unmapped",
    description: "Test tool without annotations.",
    inputSchema: z.object({}),
    handler: async () => null,
  };
  const registry = { tools: [unmapped], byName: new Map([[unmapped.name, unmapped]]), enabledGroups: ["test"] };
  const client = await connect(t, { registry });
  const { tools } = await client.listTools();
  assert.deepEqual(tools, [
    {
      name: "evolution_test_unmapped",
      description: "Test tool without annotations.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ]);
});
