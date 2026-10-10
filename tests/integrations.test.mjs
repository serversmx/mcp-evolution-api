import assert from "node:assert/strict";
import test from "node:test";
import { ToolInputError } from "../dist/client.js";
import { allGroups } from "../dist/tools/index.js";

function tool(name) {
  const found = allGroups.flatMap((group) => group.tools).find((candidate) => candidate.name === name);
  assert.ok(found, `tool ${name} exists`);
  return found;
}

/** Fake client answering each "METHOD path" from `routes`; an Error value is thrown instead. */
function routedClient(routes) {
  const calls = [];
  const respond = async (method, path, body) => {
    calls.push(body === undefined ? { method, path } : { method, path, body });
    const key = `${method} ${path}`;
    if (!(key in routes)) throw new Error(`Unexpected request: ${key}`);
    if (routes[key] instanceof Error) throw routes[key];
    return routes[key];
  };
  return {
    calls,
    resolveInstance: (instance = "main") => encodeURIComponent(instance),
    get: (path) => respond("GET", path),
    post: (path, options) => respond("POST", path, options?.body),
    delete: (path) => respond("DELETE", path),
  };
}

/** fetchSettings answer of any bot integration whose settings were never saved (no id). */
const neverSavedSettings = {
  expire: 300, keywordFinish: "bye", delayMessage: 1000, unknownMessage: "Sorry, I dont understand",
  listeningFromMe: true, stopBotFromMe: true, keepOpen: false, debounceTime: 1, ignoreJids: [],
  splitMessages: false, timePerChar: 0, fallbackId: "", fallback: null,
};

const savedTypebotSettings = {
  id: "typebot-settings-1", expire: 0, keywordFinish: "bye", delayMessage: 1000, unknownMessage: "Not understood",
  listeningFromMe: false, stopBotFromMe: false, keepOpen: false, debounceTime: 0, typebotIdFallback: null,
  ignoreJids: [], splitMessages: false, timePerChar: 50, createdAt: "2026-10-01T12:00:00.000Z",
  updatedAt: "2026-10-01T12:00:00.000Z", instanceId: "internal-instance-id", Fallback: null,
  fallbackId: null, fallback: null,
};

const flow = { url: "https://typebot.test", typebot: "lead-flow", remoteJid: "5215512345678@s.whatsapp.net" };

test("typebot_start opens a persistent session unless startSession: false is passed", async () => {
  const start = tool("evolution_typebot_start");
  for (const [args, startSession] of [[flow, true], [{ ...flow, startSession: false }, false]]) {
    const client = routedClient({
      "GET /typebot/fetchSettings/main": savedTypebotSettings,
      "POST /typebot/start/main": { typebot: {} },
    });
    await start.handler(client, start.inputSchema.parse(args));
    assert.deepEqual(client.calls.find(({ method }) => method === "POST"), {
      method: "POST",
      path: "/typebot/start/main",
      body: { ...flow, startSession },
    });
  }
});

test("typebot_start never starts a flow without readable saved Typebot settings", async (t) => {
  const start = tool("evolution_typebot_start");
  await t.test("never saved", async () => {
    const client = routedClient({ "GET /typebot/fetchSettings/main": neverSavedSettings, "POST /typebot/start/main": {} });
    await assert.rejects(start.handler(client, start.inputSchema.parse(flow)),
      (err) => err instanceof ToolInputError && /evolution_typebot_settings_set/.test(err.message));
    assert.deepEqual(client.calls, [{ method: "GET", path: "/typebot/fetchSettings/main" }]);
  });
  await t.test("unreadable", async () => {
    const failure = new Error("Typebot is disabled");
    const client = routedClient({ "GET /typebot/fetchSettings/main": failure, "POST /typebot/start/main": {} });
    await assert.rejects(start.handler(client, start.inputSchema.parse(flow)), (err) => err === failure);
    assert.deepEqual(client.calls, [{ method: "GET", path: "/typebot/fetchSettings/main" }]);
  });
});

