import assert from "node:assert/strict";
import test from "node:test";
import { chatwootGroup } from "../dist/tools/integrations/chatwoot.js";
import { instanceGroup } from "../dist/tools/instance.js";
import { settingsGroup } from "../dist/tools/settings.js";

const chatwootSet = chatwootGroup.tools.find((tool) => tool.name === "evolution_chatwoot_set");
const settingsSet = settingsGroup.tools.find((tool) => tool.name === "evolution_settings_set");
const instanceCreate = instanceGroup.tools.find((tool) => tool.name === "evolution_instance_create");

function captureClient(current) {
  const requests = [];
  return {
    requests,
    resolveInstance: (instance = "main") => encodeURIComponent(instance),
    async get(path) {
      requests.push({ method: "GET", path });
      if (current instanceof Error) throw current;
      return current;
    },
    async post(path, options) {
      requests.push({ method: "POST", path, body: options?.body });
      return options?.body;
    },
  };
}

const chatwootRequired = {
  enabled: true,
  accountId: "123",
  token: "stored-token",
  url: "https://chatwoot.example.test",
  signMsg: true,
  reopenConversation: false,
  conversationPending: false,
};

test("Chatwoot preserves stored optional settings even when all required fields are supplied", async () => {
  const current = {
    ...chatwootRequired,
    nameInbox: "Support Inbox",
    signDelimiter: " | ",
    ignoreJids: ["@g.us"],
    importContacts: true,
    daysLimitImportMessages: 30,
    id: "database-only-id",
    webhook_url: "https://api.example.test/chatwoot/webhook/main",
  };
  const client = captureClient(current);
  const changes = { ...chatwootRequired, token: "replacement-token" };
  await chatwootSet.handler(client, chatwootSet.inputSchema.parse(changes));

  assert.deepEqual(client.requests, [
    { method: "GET", path: "/chatwoot/find/main" },
    {
      method: "POST",
      path: "/chatwoot/set/main",
      body: {
        ...changes,
        nameInbox: "Support Inbox",
        signDelimiter: " | ",
        ignoreJids: ["@g.us"],
        importContacts: true,
        daysLimitImportMessages: 30,
      },
    },
  ]);
  assert.equal(current.token, "stored-token", "the fetched configuration is not mutated");
});

test("Chatwoot accepts explicit null resets and an empty replacement ignore list", async () => {
  const client = captureClient({
    ...chatwootRequired,
    nameInbox: "Support Inbox",
    signDelimiter: " | ",
    ignoreJids: ["@g.us"],
  });
  await chatwootSet.handler(
    client,
    chatwootSet.inputSchema.parse({ signDelimiter: null, nameInbox: null, ignoreJids: [] }),
  );
  assert.deepEqual(client.requests[1].body, {
    ...chatwootRequired,
    nameInbox: null,
    signDelimiter: null,
    ignoreJids: [],
  });
});

test("Chatwoot refuses enabling an unconfigured integration without credentials before writing", async () => {
  const client = captureClient({
    enabled: false,
    accountId: "",
    token: "",
    url: "",
    signMsg: false,
    nameInbox: "",
    webhook_url: "",
  });
  await assert.rejects(
    chatwootSet.handler(client, chatwootSet.inputSchema.parse({ enabled: true })),
    /Cannot enable Chatwoot with empty: accountId, token, url/,
  );
  assert.deepEqual(client.requests, [{ method: "GET", path: "/chatwoot/find/main" }]);
});

test("configuration read failures do not become writes with defaults", async (t) => {
  for (const [tool, path] of [[chatwootSet, "/chatwoot/find/main"], [settingsSet, "/settings/find/main"]]) {
    await t.test(tool.name, async () => {
      const failure = new Error("configuration read failed");
      const client = captureClient(failure);
      const changes = tool === chatwootSet ? chatwootRequired : { alwaysOnline: true };
      await assert.rejects(tool.handler(client, tool.inputSchema.parse(changes)), (error) => error === failure);
      assert.deepEqual(client.requests, [{ method: "GET", path }]);
    });
  }
});

test("partial settings updates preserve false flags and stored strings without forwarding metadata", async () => {
  const stored = {
    rejectCall: true,
    groupsIgnore: false,
    alwaysOnline: false,
    readMessages: true,
    readStatus: false,
    syncFullHistory: true,
    msgCall: "Please send a message",
    wavoipToken: "stored-voice-token",
  };
  const client = captureClient({ ...stored, id: "database-only-id", instanceId: "instance-id" });
  await settingsSet.handler(client, settingsSet.inputSchema.parse({ rejectCall: false }));
  assert.deepEqual(client.requests, [
    { method: "GET", path: "/settings/find/main" },
    { method: "POST", path: "/settings/set/main", body: { ...stored, rejectCall: false } },
  ]);
});

test("inline instance webhooks always send an events array when events are omitted", async () => {
  const client = captureClient(null);
  await instanceCreate.handler(
    client,
    instanceCreate.inputSchema.parse({ instanceName: "main", webhook: { url: "https://hooks.example.test" } }),
  );
  assert.deepEqual(client.requests, [{
    method: "POST",
    path: "/instance/create",
    body: {
      instanceName: "main",
      integration: "WHATSAPP-BAILEYS",
      webhook: { url: "https://hooks.example.test", events: [] },
    },
  }]);
});
