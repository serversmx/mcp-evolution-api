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

test("bot settings with only required fields keep a NULL finish keyword empty by re-sending the NULL fallback", async () => {
  const settings = tool("n8n", "settings_set");
  const client = clientFor(storedN8nSettings());
  await settings.handler(client, settings.inputSchema.parse({ expire: 0 }));
  assert.deepEqual(client.calls, [
    { method: "GET", path: "/n8n/fetchSettings/instance" },
    {
      method: "POST",
      path: "/n8n/settings/instance",
      body: {
        expire: 0, keywordFinish: "", delayMessage: 1000, unknownMessage: "Sorry, I dont understand",
        listeningFromMe: false, stopBotFromMe: false, keepOpen: true, debounceTime: 0, ignoreJids: [],
        splitMessages: false, timePerChar: 0, fallbackId: null,
      },
    },
  ]);
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

test("bot settings without a stored fallback send fallbackId null so an empty value stays accepted", async (t) => {
  await t.test("EvoAI row whose keywordFinish is already \"\"", async () => {
    const settings = tool("evoai", "settings_set");
    const client = clientFor(settingsWithNullBehaviour({ keywordFinish: "", evoaiIdFallback: null }));
    await settings.handler(client, settings.inputSchema.parse({ expire: 30 }));
    assert.equal(client.calls[1].body.keywordFinish, "");
    assert.equal(client.calls[1].body.fallbackId, null);
  });
  await t.test("clearing a stored finish keyword", async () => {
    const settings = tool("n8n", "settings_set");
    const client = clientFor({ ...storedN8nSettings(), keywordFinish: "bye" });
    await settings.handler(client, settings.inputSchema.parse({ keywordFinish: "" }));
    assert.equal(client.calls[1].body.keywordFinish, "");
    assert.equal(client.calls[1].body.fallbackId, null);
  });
  await t.test("n8n row with a stored empty unknownMessage", async () => {
    const settings = tool("n8n", "settings_set");
    const client = clientFor({ ...storedN8nSettings(), unknownMessage: "" });
    await settings.handler(client, settings.inputSchema.parse({ keywordFinish: "#end" }));
    assert.equal(client.calls[1].body.unknownMessage, "");
    assert.equal(client.calls[1].body.fallbackId, null);
  });
});

test("bot settings re-send the stored fallback for a stored empty unknownMessage", async () => {
  const settings = tool("evoai", "settings_set");
  const client = clientFor(settingsWithNullBehaviour({
    keywordFinish: "#end", unknownMessage: "", fallbackId: "fb", evoaiIdFallback: "fb",
  }));
  await settings.handler(client, settings.inputSchema.parse({ expire: 15 }));
  assert.equal(client.calls[1].body.unknownMessage, "");
  assert.equal(client.calls[1].body.fallbackId, "fb");
});

test("a complete settings request that clears keywordFinish still reads the stored fallback", async () => {
  const settings = tool("evoai", "settings_set");
  const client = clientFor(settingsWithNullBehaviour({ keywordFinish: "bye", fallbackId: "fb", evoaiIdFallback: "fb" }));
  const complete = {
    expire: 60, keywordFinish: "", delayMessage: 1000, unknownMessage: "Sorry", listeningFromMe: false,
    stopBotFromMe: false, keepOpen: false, debounceTime: 0, ignoreJids: [], splitMessages: false, timePerChar: 0,
  };
  await settings.handler(client, settings.inputSchema.parse(complete));
  assert.deepEqual(client.calls.map(({ method, path }) => `${method} ${path}`), [
    "GET /evoai/fetchSettings/instance",
    "POST /evoai/settings/instance",
  ]);
  assert.deepEqual(client.calls[1].body, { ...complete, fallbackId: "fb" });
});

test("bot settings_set rejects fallbackId \"\" before any request", () => {
  const settings = tool("evoai", "settings_set");
  assert.throws(() => settings.inputSchema.parse({ fallbackId: "" }));
});

test("settings_set never refuses a NULL keywordFinish and describes how it stays empty", async () => {
  for (const [group, row] of [
    ["typebot", settingsWithNullBehaviour({ typebotIdFallback: null })],
    ["openai", settingsWithNullBehaviour({ openaiIdFallback: null, openaiCredsId: "creds-1", speechToText: false })],
    ["flowise", settingsWithNullBehaviour({ flowiseIdFallback: null })],
    ["dify", settingsWithNullBehaviour({ difyIdFallback: null })],
    ["n8n", settingsWithNullBehaviour({ n8nIdFallback: null })],
    ["evolutionbot", settingsWithNullBehaviour({ botIdFallback: null })],
    ["evoai", settingsWithNullBehaviour({ evoaiIdFallback: null })],
  ]) {
    const settings = tool(group, "settings_set");
    const client = clientFor(row);
    await settings.handler(client, settings.inputSchema.parse({ expire: 30 }));
    assert.equal(client.calls[1].body.keywordFinish, "", `${group} keywordFinish`);
    assert.equal(/must be passed/.test(settings.description), false, `${group} description`);
    assert.match(settings.description, /keywordFinish ""/, `${group} description`);
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

/** fetchSettings before the first save: server defaults, no id, fallbackId "". */
function neverSavedSettings() {
  return {
    expire: 300, keywordFinish: "bye", delayMessage: 1000, unknownMessage: "Sorry, I dont understand",
    listeningFromMe: true, stopBotFromMe: true, keepOpen: false, debounceTime: 1, ignoreJids: [],
    splitMessages: false, timePerChar: 0, fallbackId: "", fallback: null,
  };
}

test("never-saved settings cannot be created with an empty keywordFinish: refused before any write", async (t) => {
  for (const [label, args] of [
    ["keywordFinish only", { keywordFinish: "" }],
    ["with a fallbackId", { keywordFinish: "", fallbackId: "bot-1" }],
  ]) {
    await t.test(label, async () => {
      const settings = tool("n8n", "settings_set");
      const client = clientFor(neverSavedSettings());
      await assert.rejects(
        settings.handler(client, settings.inputSchema.parse(args)),
        (err) => err instanceof ToolInputError && /never saved/.test(err.message),
      );
      assert.deepEqual(client.calls, [{ method: "GET", path: "/n8n/fetchSettings/instance" }]);
    });
  }
});

/** Fake client answering GETs by path (unknown paths answer null) and failing chosen POSTs. */
function routedClient(gets, failPostNumber) {
  const calls = [];
  let posts = 0;
  return {
    calls,
    resolveInstance: () => "instance",
    async get(path) {
      calls.push({ method: "GET", path });
      return path in gets ? gets[path] : null;
    },
    async post(path, { body }) {
      calls.push({ method: "POST", path, body });
      posts += 1;
      if (posts === failPostNumber) throw new Error("socket hang up");
      return body;
    },
  };
}

const NEVER_SAVED_DEFAULTS = {
  expire: 300, keywordFinish: "bye", delayMessage: 1000, unknownMessage: "Sorry, I dont understand",
  listeningFromMe: true, stopBotFromMe: true, keepOpen: false, debounceTime: 1, ignoreJids: [],
  splitMessages: false, timePerChar: 0,
};

test("a fallbackId on never-saved settings is set by an update after creating them", async () => {
  const settings = tool("evoai", "settings_set");
  const client = routedClient({
    "/evoai/fetchSettings/instance": neverSavedSettings(),
    "/evoai/fetch/bot-1/instance": { id: "bot-1", enabled: true },
  });
  await settings.handler(client, settings.inputSchema.parse({ fallbackId: "bot-1" }));
  assert.deepEqual(client.calls, [
    { method: "GET", path: "/evoai/fetchSettings/instance" },
    { method: "GET", path: "/evoai/fetch/bot-1/instance" },
    { method: "POST", path: "/evoai/settings/instance", body: NEVER_SAVED_DEFAULTS },
    { method: "POST", path: "/evoai/settings/instance", body: { ...NEVER_SAVED_DEFAULTS, fallbackId: "bot-1" } },
  ]);
});

test("a never-saved fallbackId that is not a bot of the instance is refused before creating the settings", async () => {
  const settings = tool("n8n", "settings_set");
  const client = routedClient({ "/n8n/fetchSettings/instance": neverSavedSettings() });
  await assert.rejects(
    settings.handler(client, settings.inputSchema.parse({ fallbackId: "no-such-bot" })),
    (err) => err instanceof ToolInputError && /no-such-bot/.test(err.message),
  );
  assert.equal(client.calls.some((call) => call.method === "POST"), false);
});

test("when setting the fallback fails after creating the settings, the error says to run the call again", async () => {
  const settings = tool("evoai", "settings_set");
  const client = routedClient({
    "/evoai/fetchSettings/instance": neverSavedSettings(),
    "/evoai/fetch/bot-1/instance": { id: "bot-1" },
  }, 2);
  await assert.rejects(
    settings.handler(client, settings.inputSchema.parse({ fallbackId: "bot-1" })),
    (err) => /socket hang up/.test(err.message) && /created without the fallback/.test(err.message) &&
      /same call again/.test(err.message),
  );
});

test("OpenAI keeps an empty keywordFinish accepted with speechToText false instead of a fallbackId", async () => {
  const settings = tool("openai", "settings_set");
  const client = clientFor(settingsWithNullBehaviour({
    openaiIdFallback: null, openaiCredsId: "creds-1", splitMessages: null, timePerChar: null, speechToText: null,
  }));
  await settings.handler(client, settings.inputSchema.parse({ expire: 30 }));
  assert.equal(client.calls[1].body.keywordFinish, "");
  assert.equal(client.calls[1].body.speechToText, false);
  assert.equal("fallbackId" in client.calls[1].body, false);
});

test("OpenAI settings refuse a fallbackId, which Evolution cannot store for OpenAI", async () => {
  const settings = tool("openai", "settings_set");
  const client = clientFor(settingsWithNullBehaviour({ openaiIdFallback: null, openaiCredsId: "creds-1" }));
  await assert.rejects(
    settings.handler(client, settings.inputSchema.parse({ fallbackId: "bot-1" })),
    (err) => err instanceof ToolInputError && /fallbackId/.test(err.message) && /OpenAI/.test(err.message),
  );
  assert.equal(client.calls.length, 0);
});

test("OpenAI settings refuse a write when no existing or supplied credential can satisfy the API", async () => {
  const settings = tool("openai", "settings_set");
  const client = clientFor({ expire: 300 });
  await assert.rejects(settings.handler(client, settings.inputSchema.parse({ expire: 0 })),
    (err) => err instanceof ToolInputError && /openaiCredsId/.test(err.message));
  assert.deepEqual(client.calls.map(({ method }) => method), ["GET"]);
});
