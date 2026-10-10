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

/**
 * fetchSettings of a stored n8n row created by the first bot create (expire 20, keepOpen true,
 * timePerChar 0): the behaviour fields the create omitted are stored as NULL.
 */
function storedN8nSettings() {
  return {
    id: "settings-1", expire: 20, keywordFinish: null, delayMessage: null, unknownMessage: null,
    listeningFromMe: false, stopBotFromMe: false, keepOpen: true, debounceTime: null,
    n8nIdFallback: null, ignoreJids: null, splitMessages: false, timePerChar: 0,
    createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-01T12:00:00.000Z",
    instanceId: "internal-instance-id", Fallback: null, fallbackId: null, fallback: null,
  };
}

/** fetchSettings of a stored Typebot row (keywordFinish/unknownMessage set, the rest NULL or DB defaults). */
function storedTypebotSettings(overrides = {}) {
  return {
    id: "settings-2", expire: 0, keywordFinish: "bye", delayMessage: null, unknownMessage: "Not understood",
    listeningFromMe: false, stopBotFromMe: false, keepOpen: false, debounceTime: null,
    typebotIdFallback: null, ignoreJids: null, splitMessages: false, timePerChar: 50,
    createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-01T12:00:00.000Z",
    instanceId: "internal-instance-id", Fallback: null, fallbackId: null, fallback: null,
    ...overrides,
  };
}

/**
 * fetchSettings of a stored row whose behaviour fields are NULL, as the first bot create leaves it
 * (base createBot@2.3.7; OpenAI's own createBot seeds values instead): DB-defaulted fields are false/0.
 */
function settingsWithNullBehaviour(extra = {}) {
  return {
    id: "settings-3", expire: 0, keywordFinish: null, delayMessage: null, unknownMessage: null,
    listeningFromMe: false, stopBotFromMe: false, keepOpen: false, debounceTime: null, ignoreJids: null,
    splitMessages: false, timePerChar: 0, createdAt: "2026-10-01T12:00:00.000Z",
    updatedAt: "2026-10-01T12:00:00.000Z", instanceId: "internal-instance-id", Fallback: null,
    fallbackId: null, fallback: null, ...extra,
  };
}

test("bot settings with only required fields refuse a NULL finish keyword and say how to keep it empty", async () => {
  const settings = tool("n8n", "settings_set");
  const client = clientFor(storedN8nSettings());
  await assert.rejects(
    settings.handler(client, settings.inputSchema.parse({ expire: 0 })),
    (err) => err instanceof ToolInputError && /keywordFinish/.test(err.message) && /fallbackId/.test(err.message) &&
      !/delayMessage|unknownMessage|debounceTime|ignoreJids/.test(err.message),
  );
  assert.deepEqual(client.calls, [{ method: "GET", path: "/n8n/fetchSettings/instance" }]);
});

test("bot settings send a NULL finish keyword as \"\" when fallbackId lets Evolution accept it", async (t) => {
  await t.test("n8n", async () => {
    const settings = tool("n8n", "settings_set");
    const client = clientFor(storedN8nSettings());
    await settings.handler(client, settings.inputSchema.parse({ expire: 0, fallbackId: "new-bot" }));
    assert.deepEqual(client.calls[1], {
      method: "POST",
      path: "/n8n/settings/instance",
      body: {
        expire: 0, keywordFinish: "", delayMessage: 1000, unknownMessage: "Sorry, I dont understand",
        listeningFromMe: false, stopBotFromMe: false, keepOpen: true, debounceTime: 0, ignoreJids: [],
        splitMessages: false, timePerChar: 0, fallbackId: "new-bot",
      },
    });
  });
  await t.test("EvoAI", async () => {
    const settings = tool("evoai", "settings_set");
    const client = clientFor(settingsWithNullBehaviour({ evoaiIdFallback: null }));
    await settings.handler(client, settings.inputSchema.parse({ fallbackId: "fallback-bot" }));
    assert.deepEqual(client.calls[1], {
      method: "POST",
      path: "/evoai/settings/instance",
      body: {
        expire: 0, keywordFinish: "", delayMessage: 1000, unknownMessage: "Sorry, I dont understand",
        listeningFromMe: false, stopBotFromMe: false, keepOpen: false, debounceTime: 0, ignoreJids: [],
        splitMessages: false, timePerChar: 0, fallbackId: "fallback-bot",
      },
    });
  });
});

