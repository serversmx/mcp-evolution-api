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

/** The EVOLUTION_TOOLS group of a tool, its first word after the prefix: evolution_chat_find_messages -> "chat". */
function groupOf(name) {
  return name.replace(/^evolution_/, "").split("_")[0];
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

/** The read-only rule: read-named tools are reads and the others are writes, except the listed ones. */
function isRead(name) {
  return hasWord(name, READ_WORDS) ? !READ_NAMED_WRITES.has(name) : OTHER_READS.has(name);
}

/** Every tool that changes state, by the read-only rule (not by the map under test). */
const WRITES = ALL_TOOLS.filter((name) => !isRead(name));

test("read-named tools are read-only and read-only tools are read-named, except the listed ones", () => {
  for (const name of ALL_TOOLS) assert.equal(toolAnnotations[name].readOnlyHint, isRead(name), name);
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

/**
 * Writes that are not destructive: additive writes, starting a connection, private flags that the
 * opposite call restores exactly, and presence and receipts, which carry no content. Every other write
 * deletes, logs out or restarts, revokes access, overwrites stored values or reaches other people.
 */
const NON_DESTRUCTIVE_WRITES = new Map([
  ["evolution_instance_create", "adds an instance and starts its connection; nothing existing is replaced"],
  ["evolution_instance_connect", "starts a connection; repeating it returns the pending QR code"],
  ["evolution_instance_set_presence", "an online/offline status carries no content"],
  ["evolution_chat_mark_read", "a read receipt carries no content"],
  ["evolution_chat_mark_played", "a played receipt carries no content"],
  ["evolution_chat_mark_unread", "a private flag that the opposite call restores exactly"],
  ["evolution_chat_archive", "a private flag that the opposite call restores exactly"],
  ["evolution_chat_send_presence", "a typing/recording indicator: no content, cleared by 'paused' after the delay"],
  ["evolution_label_handle", "a private chat label that the opposite call restores exactly"],
  ["evolution_template_create", "adds a template; Meta reviews it before it can be sent"],
  ["evolution_openai_creds_set", "adds a credential"],
  ["evolution_typebot_create", "adds a bot to Evolution's database"],
  ["evolution_openai_create", "adds a bot to Evolution's database"],
  ["evolution_dify_create", "adds a bot to Evolution's database"],
  ["evolution_evolutionbot_create", "adds a bot to Evolution's database"],
  ["evolution_flowise_create", "adds a bot to Evolution's database"],
  ["evolution_n8n_create", "adds a bot to Evolution's database"],
  ["evolution_evoai_create", "adds a bot to Evolution's database"],
  ["evolution_typebot_ignore_jid", "adds or removes one ignored JID; the opposite call restores it"],
  ["evolution_openai_ignore_jid", "adds or removes one ignored JID; the opposite call restores it"],
  ["evolution_dify_ignore_jid", "adds or removes one ignored JID; the opposite call restores it"],
  ["evolution_evolutionbot_ignore_jid", "adds or removes one ignored JID; the opposite call restores it"],
  ["evolution_flowise_ignore_jid", "adds or removes one ignored JID; the opposite call restores it"],
  ["evolution_n8n_ignore_jid", "adds or removes one ignored JID; the opposite call restores it"],
  ["evolution_evoai_ignore_jid", "adds or removes one ignored JID; the opposite call restores it"],
]);

test("writes are destructive, except the listed additive, connection, private-flag and presence writes", () => {
  for (const name of WRITES) {
    assert.equal(toolAnnotations[name].destructiveHint, !NON_DESTRUCTIVE_WRITES.has(name), name);
  }
  // A stale exception (renamed tool, or one that became a read) would silently exempt nothing.
  for (const name of NON_DESTRUCTIVE_WRITES.keys()) assert.ok(WRITES.includes(name), name);
});

/**
 * Writes that are not idempotent: repeating the call with the same arguments has a new effect. Every
 * other write converges when repeated (set-to-value updates, deletions, flags, joins and leaves, edits
 * and deletions of a sent message). The group subject, permission, member-add-mode and
 * disappearing-message setters are not listed: Baileys sends only the new value, with no revision id,
 * so a repeat sets the same state.
 */
const NOT_IDEMPOTENT_WRITES = new Map([
  ["evolution_instance_create", "creates an instance"],
  ["evolution_instance_restart", "drops and reopens the WhatsApp session each time"],
  ["evolution_settings_set", "with a WAVoIP token stored, closes and reopens the WhatsApp socket each time"],
  ["evolution_message_send_text", "delivers and stores a new message each time"],
  ["evolution_message_send_media", "delivers and stores a new message each time"],
  ["evolution_message_send_ptv", "delivers and stores a new message each time"],
  ["evolution_message_send_audio", "delivers and stores a new message each time"],
  ["evolution_message_send_sticker", "delivers and stores a new message each time"],
  ["evolution_message_send_location", "delivers and stores a new message each time"],
  ["evolution_message_send_contact", "delivers and stores a new message each time"],
  ["evolution_message_send_reaction", "delivers and stores a new reaction message each time"],
  ["evolution_message_send_poll", "delivers and stores a new message each time"],
  ["evolution_message_send_list", "delivers and stores a new message each time"],
  ["evolution_message_send_buttons", "delivers and stores a new message each time"],
  ["evolution_message_send_status", "posts a new status each time"],
  ["evolution_message_send_template", "delivers and stores a new message each time"],
  ["evolution_message_send_carousel", "delivers and stores a new message each time"],
  ["evolution_chat_send_presence", "shows the indicator again each time"],
  ["evolution_profile_update_picture", "Evolution reloads the WhatsApp connection after each call"],
  ["evolution_profile_remove_picture", "Evolution reloads the WhatsApp connection after each call"],
  ["evolution_profile_update_privacy", "Evolution reloads the WhatsApp connection after each call"],
  ["evolution_group_create", "creates a new group and adds its participants each time"],
  ["evolution_group_update_picture", "uploads a new group picture each time, announced to the members"],
  ["evolution_group_update_description", "a new description revision (fresh id) each time, announced to the members"],
  ["evolution_group_revoke_invite", "issues a new invite link each time"],
  ["evolution_group_send_invite", "delivers a new invite message each time"],
  ["evolution_template_create", "submits a new template to Meta"],
  ["evolution_template_edit", "each edit is a new submission that Meta reviews"],
  ["evolution_chatwoot_set", "with autoCreate, opens a new Chatwoot init conversation each time"],
  ["evolution_typebot_create", "creates a bot"],
  ["evolution_typebot_start", "starts the flow again and sends its messages each time"],
  ["evolution_openai_create", "creates a bot"],
  ["evolution_openai_creds_set", "stores a new credential"],
  ["evolution_dify_create", "creates a bot"],
  ["evolution_evolutionbot_create", "creates a bot"],
  ["evolution_flowise_create", "creates a bot"],
  ["evolution_n8n_create", "creates a bot"],
  ["evolution_evoai_create", "creates a bot"],
]);

test("writes are idempotent, except the listed ones, which include every create and send", () => {
  for (const name of WRITES) {
    assert.equal(toolAnnotations[name].idempotentHint, !NOT_IDEMPOTENT_WRITES.has(name), name);
  }
  // Creates and sends are never idempotent: a new one must be listed, not default to idempotent.
  for (const name of ALL_TOOLS.filter((tool) => hasWord(tool, ["create", "send"]))) {
    assert.ok(NOT_IDEMPOTENT_WRITES.has(name), `${name} is missing from NOT_IDEMPOTENT_WRITES`);
  }
  for (const name of NOT_IDEMPOTENT_WRITES.keys()) assert.ok(WRITES.includes(name), name);
});

/** Groups whose tools reach the WhatsApp network or the Meta Graph API. */
const OPEN_WORLD_GROUPS = new Map([
  ["instance", "creates, connects, restarts and logs out WhatsApp sessions"],
  ["message", "delivers messages over WhatsApp"],
  ["chat", "receipts, presence, blocks, edits and number lookups go to WhatsApp"],
  ["profile", "reads and writes WhatsApp profiles"],
  ["label", "labels are WhatsApp Business app state"],
  ["group", "reads and changes WhatsApp groups"],
  ["template", "the Meta Graph API"],
  ["business", "the WhatsApp Business catalog"],
]);

/** Groups whose tools only read or store Evolution's own data and configuration. */
const CLOSED_WORLD_GROUPS = new Map([
  ["server", "checks the API key"],
  ["settings", "Evolution's instance settings"],
  ["webhook", "stores the URL; Evolution posts to it later"],
  ["proxy", "stores the proxy settings"],
  ["chatwoot", "stores the Chatwoot settings"],
  ["websocket", "a per-instance switch for a broker the operator configures"],
  ["rabbitmq", "a per-instance switch for a broker the operator configures"],
  ["sqs", "a per-instance switch; any queues are created in the operator's own AWS account"],
  ["nats", "a per-instance switch for a broker the operator configures"],
  ["kafka", "a per-instance switch for a broker the operator configures"],
  ["pusher", "stores the credentials; Evolution publishes to Pusher later"],
  ["typebot", "bots, settings and sessions in Evolution's database"],
  ["openai", "bots, settings, sessions and credentials in Evolution's database"],
  ["dify", "bots, settings and sessions in Evolution's database"],
  ["evolutionbot", "bots, settings and sessions in Evolution's database"],
  ["flowise", "bots, settings and sessions in Evolution's database"],
  ["n8n", "bots, settings and sessions in Evolution's database"],
  ["evoai", "bots, settings and sessions in Evolution's database"],
]);

/** Tools of an open-world group that only read what Evolution has stored. */
const CLOSED_WORLD_EXCEPTIONS = new Map([
  ["evolution_instance_fetch", "lists the instances stored in Evolution"],
  ["evolution_instance_connection_state", "returns the in-memory connection state"],
  ["evolution_chat_find_contacts", "queries Evolution's database"],
  ["evolution_chat_find_messages", "queries Evolution's database"],
  ["evolution_chat_find_status", "queries Evolution's database"],
  ["evolution_chat_find_chats", "queries Evolution's database"],
  ["evolution_chat_find_chat_by_jid", "queries Evolution's database"],
  ["evolution_chat_get_poll_vote", "decrypts the votes from stored messages"],
  ["evolution_chat_find_channels", "queries Evolution's database"],
  ["evolution_label_find", "lists the labels stored in Evolution"],
]);

/** Tools of a closed-world group whose call itself reaches past Evolution. */
const OPEN_WORLD_EXCEPTIONS = new Map([
  ["evolution_settings_set", "closes and reopens the WhatsApp socket when a WAVoIP token is stored"],
  ["evolution_proxy_set", "tests the proxy against an external IP echo service before saving it"],
  ["evolution_chatwoot_set", "with autoCreate, calls Chatwoot and opens an init conversation"],
  ["evolution_typebot_start", "starts the flow on Typebot and sends its messages over WhatsApp"],
  ["evolution_openai_get_models", "calls the OpenAI models API"],
]);

test("tools are open-world by group, except the listed ones", () => {
  for (const name of ALL_TOOLS) {
    const group = groupOf(name);
    // A new group must be classified, not fall into either world by default.
    assert.notEqual(OPEN_WORLD_GROUPS.has(group), CLOSED_WORLD_GROUPS.has(group), `${name}: classify group ${group}`);
    const expected = OPEN_WORLD_GROUPS.has(group) ? !CLOSED_WORLD_EXCEPTIONS.has(name) : OPEN_WORLD_EXCEPTIONS.has(name);
    assert.equal(toolAnnotations[name].openWorldHint, expected, name);
  }
  // Stale groups and exceptions would silently classify nothing.
  for (const group of [...OPEN_WORLD_GROUPS.keys(), ...CLOSED_WORLD_GROUPS.keys()]) {
    assert.ok(ALL_TOOLS.some((name) => groupOf(name) === group), group);
  }
  for (const name of CLOSED_WORLD_EXCEPTIONS.keys()) {
    assert.ok(ALL_TOOLS.includes(name) && OPEN_WORLD_GROUPS.has(groupOf(name)), name);
  }
  for (const name of OPEN_WORLD_EXCEPTIONS.keys()) {
    assert.ok(ALL_TOOLS.includes(name) && CLOSED_WORLD_GROUPS.has(groupOf(name)), name);
  }
});

test("send tools reach other people irreversibly: destructive, open-world and never idempotent", () => {
  // chat_send_presence is the one send without content (see NON_DESTRUCTIVE_WRITES).
  const sends = ALL_TOOLS.filter((name) => hasWord(name, ["send"]) && !NON_DESTRUCTIVE_WRITES.has(name));
  assert.ok(sends.includes("evolution_message_send_text") && sends.includes("evolution_group_send_invite"));
  for (const name of sends) {
    assert.deepEqual(
      hintsOf(name),
      { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      name,
    );
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
  // Each call is a new group picture or a new description revision (fresh id), announced to the members.
  evolution_group_update_picture: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  evolution_group_update_description: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
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
