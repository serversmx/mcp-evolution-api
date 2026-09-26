import assert from "node:assert/strict";
import test from "node:test";
import { ToolInputError } from "../dist/client.js";
import { allGroups } from "../dist/tools/index.js";

const bots = [
  ["typebot", "typebot", { url: "https://typebot.test", typebot: "flow" }, {}],
  ["openai", "openai", { openaiCredsId: "creds-1", botType: "chatCompletion" },
    { model: "test-model", maxTokens: 300, systemMessages: ["Keep this prompt."] }],
  ["dify", "dify", { botType: "chatBot" }, { apiUrl: "https://dify.test", apiKey: "kept-key" }],
  ["flowise", "flowise", { apiUrl: "https://flowise.test" }, { apiKey: "kept-key" }],
  ["n8n", "n8n", { webhookUrl: "https://n8n.test/webhook" },
    { basicAuthUser: "kept-user", basicAuthPass: "kept-password" }],
  ["evolutionbot", "evolutionBot", { apiUrl: "https://bot.test" }, { apiKey: "kept-key" }],
  ["evoai", "evoai", { agentUrl: "https://evoai.test" }, { apiKey: "kept-key" }],
];

function tool(group, action) {
  return allGroups.find((g) => g.group === group).tools.find((t) => t.name === `evolution_${group}_${action}`);
}

function clientFor(current, readError) {
  const calls = [];
  return {
    calls,
    resolveInstance: () => "instance",
    async get(path) {
      calls.push({ method: "GET", path });
      if (readError) throw readError;
      return current;
    },
    async put(path, { body }) {
      calls.push({ method: "PUT", path, body });
      return body;
    },
    async post(path, { body }) {
      calls.push({ method: "POST", path, body });
      return body;
    },
  };
}

for (const [group, base, required, preserved] of bots) {
  test(`${group}: complete required fields still preserve conditional trigger and bot fields`, async () => {
    const update = tool(group, "update");
    const current = {
      id: "bot/id",
      instanceId: "internal-instance-id",
      enabled: true,
      triggerType: "keyword",
      triggerOperator: "equals",
      triggerValue: "support",
      description: null,
      expire: 20,
      ...required,
      ...preserved,
    };
    const client = clientFor(current);
    const args = update.inputSchema.parse({
      id: "bot/id", enabled: false, triggerType: "keyword", expire: 0, ...required,
    });
    const result = await update.handler(client, args);
    assert.deepEqual(client.calls.map(({ method, path }) => ({ method, path })), [
      { method: "GET", path: `/${base}/fetch/bot%2Fid/instance` },
      { method: "PUT", path: `/${base}/update/bot%2Fid/instance` },
    ]);
    assert.equal(result.enabled, false);
    assert.equal(result.expire, 0);
    assert.equal(result.triggerOperator, "equals");
    assert.equal(result.triggerValue, "support");
    for (const [key, value] of Object.entries(preserved)) assert.deepEqual(result[key], value);
    assert.equal("id" in result, false);
    assert.equal("instanceId" in result, false);
    assert.equal("description" in result, false);
    assert.equal("basicAuthPassword" in result, false);
  });

  test(`${group}: failed reads abort both updates and settings writes`, async () => {
    const failure = new Error("Upstream settings unavailable");
    for (const [action, rawArgs] of [["update", { id: "bot-1", enabled: false }], ["settings_set", { expire: 0 }]]) {
      const target = tool(group, action);
      const client = clientFor(undefined, failure);
      await assert.rejects(target.handler(client, target.inputSchema.parse(rawArgs)), (err) => err === failure);
      assert.equal(client.calls.length, 1);
      assert.equal(client.calls[0].method, "GET");
    }
  });
}

test("OpenAI assistant updates preserve the assistant ID when the schema-required fields are supplied", async () => {
  const update = tool("openai", "update");
  const client = clientFor({
    enabled: true, triggerType: "none", openaiCredsId: "creds-1", botType: "assistant",
    assistantId: "asst-keep", model: null, maxTokens: null,
  });
  const result = await update.handler(client, update.inputSchema.parse({
    id: "bot-1", enabled: false, triggerType: "none", openaiCredsId: "creds-1", botType: "assistant",
  }));
  assert.equal(result.assistantId, "asst-keep");
  assert.equal("model" in result, false);
  assert.equal("maxTokens" in result, false);
});

test("bot settings merge keeps false/zero values and excludes metadata and ignored fallback names", async () => {
  const settings = tool("n8n", "settings_set");
  const client = clientFor({
    id: "settings-1", instanceId: "internal-instance-id", expire: 20,
    keywordFinish: null, listeningFromMe: false, stopBotFromMe: false,
    keepOpen: true, debounceTime: 0, ignoreJids: ["@g.us"], splitMessages: false,
    timePerChar: 0, n8nIdFallback: "old-bot", fallbackId: "old-bot", Fallback: { id: "old-bot" },
  });
  const result = await settings.handler(client, settings.inputSchema.parse({
    expire: 0, fallbackId: "new-bot", n8nIdFallback: "ignored-input",
  }));
  assert.equal(result.expire, 0);
  assert.equal(result.listeningFromMe, false);
  assert.equal(result.stopBotFromMe, false);
  assert.equal(result.debounceTime, 0);
  assert.equal(result.keywordFinish, "bye");
  assert.deepEqual(result.ignoreJids, ["@g.us"]);
  assert.equal(result.fallbackId, "new-bot");
  for (const key of ["id", "instanceId", "n8nIdFallback", "Fallback"]) assert.equal(key in result, false);
});

test("OpenAI settings refuse a write when no existing or supplied credential can satisfy the API", async () => {
  const settings = tool("openai", "settings_set");
  const client = clientFor({ expire: 300 });
  await assert.rejects(settings.handler(client, settings.inputSchema.parse({ expire: 0 })),
    (err) => err instanceof ToolInputError && /openaiCredsId/.test(err.message));
  assert.deepEqual(client.calls.map(({ method }) => method), ["GET"]);
});
