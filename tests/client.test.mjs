import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { EvolutionApiError, EvolutionClient, extractApiMessage } from "../dist/client.js";
import { serverGroup } from "../dist/tools/server.js";

const config = {
  baseUrl: "https://evolution.test",
  apiKey: "test-api-key",
  defaultInstance: "test/instance",
  timeoutMs: 1000,
};
const client = new EvolutionClient(config);
afterEach(() => mock.restoreAll());

test("validation detail wins over generic message/error, including group errors", () => {
  assert.equal(extractApiMessage({
    response: { message: ["number is required", { property: "instance.name", message: "invalid" }] },
    message: "generic message",
    error: "Bad Request",
  }, 400), "number is required; instance.name: invalid");
  assert.equal(extractApiMessage({ response: { message: [] }, message: "specific", error: "generic" }, 400), "specific");
  assert.equal(extractApiMessage({ response: { message: " " }, error: "Unauthorized" }, 401), "Unauthorized");
  assert.equal(extractApiMessage({ message: "Meta request failed", details: { error_user_msg: "Fix the template" } }, 400), "Meta request failed (Fix the template)");
});

test("license errors preserve the code and activation URL without retrying", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    error: "service not activated",
    code: "LICENSE_REQUIRED",
    register_url: "https://evolution.test/manager/login",
  }), { status: 503 }));
  await assert.rejects(client.post("/message/sendText/test"), (err) => {
    assert.ok(err instanceof EvolutionApiError);
    assert.equal(err.status, 503);
    assert.equal(err.code, "LICENSE_REQUIRED");
    assert.match(err.message, /https:\/\/evolution\.test\/manager\/login/);
    assert.match(err.message, /retrying will not help/);
    return true;
  });
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("HTTP 200 error:true is a failure, while error:false and empty responses succeed", async () => {
  mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: true, message: "Connection Closed" })));
  await assert.rejects(client.post("/instance/restart/test"), (err) => {
    assert.ok(err instanceof EvolutionApiError);
    assert.equal(err.status, 200);
    assert.equal(err.message, "Connection Closed");
    return true;
  });
  mock.restoreAll();
  mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: false, status: "SUCCESS" })));
  assert.deepEqual(await client.delete("/instance/logout/test"), { error: false, status: "SUCCESS" });
  mock.restoreAll();
  mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
  assert.equal(await client.get("/websocket/find/test"), null);
});

test("unknown-route errors explain version availability without misclassifying missing instances", async () => {
  mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    error: "Not Found", response: { message: ["Cannot POST /message/sendCarousel/test"] },
  }), { status: 404 }));
  await assert.rejects(client.post("/message/sendCarousel/test"), /requires a newer Evolution API version/);
  mock.restoreAll();
  mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    error: "Not Found", response: { message: ['The "test" instance does not exist'] },
  }), { status: 404 }));
  await assert.rejects(client.get("/instance/connect/test"), (err) => {
    assert.equal(err.message, 'The "test" instance does not exist');
    return true;
  });
});

test("timeout includes reading the response body", async () => {
  mock.method(globalThis, "fetch", async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
    },
  })));
  const shortTimeout = new EvolutionClient({ ...config, timeoutMs: 25 });
  await assert.rejects(shortTimeout.get("/instance/connect/test"), /Request timed out after 25ms/);
});

/** fetch that answers after `ms`, or rejects like undici when the request is aborted first. */
function slowFetch(ms) {
  return async (_url, { signal }) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("This operation was aborted", "AbortError"));
      }, { once: true });
    });
    return new Response(JSON.stringify({ key: { id: "sent" } }), { status: 201 });
  };
}

test("a send delay extends the request timeout by that delay", async () => {
  mock.method(globalThis, "fetch", slowFetch(40));
  const shortTimeout = new EvolutionClient({ ...config, timeoutMs: 25 });
  assert.deepEqual(
    await shortTimeout.post("/message/sendText/test", { body: { number: "1", text: "hi", delay: 50 } }),
    { key: { id: "sent" } },
  );
  await assert.rejects(
    shortTimeout.post("/message/sendText/test", { body: { number: "1", text: "hi" } }),
    /Request timed out after 25ms/,
  );
});