test("bot settings re-send the stored fallbackId so an empty finish keyword stays accepted", async (t) => {
  await t.test("EvoAI row whose keywordFinish was already stored as \"\"", async () => {
    const settings = tool("evoai", "settings_set");
    const client = clientFor(settingsWithNullBehaviour({
      keywordFinish: "", fallbackId: "fallback-bot", evoaiIdFallback: "fallback-bot",
    }));
    await settings.handler(client, settings.inputSchema.parse({ debounceTime: 3 }));
    assert.equal(client.calls[1].path, "/evoai/settings/instance");
    assert.equal(client.calls[1].body.debounceTime, 3);
    assert.equal(client.calls[1].body.keywordFinish, "");
    assert.equal(client.calls[1].body.fallbackId, "fallback-bot");
  });
  await t.test("n8n row with NULL keywordFinish and a stored fallback", async () => {
    const settings = tool("n8n", "settings_set");
    const client = clientFor({ ...storedN8nSettings(), fallbackId: "old-bot", n8nIdFallback: "old-bot" });
    await settings.handler(client, settings.inputSchema.parse({ expire: 60 }));
    assert.equal(client.calls[1].body.keywordFinish, "");
    assert.equal(client.calls[1].body.fallbackId, "old-bot");
  });
  await t.test("explicit empty keywordFinish", async () => {
    const settings = tool("evolutionbot", "settings_set");
    const client = clientFor(settingsWithNullBehaviour({ keywordFinish: "#end", fallbackId: "fb", botIdFallback: "fb" }));
    await settings.handler(client, settings.inputSchema.parse({ keywordFinish: "" }));
    assert.equal(client.calls[1].body.keywordFinish, "");
    assert.equal(client.calls[1].body.fallbackId, "fb");
  });
});

test("bot settings refuse an empty finish keyword without a stored fallbackId and explain the trade-off", async (t) => {
  await t.test("EvoAI: a new fallback changes behaviour", async () => {
    const settings = tool("evoai", "settings_set");
    const client = clientFor(settingsWithNullBehaviour({ keywordFinish: "", evoaiIdFallback: null }));
    await assert.rejects(
      settings.handler(client, settings.inputSchema.parse({ expire: 30 })),
      (err) => err instanceof ToolInputError && /no fallbackId is stored/i.test(err.message) &&
        /every message that matches no trigger/.test(err.message),
    );
    assert.equal(client.calls.length, 1);
  });
  await t.test("n8n: a fallback is ignored at runtime", async () => {
    const settings = tool("n8n", "settings_set");
    const client = clientFor(storedN8nSettings());
    await assert.rejects(
      settings.handler(client, settings.inputSchema.parse({ expire: 30 })),
      (err) => err instanceof ToolInputError && /no fallbackId is stored/i.test(err.message) &&
        /ignores it at runtime/.test(err.message),
    );
  });
});

test("settings_set descriptions ask for keywordFinish exactly where a NULL one is refused", async () => {
  for (const [group, row, refused] of [
    ["typebot", settingsWithNullBehaviour({ typebotIdFallback: null }), false],
    ["openai", settingsWithNullBehaviour({ openaiIdFallback: null, openaiCredsId: "creds-1", speechToText: false }),
      false],
    ["flowise", settingsWithNullBehaviour({ flowiseIdFallback: null }), false],
    ["dify", settingsWithNullBehaviour({ difyIdFallback: null }), true],
    ["n8n", settingsWithNullBehaviour({ n8nIdFallback: null }), true],
    ["evolutionbot", settingsWithNullBehaviour({ botIdFallback: null }), true],
    ["evoai", settingsWithNullBehaviour({ evoaiIdFallback: null }), true],
  ]) {
    const settings = tool(group, "settings_set");
    const outcome = await settings.handler(clientFor(row), settings.inputSchema.parse({ expire: 30 })).then(
      () => "sent",
      (err) => (err instanceof ToolInputError ? "refused" : err),
    );
    assert.equal(outcome, refused ? "refused" : "sent", `${group} settings_set`);
    assert.equal(/keywordFinish must be passed/.test(settings.description), refused, `${group} description`);
  }
});

