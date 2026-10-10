import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { EvolutionApiError, EvolutionClient, ToolInputError } from "../dist/client.js";
import { allGroups } from "../dist/tools/index.js";

const client = new EvolutionClient({
  baseUrl: "https://evolution.test",
  apiKey: "test-key",
  defaultInstance: "main",
  timeoutMs: 1000,
});
afterEach(() => mock.restoreAll());

const PHONE_JID = "5215512345678@s.whatsapp.net";
const LID_JID = "123456789012345@lid";

function tool(name) {
  for (const group of allGroups) {
    const found = group.tools.find((entry) => entry.name === name);
    if (found) return found;
  }
  throw new Error(`Unknown tool ${name}`);
}

/** Parse the arguments like the MCP server does, then run the handler. */
async function run(name, args) {
  const target = tool(name);
  return target.handler(client, target.inputSchema.parse(args));
}

/**
 * Mock fetch at the network boundary and record every request as {method, path, query, body}.
 * `reply(request)` returns the JSON value to answer with, or a Response for full control.
 */
function mockFetch(reply = () => ({})) {
  const requests = [];
  mock.method(globalThis, "fetch", async (url, init) => {
    const parsed = new URL(url);
    const request = {
      method: init.method,
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams),
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    requests.push(request);
    const answer = reply(request);
    return answer instanceof Response ? answer : new Response(JSON.stringify(answer));
  });
  return requests;
}

test("find_messages sends remoteJid as remoteJidAlt unless the caller passed a non-empty one", async () => {
  const requests = mockFetch(() => ({ messages: { records: [] } }));
  for (const [where, sent] of [
    [
      { key: { remoteJid: PHONE_JID, fromMe: true }, messageType: "imageMessage" },
      { key: { remoteJid: PHONE_JID, fromMe: true, remoteJidAlt: PHONE_JID }, messageType: "imageMessage" },
    ],
    [{ key: { remoteJid: LID_JID } }, { key: { remoteJid: LID_JID, remoteJidAlt: LID_JID } }],
    // Evolution drops an empty remoteJidAlt filter, which would leave only key.remoteJid = PHONE_JID.
    [{ key: { remoteJid: PHONE_JID, remoteJidAlt: "" } }, { key: { remoteJid: PHONE_JID, remoteJidAlt: PHONE_JID } }],
    [{ key: { remoteJid: PHONE_JID, remoteJidAlt: LID_JID } }, { key: { remoteJid: PHONE_JID, remoteJidAlt: LID_JID } }],
    [{ key: { remoteJidAlt: LID_JID } }, { key: { remoteJidAlt: LID_JID } }],
    [{ key: { id: "3EB0ABCDEF" } }, { key: { id: "3EB0ABCDEF" } }],
    [{ messageType: "conversation" }, { messageType: "conversation" }],
  ]) {
    await run("evolution_chat_find_messages", { where, page: 2 });
    assert.deepEqual(requests.at(-1), {
      method: "POST",
      path: "/chat/findMessages/main",
      query: {},
      body: { where: sent, page: 2 },
    });
  }
  await run("evolution_chat_find_messages", {});
  assert.deepEqual(requests.at(-1).body, {});
});

test("find_contacts sends a page size of 50 unless one is given", async () => {
  const requests = mockFetch(() => []);
  for (const [args, sent] of [
    [{}, { where: {}, offset: 50 }],
    [{ page: 2 }, { where: {}, page: 2, offset: 50 }],
    [{ where: { pushName: "Ana" }, page: 3, offset: 10 }, { where: { pushName: "Ana" }, page: 3, offset: 10 }],
  ]) {
    await run("evolution_chat_find_contacts", args);
    assert.deepEqual(requests.at(-1).body, sent);
  }
});

const editedKey = { remoteJid: PHONE_JID, fromMe: true, id: "3EB0ABCDEF" };

test("update_message sends key.remoteJid as number instead of the digits given", async () => {
  const requests = mockFetch();
  await run("evolution_chat_update_message", { number: "5215512345678", key: editedKey, text: "Fixed typo" });
  assert.deepEqual(requests, [{
    method: "POST",
    path: "/chat/updateMessage/main",
    query: {},
    body: { number: PHONE_JID, key: editedKey, text: "Fixed typo" },
  }]);
});

test("update_message does not need number", async () => {
  const requests = mockFetch();
  await run("evolution_chat_update_message", { key: editedKey, text: "Fixed typo" });
  assert.equal(requests[0].body.number, PHONE_JID);
});