/** An OpenaiBot row as returned by /openai/find. */
function openaiBot(id, openaiCredsId, description) {
  return {
    id, enabled: true, description, botType: "chatCompletion", assistantId: null, functionUrl: null,
    model: "gpt-4o-mini", systemMessages: [], assistantMessages: [], userMessages: [], maxTokens: 300,
    expire: 0, keywordFinish: null, delayMessage: null, unknownMessage: null, listeningFromMe: false,
    stopBotFromMe: false, keepOpen: false, debounceTime: null, splitMessages: false, timePerChar: 50,
    ignoreJids: null, triggerType: "keyword", triggerOperator: "equals", triggerValue: id,
    createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-01T12:00:00.000Z", openaiCredsId,
    instanceId: "internal-instance-id",
  };
}

const savedOpenaiSettings = {
  id: "openai-settings-1", expire: 300, keywordFinish: "bye", delayMessage: 1000,
  unknownMessage: "Sorry, I dont understand", listeningFromMe: true, stopBotFromMe: true, keepOpen: false,
  debounceTime: 1, ignoreJids: [], splitMessages: false, timePerChar: 50, speechToText: false,
  createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-01T12:00:00.000Z", openaiCredsId: "creds-default",
  openaiIdFallback: null, instanceId: "internal-instance-id", Fallback: null, fallbackId: null, fallback: null,
};

const openaiBots = [
  openaiBot("bot-sales", "creds-old", "Sales"),
  openaiBot("bot-support", "creds-old", null),
  openaiBot("bot-default", "creds-default", "Default"),
];

function credsClient({ settings = savedOpenaiSettings, bots = openaiBots, id = "creds-old" } = {}) {
  return routedClient({
    "GET /openai/fetchSettings/main": settings,
    "GET /openai/find/main": bots,
    [`DELETE /openai/creds/${encodeURIComponent(id)}/main`]: { openaiCreds: { id } },
  });
}

test("openai_creds_delete refuses to delete the credential the OpenAI settings use, even with force", async () => {
  const del = tool("evolution_openai_creds_delete");
  for (const force of [undefined, true]) {
    const client = credsClient({ id: "creds-default" });
    await assert.rejects(del.handler(client, del.inputSchema.parse({ id: "creds-default", force })),
      (err) => err instanceof ToolInputError && /settings/i.test(err.message));
    assert.equal(client.calls.some(({ method }) => method === "DELETE"), false);
  }
});

test("openai_creds_delete refuses while OpenAI bots use the credential and names them", async () => {
  const del = tool("evolution_openai_creds_delete");
  const client = credsClient();
  await assert.rejects(del.handler(client, del.inputSchema.parse({ id: "creds-old" })), (err) =>
    err instanceof ToolInputError && /bot-sales/.test(err.message) && /bot-support/.test(err.message) &&
    !/bot-default/.test(err.message) && /force/.test(err.message));
  assert.equal(client.calls.some(({ method }) => method === "DELETE"), false);
});

test("openai_creds_delete with force deletes a credential that bots still use", async () => {
  const del = tool("evolution_openai_creds_delete");
  const client = credsClient();
  await del.handler(client, del.inputSchema.parse({ id: "creds-old", force: true }));
  assert.deepEqual(client.calls.at(-1), { method: "DELETE", path: "/openai/creds/creds-old/main" });
});

test("openai_creds_delete deletes an unused credential", async () => {
  const del = tool("evolution_openai_creds_delete");
  const client = credsClient({ id: "creds/unused" });
  assert.deepEqual(await del.handler(client, del.inputSchema.parse({ id: "creds/unused" })),
    { openaiCreds: { id: "creds/unused" } });
  assert.deepEqual(client.calls.at(-1), { method: "DELETE", path: "/openai/creds/creds%2Funused/main" });
});

test("openai_creds_delete never deletes when a safety read fails", async (t) => {
  const del = tool("evolution_openai_creds_delete");
  const failure = new Error("Openai is disabled");
  for (const [label, options] of [
    ["settings read fails", { settings: failure }],
    ["bot list read fails", { bots: failure }],
    ["bot list is not an array", { bots: null }],
  ]) {
    await t.test(label, async () => {
      const client = credsClient(options);
      await assert.rejects(del.handler(client, del.inputSchema.parse({ id: "creds-old" })));
      assert.equal(client.calls.some(({ method }) => method === "DELETE"), false);
    });
  }
});