test("bot settings fill stored NULLs only with runtime-equivalent values and keep false/zero values", async () => {
  const settings = tool("n8n", "settings_set");
  const client = clientFor(storedN8nSettings());
  await settings.handler(client, settings.inputSchema.parse({
    expire: 0, keywordFinish: "#end", fallbackId: "new-bot", n8nIdFallback: "ignored-input",
  }));
  assert.deepEqual(client.calls, [
    { method: "GET", path: "/n8n/fetchSettings/instance" },
    {
      method: "POST",
      path: "/n8n/settings/instance",
      body: {
        expire: 0, keywordFinish: "#end", delayMessage: 1000, unknownMessage: "Sorry, I dont understand",
        listeningFromMe: false, stopBotFromMe: false, keepOpen: true, debounceTime: 0, ignoreJids: [],
        splitMessages: false, timePerChar: 0, fallbackId: "new-bot",
      },
    },
  ]);
});

test("Typebot settings send NULL keywordFinish/unknownMessage as \"\" instead of inventing values", async (t) => {
  await t.test("row left by the first bot create", async () => {
    const settings = tool("typebot", "settings_set");
    const client = clientFor(settingsWithNullBehaviour({ typebotIdFallback: null }));
    await settings.handler(client, settings.inputSchema.parse({ expire: 30 }));
    assert.deepEqual(client.calls[1], {
      method: "POST",
      path: "/typebot/settings/instance",
      body: {
        expire: 30, keywordFinish: "", delayMessage: 1000, unknownMessage: "",
        listeningFromMe: false, stopBotFromMe: false, keepOpen: false, splitMessages: false, timePerChar: 0,
      },
    });
  });
  await t.test("only unknownMessage NULL", async () => {
    const settings = tool("typebot", "settings_set");
    const client = clientFor(storedTypebotSettings({ unknownMessage: null }));
    await settings.handler(client, settings.inputSchema.parse({ expire: 5 }));
    assert.deepEqual(client.calls[1], {
      method: "POST",
      path: "/typebot/settings/instance",
      body: {
        expire: 5, keywordFinish: "bye", delayMessage: 1000, unknownMessage: "",
        listeningFromMe: false, stopBotFromMe: false, keepOpen: false, splitMessages: false, timePerChar: 50,
      },
    });
  });
});

test("Typebot settings leave optional fields stored as NULL untouched", async () => {
  const settings = tool("typebot", "settings_set");
  const client = clientFor(storedTypebotSettings());
  await settings.handler(client, settings.inputSchema.parse({ expire: 5 }));
  assert.deepEqual(client.calls[1], {
    method: "POST",
    path: "/typebot/settings/instance",
    body: {
      expire: 5, keywordFinish: "bye", delayMessage: 1000, unknownMessage: "Not understood",
      listeningFromMe: false, stopBotFromMe: false, keepOpen: false, splitMessages: false, timePerChar: 50,
    },
  });
});

test("never-saved bot settings still start from the server defaults", async (t) => {
  const neverSaved = {
    expire: 300, keywordFinish: "bye", delayMessage: 1000, unknownMessage: "Sorry, I dont understand",
    listeningFromMe: true, stopBotFromMe: true, keepOpen: false, debounceTime: 1, ignoreJids: [],
    splitMessages: false, timePerChar: 0, fallbackId: "", fallback: null,
  };
  for (const [label, current] of [["defaults without id", neverSaved], ["null", null]]) {
    await t.test(label, async () => {
      const settings = tool("n8n", "settings_set");
      const client = clientFor(current);
      await settings.handler(client, settings.inputSchema.parse({ expire: 0 }));
      assert.deepEqual(client.calls[1], {
        method: "POST",
        path: "/n8n/settings/instance",
        body: {
          expire: 0, keywordFinish: "bye", delayMessage: 1000, unknownMessage: "Sorry, I dont understand",
          listeningFromMe: true, stopBotFromMe: true, keepOpen: false, debounceTime: 1, ignoreJids: [],
          splitMessages: false, timePerChar: 0,
        },
      });
    });
  }
});

test("OpenAI settings refuse a write when no existing or supplied credential can satisfy the API", async () => {
  const settings = tool("openai", "settings_set");
  const client = clientFor({ expire: 300 });
  await assert.rejects(settings.handler(client, settings.inputSchema.parse({ expire: 0 })),
    (err) => err instanceof ToolInputError && /openaiCredsId/.test(err.message));
  assert.deepEqual(client.calls.map(({ method }) => method), ["GET"]);
});