test("update_message falls back to number only when key.remoteJid is empty", async () => {
  const requests = mockFetch();
  await run("evolution_chat_update_message", {
    number: PHONE_JID,
    key: { ...editedKey, remoteJid: "" },
    text: "Fixed typo",
  });
  assert.equal(requests[0].body.number, PHONE_JID);
});

test("update_message without any chat JID fails before the request", async () => {
  const requests = mockFetch();
  await assert.rejects(
    run("evolution_chat_update_message", { key: { ...editedKey, remoteJid: "" }, text: "Fixed typo" }),
    ToolInputError,
  );
  assert.equal(requests.length, 0);
});

/** A fetchInstances row (Prisma Instance + includes), as 2.3.7 and develop return it. */
function instanceRow(id, name, number) {
  return {
    id, name, connectionStatus: "open", ownerJid: `${number}@s.whatsapp.net`, profileName: name,
    profilePicUrl: null, integration: "WHATSAPP-BAILEYS", number, businessId: null, token: `token-${name}`,
    clientName: "evolution", Chatwoot: null, Proxy: { password: `proxy-secret-${name}` }, Setting: null,
    _count: { Message: 10, Contact: 5, Chat: 3 },
  };
}
const MAIN = instanceRow("cl-main", "main", "5215500000001");
const OTHER = instanceRow("cl-other", "other", "5215500000002");

test("instance_fetch keeps only the named instance when the server returns every instance", async () => {
  const requests = mockFetch(() => [MAIN, OTHER]);
  assert.deepEqual(await run("evolution_instance_fetch", { instanceName: "main" }), [MAIN]);
  assert.deepEqual(requests.map(({ method, path, query }) => ({ method, path, query })), [
    { method: "GET", path: "/instance/fetchInstances", query: { instanceName: "main" } },
  ]);
});

test("instance_fetch filters with 2.3.7's precedence: instanceId, then number, then instanceName", async () => {
  for (const [args, response, want] of [
    [{ instanceId: "cl-other", instanceName: "main" }, [MAIN, OTHER], [OTHER]],
    // 2.3.7 answers a number lookup with the number match and ignores instanceName.
    [{ number: "5215500000002", instanceName: "main" }, [OTHER], [OTHER]],
  ]) {
    mockFetch(() => response);
    assert.deepEqual(await run("evolution_instance_fetch", args), want);
    mock.restoreAll();
  }
});

test("instance_fetch reports an instance missing from the response like 2.3.7's 404", async () => {
  for (const [args, missing] of [[{ instanceName: "ghost" }, "ghost"], [{ instanceId: "cl-ghost" }, "cl-ghost"]]) {
    mockFetch(() => [MAIN, OTHER]);
    await assert.rejects(run("evolution_instance_fetch", args), (error) => {
      assert.ok(error instanceof EvolutionApiError);
      assert.equal(error.status, 404);
      assert.equal(error.message, `Instance "${missing}" not found`);
      return true;
    });
    mock.restoreAll();
  }
});

test("instance_fetch returns responses 2.3.7 already filtered, and non-arrays, unchanged", async () => {
  const notAnArray = { status: "unexpected" };
  for (const [args, response] of [
    [{ instanceName: "main" }, [MAIN]],
    [{ instanceId: "cl-other" }, [OTHER]],
    [{}, [MAIN, OTHER]],
    [{ instanceName: "" }, [MAIN, OTHER]],
    [{ instanceName: "main" }, notAnArray],
  ]) {
    mockFetch(() => response);
    assert.deepEqual(await run("evolution_instance_fetch", args), response);
    mock.restoreAll();
  }
});

test("revoke_invite and leave send groupJid in a JSON body as well as in the query", async () => {
  const requests = mockFetch();
  const groupJid = "120363012345678901@g.us";
  await run("evolution_group_revoke_invite", { groupJid });
  await run("evolution_group_leave", { groupJid });
  assert.deepEqual(requests, [
    { method: "POST", path: "/group/revokeInviteCode/main", query: { groupJid }, body: { groupJid } },
    { method: "DELETE", path: "/group/leaveGroup/main", query: { groupJid }, body: { groupJid } },
  ]);
});

test("template_find turns the empty reply Evolution sends for a failed Meta request into an error", async () => {
  mockFetch(() => new Response("", { status: 200 }));
  await assert.rejects(run("evolution_template_find", {}), (error) => {
    assert.ok(error instanceof EvolutionApiError);
    assert.match(error.message, /token/);
    assert.match(error.message, /businessId/);
    return true;
  });
});

test("template_find returns an account without templates as an empty list", async () => {
  mockFetch(() => []);
  assert.deepEqual(await run("evolution_template_find", {}), []);
});