test("only a non-negative numeric delay extends the timeout", async () => {
  const shortTimeout = new EvolutionClient({ ...config, timeoutMs: 25 });
  mock.method(globalThis, "fetch", slowFetch(40));
  await assert.rejects(
    shortTimeout.post("/chat/sendPresence/test", { body: { number: "1", presence: "composing", delay: "50" } }),
    /Request timed out after 25ms/,
  );
  mock.restoreAll();
  mock.method(globalThis, "fetch", slowFetch(15));
  assert.deepEqual(
    await shortTimeout.post("/chat/sendPresence/test", { body: { number: "1", presence: "composing", delay: -20 } }),
    { key: { id: "sent" } },
  );
});

test("delays beyond the timer range wait instead of aborting at once", async () => {
  mock.method(globalThis, "fetch", slowFetch(40));
  const shortTimeout = new EvolutionClient({ ...config, timeoutMs: 25 });
  assert.deepEqual(
    await shortTimeout.post("/message/sendText/test", { body: { number: "1", text: "hi", delay: 3_000_000_000 } }),
    { key: { id: "sent" } },
  );
});

test("send timeouts report the effective timeout and warn that the message may still be delivered", async () => {
  mock.method(globalThis, "fetch", slowFetch(1000));
  const shortTimeout = new EvolutionClient({ ...config, timeoutMs: 25 });
  await assert.rejects(
    shortTimeout.post("/message/sendText/test", { body: { number: "1", text: "hi", delay: 10 } }),
    (err) => {
      assert.match(err.message, /^Request timed out after 35ms \(timeout 25ms \+ delay 10ms\): POST \/message\/sendText\/test\. /);
      assert.match(err.message, /may still deliver the message/);
      assert.match(err.message, /duplicate/);
      return true;
    },
  );
  await assert.rejects(
    shortTimeout.post("/chat/sendPresence/test", { body: { number: "1", presence: "composing", delay: 10 } }),
    (err) => {
      assert.equal(err.message, "Request timed out after 35ms (timeout 25ms + delay 10ms): POST /chat/sendPresence/test");
      return true;
    },
  );
});

test("a typebot start timeout warns that the flow may still run and that a retry restarts it", async () => {
  mock.method(globalThis, "fetch", slowFetch(1000));
  const shortTimeout = new EvolutionClient({ ...config, timeoutMs: 25 });
  const body = {
    url: "https://typebot.example.test",
    typebot: "welcome",
    remoteJid: "5215512345678@s.whatsapp.net",
    startSession: true,
  };
  await assert.rejects(shortTimeout.post("/typebot/start/test", { body }), {
    message: "Request timed out after 25ms: POST /typebot/start/test. The flow may still be running on the " +
      "server: check the chat (evolution_chat_find_messages) before retrying — a retry deletes that chat's bot " +
      "sessions of every integration and restarts the flow.",
  });
  // Other Typebot writes start no flow.
  await assert.rejects(
    shortTimeout.post("/typebot/changeStatus/test", { body: { remoteJid: body.remoteJid, status: "closed" } }),
    { message: "Request timed out after 25ms: POST /typebot/changeStatus/test" },
  );
});

/** Answer every fetch with an Evolution error envelope. */
function mockError(status, message) {
  mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    status, error: status === 500 ? "Internal Server Error" : "Bad Request", response: { message },
  }), { status }));
}

test("'[object Object]' errors are replaced by a hint for the failing route", async () => {
  // restart/connect answer 200 {error:true, message: error.toString()} (instance.controller.ts@2.3.7).
  mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: true, message: "[object Object]" })));
  await assert.rejects(client.post("/instance/restart/test"), {
    status: 200,
    message: "Evolution API could not restart the instance (it is probably closed or not loaded): use evolution_instance_connect.",
  });
  await assert.rejects(client.get("/instance/connect/test"), {
    message: "Evolution API failed to start the connection (details were lost server-side): check evolution_instance_connection_state and the server logs.",
  });
  mock.restoreAll();
  // 2.3.7 delete: BadRequestException(error.toString()) when the logout fails.
  mockError(400, ["[object Object]"]);
  await assert.rejects(client.delete("/instance/delete/test"), {
    status: 400,
    message: "Evolution API 2.3.7 failed to log the instance out before deleting it: retry, or run evolution_instance_logout first.",
  });
  await assert.rejects(client.delete("/instance/logout/test"), {
    message: "Evolution API returned an error without details ('[object Object]').",
  });
});

