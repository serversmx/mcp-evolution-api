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