test("develop's Express 5 group crash is explained only for group calls without a JSON body", async () => {
  mockError(500, "Cannot convert undefined or null to object");
  await assert.rejects(client.get("/group/participants/test", { query: { groupJid: "120363000000000000@g.us" } }), {
    status: 500,
    message: "Cannot convert undefined or null to object (known Evolution API develop/2.4 regression: Express 5 " +
      "leaves the request body undefined on group routes that carry no JSON body; works on 2.3.7 and " +
      "2.4.0-rc2 — report it upstream)",
  });
  await assert.rejects(
    client.post("/group/updateGroupSubject/test", { body: { groupJid: "120363000000000000@g.us", subject: "New" } }),
    { message: "Cannot convert undefined or null to object" },
  );
  await assert.rejects(client.get("/chat/findChats/test"), { message: "Cannot convert undefined or null to object" });
});

test("the same 500 from fetchAllGroups is not called develop-only: on 2.3.7 the instance has no session", async () => {
  // 2.3.7/rc2 fetchAllGroups runs Object.values(undefined) when the instance has no Baileys client.
  mockError(500, "Cannot convert undefined or null to object");
  await assert.rejects(client.get("/group/fetchAllGroups/test", { query: { getParticipants: false } }), (err) => {
    assert.equal(err.status, 500);
    assert.doesNotMatch(err.message, /works on 2\.3\.7/);
    assert.equal(
      err.message,
      "Cannot convert undefined or null to object (on Evolution API 2.3.7/2.4.0-rc2 this means the instance " +
        "has no WhatsApp session loaded — disconnected when the server started, or never connected: check " +
        "evolution_instance_connection_state and run evolution_instance_connect. On develop builds it is also " +
        "the known Express 5 regression for group routes without a JSON body.)",
    );
    return true;
  });
});

test("develop's instance-create foreign-key failure is explained", async () => {
  const hint = " (known Evolution API develop regression from security fix #2549: instanceName is stripped from " +
    "the create body; use 2.3.7/2.4.0-rc2 or a build that includes upstream commit ebd7ab7)";
  const body = { instanceName: "sales", integration: "WHATSAPP-BAILEYS" };
  // Prisma messages start with a newline, which the extracted message drops.
  for (const [prismaMessage, extracted] of [
    [
      "\nInvalid `this.prismaRepository.webhook.upsert()` invocation:\n\nForeign key constraint violated on the constraint: `Webhook_instanceId_fkey`",
      "Invalid `this.prismaRepository.webhook.upsert()` invocation:\n\nForeign key constraint violated on the constraint: `Webhook_instanceId_fkey`",
    ],
    [
      "\nInvalid `this.prismaRepository.setting.upsert()` invocation:\n\nForeign key constraint failed on the field: `Setting_instanceId_fkey (index)`",
      "Invalid `this.prismaRepository.setting.upsert()` invocation:\n\nForeign key constraint failed on the field: `Setting_instanceId_fkey (index)`",
    ],
  ]) {
    mockError(400, [prismaMessage]);
    await assert.rejects(client.post("/instance/create", { body }), { status: 400, message: extracted + hint });
    mock.restoreAll();
  }
  mockError(400, ['This name "sales" is already in use.']);
  await assert.rejects(client.post("/instance/create", { body }), { message: 'This name "sales" is already in use.' });
});

test("credential verification withholds Facebook secrets", async () => {
  mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    status: 200, message: "Credentials are valid", facebookAppId: "app-id",
    facebookConfigId: "private-config", facebookUserToken: "private-token",
  })));
  const tool = serverGroup.tools.find((t) => t.name === "evolution_server_verify_creds");
  assert.deepEqual(await tool.handler(client, {}), {
    status: 200, message: "Credentials are valid", facebookAppConfigured: true,
  });
});
