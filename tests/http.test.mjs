// MCP_TRANSPORT=http end to end: each suite spawns dist/index.js on a free port and drives it with the
// SDK client or raw HTTP. Evolution is a blocked port (127.0.0.1:9) or a local stub, and the OAuth issuer
// is a local fake IdP, so nothing outside 127.0.0.1 is ever contacted.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import * as nodeModule from "node:module";
import { connect } from "node:net";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { loadConfig } from "../dist/config.js";
import { buildRegistry } from "../dist/registry.js";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
// fetch() blocks port 9 (a "bad port" in the Fetch spec): no Evolution instance is ever contacted.
const evolutionEnv = { EVOLUTION_BASE_URL: "http://127.0.0.1:9", EVOLUTION_API_KEY: "x" };
const toolNames = (tools) => tools.map((tool) => tool.name).sort();
const defaultTools = toolNames(buildRegistry(loadConfig(evolutionEnv)).tools);
const mcpHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };

const rpc = (id, method, params) => ({ jsonrpc: "2.0", id, method, ...(params && { params }) });
const initialize = rpc(1, "initialize", {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "http-test", version: "0.0.0" },
});
const bearer = (token) => ({ authorization: `Bearer ${token}` });

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });

/** A TCP port nothing listens on right now. */
async function freePort() {
  const probe = createServer();
  await listen(probe);
  const { port } = probe.address();
  await close(probe);
  return port;
}

/** Spawn dist/index.js; `exited` settles with { code, signal } once stdout/stderr are fully read. */
function spawnEntry(env, { args = [], stdin = "ignore" } = {}) {
  const child = spawn(process.execPath, [...args, entry], {
    env: { PATH: process.env.PATH, ...evolutionEnv, ...env },
    stdio: [stdin, "pipe", "pipe"],
  });
  const proc = { child, stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { proc.stdout += chunk; });
  child.stderr.on("data", (chunk) => { proc.stderr += chunk; });
  proc.exited = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  return proc;
}

/**
 * Resolves once stderr satisfies `expected` (a RegExp or a predicate); rejects if the process exits
 * first or after 10 s. Log lines travel on a pipe, so they can arrive after the HTTP response they
 * belong to.
 */
function waitForLog(proc, expected) {
  const matches = typeof expected === "function" ? expected : (stderr) => expected.test(stderr);
  return new Promise((resolve, reject) => {
    const fail = (reason) => {
      clearTimeout(timer);
      proc.child.stderr.off("data", check);
      reject(new Error(`${reason} before logging ${expected}: ${proc.stderr}`));
    };
    const check = () => {
      if (!matches(proc.stderr)) return;
      clearTimeout(timer);
      proc.child.stderr.off("data", check);
      resolve();
    };
    const timer = setTimeout(() => fail("timed out"), 10000);
    proc.child.stderr.on("data", check);
    proc.exited.then(({ code, signal }) => fail(`exited (code ${code}, signal ${signal})`));
    check();
  });
}

/** HTTP mode on 127.0.0.1:`port`, resolved once the server reports it is ready. */
async function startHttp(port, env) {
  const proc = spawnEntry({ MCP_TRANSPORT: "http", MCP_HOST: "127.0.0.1", MCP_PORT: String(port), ...env });
  await waitForLog(proc, /ready \(http\)/);
  return proc;
}

async function stop(proc) {
  proc?.child.kill("SIGTERM");
  return proc?.exited;
}

async function post(url, headers = {}, body = initialize) {
  const res = await fetch(url, {
    method: "POST",
    headers: { ...mcpHeaders, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

/**
 * node:http request, because fetch() silently drops a custom Host header. The body goes as a Buffer so
 * that node:http writes the headers on their own, as latin1: a header value then reaches the server
 * byte for byte, e.g. "\x9b" as 0x9B (a string body would send the headers as UTF-8 with it).
 */
function rawRequest(port, { method = "POST", path = "/mcp", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : Buffer.from(body));
  });
}

/** Raw bytes over TCP, for requests node:http cannot make (e.g. HTTP/1.0 without a Host header). */
function rawSocket(port, text) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.end(text));
    let reply = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { reply += chunk; });
    socket.on("close", () => resolve(reply));
    socket.on("error", reject);
  });
}

async function connectClient(t, url, headers) {
  const client = new Client({ name: "http-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  t.after(() => client.close());
  return client;
}

/**
 * Local OAuth authorization server: an ES256 JWKS at /jwks holding two keys, as during a key rotation
 * (k1 signs by default, k2 is the next key), plus discovery metadata for its issuer ("oidc", "rfc8414"
 * or none). `outage` makes everything ("all") or only the JWKS ("jwks") answer 503; `metadataIssuer`
 * makes the metadata claim another issuer.
 */
async function startIdp({ discovery, issuerPath = "" }) {
  const pairs = { k1: await generateKeyPair("ES256"), k2: await generateKeyPair("ES256") };
  const jwks = {
    keys: await Promise.all(
      Object.entries(pairs).map(async ([kid, { publicKey }]) => ({ ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" })),
    ),
  };
  const metadataPath = {
    oidc: `${issuerPath}/.well-known/openid-configuration`,
    rfc8414: `/.well-known/oauth-authorization-server${issuerPath}`,
  }[discovery];
  const idp = { outage: undefined, metadataIssuer: undefined, metadataServed: 0, issued: [] };
  const server = createServer((req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (idp.outage === "all") return reply(503, { error: "temporarily_unavailable" });
    if (req.url === metadataPath) {
      idp.metadataServed += 1;
      return reply(200, { issuer: idp.metadataIssuer ?? idp.issuer, jwks_uri: `${idp.origin}/jwks` });
    }
    if (req.url === "/jwks" && idp.outage !== "jwks") return reply(200, jwks);
    reply(req.url === "/jwks" ? 503 : 404, { error: "unavailable" });
  });
  await listen(server);
  idp.origin = `http://127.0.0.1:${server.address().port}`;
  idp.issuer = idp.origin + issuerPath;
  idp.close = () => close(server);
  idp.keys = { k1: pairs.k1.privateKey, k2: pairs.k2.privateKey };
  /**
   * Access token signed with IdP key `kid` (kid: null leaves the header without one) or with `key`;
   * valid for 5 minutes unless `exp` says otherwise.
   */
  idp.sign = async ({ aud, sub = "owner-123", iss = idp.issuer, exp = "5m", kid = "k1", key = idp.keys[kid ?? "k1"], ...claims }) => {
    const jwt = new SignJWT({ client_id: "claude", ...(sub && { sub }), ...claims })
      .setProtectedHeader({ alg: "ES256", ...(kid !== null && { kid }) })
      .setIssuer(iss)
      .setAudience(aud)
      .setIssuedAt();
    if (exp !== null) jwt.setExpirationTime(exp);
    const token = await jwt.sign(key);
    idp.issued.push(token);
    return token;
  };
  return idp;
}

const secondsAgo = (seconds) => Math.floor(Date.now() / 1000) - seconds;

describe("HTTP mode with static bearer tokens", { timeout: 20000 }, () => {
  // Two 43-character tokens: MCP_AUTH_TOKEN takes a comma-separated list so tokens can be rotated.
  const tokens = [randomBytes(32).toString("base64url"), randomBytes(32).toString("base64url")];
  let port, url, server;
  before(async () => {
    port = await freePort();
    url = `http://127.0.0.1:${port}/mcp`;
    server = await startHttp(port, {
      MCP_AUTH_TOKEN: tokens.join(" , "),
      MCP_PUBLIC_URL: url,
      // The second entry is written the way an operator might paste it.
      MCP_ALLOWED_ORIGINS: "https://claude.ai, HTTPS://ChatGPT.com/",
    });
  });
  after(() => stop(server));

  test("GET /health answers without a token, whatever the Host", async () => {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
    const containerHost = await rawRequest(port, { method: "GET", path: "/health", headers: { host: "f3a1c2:3000" } });
    assert.equal(containerHost.status, 200);
  });

  test("an SDK client with a token initializes, lists the enabled tools and gets a clean tool error", async (t) => {
    const client = await connectClient(t, url, bearer(tokens[0]));
    assert.equal(client.getServerVersion().name, "evolution-api-mcp");
    assert.deepEqual(toolNames((await client.listTools()).tools), defaultTools);

    const result = await client.callTool({ name: "evolution_instance_fetch", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /GET \/instance\/fetchInstances/);
  });

  test("every token of the MCP_AUTH_TOKEN list is accepted", async () => {
    for (const token of tokens) {
      const res = await post(url, bearer(token));
      assert.equal(res.status, 200, res.text);
    }
  });

  test("a missing or wrong token gets 401 with a Bearer invalid_token challenge", async () => {
    const wrong = {
      missing: {},
      "same length": bearer("y".repeat(tokens[0].length)),
      truncated: bearer(tokens[0].slice(0, -1)),
      extended: bearer(`${tokens[0]}x`),
      "whole list": bearer(tokens.join(",")),
    };
    for (const [name, headers] of Object.entries(wrong)) {
      const res = await post(url, headers);
      assert.equal(res.status, 401, name);
      assert.match(res.headers.get("www-authenticate") ?? "", /^Bearer error="invalid_token"/, name);
    }
  });

  test("Origins are compared as scheme://host[:port]: any spelling of a listed origin is served", async () => {
    // claude.ai has been reported sending "Origin: https://claude.ai/" (trailing slash).
    const served = ["https://claude.ai", "https://claude.ai/", "https://Claude.ai", "HTTPS://CLAUDE.AI:443", "https://chatgpt.com"];
    for (const origin of served) {
      const res = await post(url, { ...bearer(tokens[0]), origin });
      assert.equal(res.status, 200, `${origin}: ${res.text}`);
    }
    const refused = ["https://evil.example", "http://claude.ai", "https://claude.ai:8443", "https://claude.ai.evil.example", "null"];
    for (const origin of refused) {
      assert.equal((await post(url, { ...bearer(tokens[0]), origin })).status, 403, origin);
    }
  });

  test("a rejected Origin is logged with its value, control characters escaped and length bounded", async () => {
    const res = await post(url, { ...bearer(tokens[0]), origin: "https://claude.com" });
    assert.equal(res.status, 403);
    assert.deepEqual(JSON.parse(res.text), {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Origin not allowed: https://claude.com" },
      id: null,
    });
    await waitForLog(server, /\[evolution-api-mcp\] rejected Origin "https:\/\/claude\.com": not in MCP_ALLOWED_ORIGINS\n/);

    // Header values arrive as latin1, so they can carry C1 controls: U+009B is a terminal CSI.
    const csi = await rawRequest(port, {
      headers: { ...mcpHeaders, ...bearer(tokens[0]), origin: "https://evil.example\x9b2J" },
      body: JSON.stringify(initialize),
    });
    assert.equal(csi.status, 403);
    await waitForLog(server, /rejected Origin "https:\/\/evil\.example\\u009b2J": not in MCP_ALLOWED_ORIGINS\n/);

    assert.equal((await post(url, { ...bearer(tokens[0]), origin: `https://${"a".repeat(5000)}.example` })).status, 403);
    const cut = (stderr) => stderr.split("\n").find((line) => /rejected Origin "https:\/\/a+…": not in MCP_ALLOWED_ORIGINS$/.test(line));
    await waitForLog(server, (stderr) => cut(stderr) !== undefined);
    assert.ok(cut(server.stderr).length < 1000, `logged ${cut(server.stderr).length} characters`);
  });

  test("a Host other than the MCP_PUBLIC_URL host gets 403 and is logged with its value", async () => {
    const request = (host) =>
      rawRequest(port, { headers: { ...mcpHeaders, ...bearer(tokens[0]), host }, body: JSON.stringify(initialize) });
    const evil = await request("evil.example:8443");
    assert.equal(evil.status, 403);
    assert.deepEqual(JSON.parse(evil.text), { jsonrpc: "2.0", error: { code: -32000, message: "Invalid Host: evil.example" }, id: null });
    await waitForLog(server, /\[evolution-api-mcp\] rejected Host "evil\.example:8443": not in MCP_ALLOWED_HOSTS \/ MCP_PUBLIC_URL\n/);
    assert.equal((await request("evil\x85.example")).status, 403);
    await waitForLog(server, /rejected Host "evil\\u0085\.example": not in MCP_ALLOWED_HOSTS \/ MCP_PUBLIC_URL\n/);
    assert.equal((await request(`127.0.0.1:${port}`)).status, 200);
  });

  test("a request without a Host header (HTTP/1.0) gets 403 too", async () => {
    const body = JSON.stringify(initialize);
    const head = [
      "POST /mcp HTTP/1.0",
      "content-type: application/json",
      "accept: application/json, text/event-stream",
      `authorization: Bearer ${tokens[0]}`,
      `content-length: ${Buffer.byteLength(body)}`,
    ];
    const reply = await rawSocket(port, `${head.join("\r\n")}\r\n\r\n${body}`);
    assert.match(reply, /^HTTP\/1\.1 403 /);
    await waitForLog(server, /rejected Host "": not in MCP_ALLOWED_HOSTS \/ MCP_PUBLIC_URL\n/);
  });

  test("a client header echoed in a transport error is logged with control characters escaped", async () => {
    const res = await rawRequest(port, {
      headers: { ...mcpHeaders, ...bearer(tokens[0]), "mcp-protocol-version": "2099-01-01\x9b2J" },
      body: JSON.stringify(rpc(2, "tools/list")),
    });
    assert.equal(res.status, 400);
    await waitForLog(server, /mcp: Bad Request: Unsupported protocol version: 2099-01-01\\u009b2J /);
  });

  test("GET and DELETE on the MCP endpoint get 405 with Allow: POST", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(url, { method, headers: { ...bearer(tokens[0]), accept: "text/event-stream" } });
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.get("allow"), "POST", method);
    }
  });

  test("unknown paths get a JSON 404", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp-old`, { headers: bearer(tokens[0]) });
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type"), /^application\/json/);
  });

  test("health, rejections, 404 and 405 carry Cache-Control: no-store", async () => {
    // A CDN that caches GETs unless the origin says otherwise would replay a stale /health, or a 404
    // for the OAuth metadata, long after the server changed.
    const wrongHost = await rawRequest(port, { headers: { ...mcpHeaders, host: "evil.example" }, body: JSON.stringify(initialize) });
    assert.equal(wrongHost.status, 403);
    assert.equal(wrongHost.headers["cache-control"], "no-store", "403 Host");
    const responses = [
      ["health", 200, await fetch(`http://127.0.0.1:${port}/health`)],
      ["no token", 401, await post(url)],
      ["Origin", 403, await post(url, { ...bearer(tokens[0]), origin: "https://evil.example" })],
      ["OAuth metadata in bearer mode", 404, await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`)],
      ["GET", 405, await fetch(url, { headers: bearer(tokens[0]) })],
    ];
    for (const [name, status, res] of responses) {
      assert.equal(res.status, status, name);
      assert.equal(res.headers.get("cache-control"), "no-store", name);
    }
  });

  test("SIGTERM exits 0; stdout stays empty and the access log has no tokens or bodies", async () => {
    const marker = `body-marker-${randomBytes(8).toString("hex")}`;
    const send = rpc(2, "tools/call", { name: "evolution_message_send_text", arguments: { number: "15551234567", text: marker } });
    assert.equal((await post(url, bearer(tokens[1]), send)).status, 200);
    assert.equal((await post(url, bearer(marker))).status, 401);

    assert.deepEqual(await stop(server), { code: 0, signal: null });
    assert.equal(server.stdout, "");
    assert.match(server.stderr, /POST \/mcp 200\b/);
    assert.match(server.stderr, /POST \/mcp 401\b/);
    for (const secret of [...tokens, marker]) {
      assert.equal(server.stderr.includes(secret), false, `logged ${secret}`);
    }
  });
});

describe("HTTP mode as an OAuth resource server (OIDC discovery)", { timeout: 20000 }, () => {
  let idp, port, url, server;
  before(async () => {
    idp = await startIdp({ discovery: "oidc" });
    port = await freePort();
    url = `http://127.0.0.1:${port}/mcp`;
    // MCP_AUTH_MODE is inferred from MCP_OAUTH_ISSUER.
    server = await startHttp(port, {
      MCP_OAUTH_ISSUER: idp.issuer,
      MCP_PUBLIC_URL: url,
      MCP_OAUTH_ALLOWED_SUBJECTS: "owner-123, owner-456",
    });
  });
  after(async () => {
    await stop(server);
    await idp?.close();
  });

  test("a request without a token gets 401 pointing at the protected resource metadata", async () => {
    const res = await post(url);
    assert.equal(res.status, 401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    assert.match(challenge, /^Bearer error="invalid_token"/);
    assert.ok(
      challenge.includes(`resource_metadata="http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp"`),
      challenge,
    );
  });

  test("protected resource metadata names MCP_PUBLIC_URL and the issuer at both well-known URLs", async () => {
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get("cache-control"), "no-store", path);
      const metadata = await res.json();
      assert.equal(metadata.resource, url, path);
      assert.deepEqual(metadata.authorization_servers, [idp.issuer], path);
    }
  });

  test("a valid token for an allowed subject lists the tools", async (t) => {
    const token = await idp.sign({ aud: url, sub: "owner-456" });
    const client = await connectClient(t, url, bearer(token));
    assert.deepEqual(toolNames((await client.listTools()).tools), defaultTools);
  });

  test("a token that expired within the 30 s clock tolerance is still accepted", async () => {
    const res = await post(url, bearer(await idp.sign({ aud: url, exp: secondsAgo(10) })));
    assert.equal(res.status, 200, res.text);
  });

  test("tokens for another audience, issuer or signing key, without a string subject, expired or never expiring, get 401", async () => {
    const { privateKey: foreignKey } = await generateKeyPair("ES256");
    const cases = {
      audience: { aud: "https://other.example/mcp" },
      issuer: { aud: url, iss: `${idp.issuer}/other` },
      "no subject": { aud: url, sub: null },
      "numeric subject": { aud: url, sub: 123 },
      "signing key": { aud: url, key: foreignKey },
      expired: { aud: url, exp: secondsAgo(120) },
      "no expiry": { aud: url, exp: null },
    };
    for (const [name, claims] of Object.entries(cases)) {
      const res = await post(url, bearer(await idp.sign(claims)));
      assert.equal(res.status, 401, name);
      assert.match(res.headers.get("www-authenticate") ?? "", /^Bearer error="invalid_token"/, name);
    }
  });

  test("a valid token for a subject that is not allowed gets 403 without a challenge, on every method", async () => {
    // A 401 challenge would send the client back to sign in as the same account, in a loop.
    const token = await idp.sign({ aud: url, sub: "stranger" });
    for (const method of ["POST", "GET"]) {
      const res = await fetch(url, {
        method,
        headers: { ...mcpHeaders, ...bearer(token) },
        ...(method === "POST" && { body: JSON.stringify(initialize) }),
      });
      assert.equal(res.status, 403, method);
      assert.equal(res.headers.get("www-authenticate"), null, method);
      const body = await res.json();
      assert.deepEqual([body.jsonrpc, body.id, body.error.code], ["2.0", null, -32000], method);
      assert.match(body.error.message, /not allowed/, method);
    }
  });

  test("the log says why a token was rejected, naming a subject that is not allowed", async () => {
    await waitForLog(server, /token rejected: .*"aud"/);
    await waitForLog(server, /token rejected: sub "stranger" is not in MCP_OAUTH_ALLOWED_SUBJECTS/);
  });

  test("a forged token header cannot add lines or terminal escapes to the log", async () => {
    // jose quotes an unknown "crit" name in its error message, before any signature check.
    const marker = `FORGED-${randomBytes(4).toString("hex")}`;
    const crit = `x\n[evolution-api-mcp] ${marker}\n\u001b[2J\u009b31m\u{2028}end`;
    const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const token = `${part({ alg: "ES256", kid: "k1", crit: [crit] })}.${part({ sub: "owner-123" })}.AAAA`;
    const res = await post(url, bearer(token));
    assert.equal(res.status, 401);

    const entry = `token rejected: Extension Header Parameter "x\\u000a[evolution-api-mcp] ${marker}\\u000a\\u001b[2J\\u009b31m\\u2028end" is not recognized\n`;
    await waitForLog(server, (stderr) => stderr.includes(entry));
    assert.equal(server.stderr.split("\n").some((line) => line.startsWith(`[evolution-api-mcp] ${marker}`)), false);
    assert.doesNotMatch(server.stderr, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u{2028}\u{2029}]/u);
  });

  test("a token without a kid is checked against every key of a rotating key set", async () => {
    // Both IdP keys match a kid-less ES256 token, so jose hands over the candidates instead of one key.
    for (const kid of ["k1", "k2"]) {
      const res = await post(url, bearer(await idp.sign({ aud: url, kid: null, key: idp.keys[kid] })));
      assert.equal(res.status, 200, `signed by ${kid}: ${res.text}`);
    }
    const { privateKey: foreignKey } = await generateKeyPair("ES256");
    const forged = await post(url, bearer(await idp.sign({ aud: url, kid: null, key: foreignKey })));
    assert.equal(forged.status, 401);
    assert.match(forged.headers.get("www-authenticate") ?? "", /^Bearer error="invalid_token"/);
  });

  test("SIGTERM exits 0 with nothing on stdout and no token in the logs", async () => {
    assert.deepEqual(await stop(server), { code: 0, signal: null });
    assert.equal(server.stdout, "");
    assert.ok(idp.issued.length > 0);
    for (const token of idp.issued) assert.equal(server.stderr.includes(token), false, "a token was logged");
  });
});

describe("OAuth at the root of MCP_PUBLIC_URL with RFC 8414 discovery and IdP outages", { timeout: 20000 }, () => {
  let idp, port, url, server;
  before(async () => {
    idp = await startIdp({ discovery: "rfc8414", issuerPath: "/tenant" });
    idp.outage = "all";
    port = await freePort();
    url = `http://127.0.0.1:${port}/`;
    server = await startHttp(port, {
      MCP_AUTH_MODE: "oauth",
      MCP_OAUTH_ISSUER: idp.issuer,
      MCP_PUBLIC_URL: `http://127.0.0.1:${port}`,
      MCP_OAUTH_ALLOWED_SUBJECTS: "owner-123",
    });
  });
  after(async () => {
    await stop(server);
    await idp?.close();
  });

  test("a URL without a path serves MCP at / and advertises the resource without a trailing slash", async () => {
    const res = await post(url);
    assert.equal(res.status, 401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    assert.ok(challenge.includes(`resource_metadata="http://127.0.0.1:${port}/.well-known/oauth-protected-resource"`), challenge);
    const metadata = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`).then((r) => r.json());
    // The MCP spec's canonical form, and what users type: https://mcp.example.com, not .../
    assert.equal(metadata.resource, `http://127.0.0.1:${port}`);
  });

  test("an unreachable IdP gets 500 without a challenge, so clients do not loop on sign-in", async () => {
    const res = await post(url, bearer(await idp.sign({ aud: url })));
    assert.equal(res.status, 500);
    assert.equal(res.headers.get("www-authenticate"), null);
    await waitForLog(server, /token check unavailable: Could not discover jwks_uri for issuer http:\/\/127\.0\.0\.1:\d+\/tenant/);
  });

  test("discovery metadata that names another issuer is not used", async () => {
    idp.outage = undefined;
    idp.metadataIssuer = "https://impostor.example/tenant";
    const res = await post(url, bearer(await idp.sign({ aud: url })));
    assert.equal(res.status, 500);
  });

  test("an unreachable JWKS gets 500 without a challenge as well", async () => {
    idp.metadataIssuer = undefined;
    idp.outage = "jwks";
    const unavailable = (stderr) => stderr.match(/token check unavailable: /g)?.length ?? 0;
    const before = unavailable(server.stderr);
    const res = await post(url, bearer(await idp.sign({ aud: url })));
    assert.equal(res.status, 500);
    assert.equal(res.headers.get("www-authenticate"), null);
    await waitForLog(server, (stderr) => unavailable(stderr) === before + 1);
  });

  test("verification recovers when the JWKS is back, without discovering the metadata again", async () => {
    idp.outage = undefined;
    const served = idp.metadataServed;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await post(url, bearer(await idp.sign({ aud: url })));
      assert.equal(res.status, 200, res.text);
    }
    assert.equal(idp.metadataServed, served);
  });

  test("a root resource accepts tokens for its URL with or without the trailing slash, and nothing else", async () => {
    const origin = `http://127.0.0.1:${port}`;
    for (const aud of [origin, `${origin}/`]) {
      const res = await post(url, bearer(await idp.sign({ aud })));
      assert.equal(res.status, 200, `${aud}: ${res.text}`);
    }
    assert.equal((await post(url, bearer(await idp.sign({ aud: `${origin}/mcp` })))).status, 401);
  });
});

describe("OAuth with MCP_OAUTH_JWKS_URL, a custom audience, required scopes and any subject", { timeout: 20000 }, () => {
  const audience = "api://evolution-mcp";
  let idp, port, url, server;
  before(async () => {
    // No discovery metadata at all: verification must use MCP_OAUTH_JWKS_URL.
    idp = await startIdp({ issuerPath: "/tenant" });
    port = await freePort();
    url = `http://127.0.0.1:${port}/evolution/mcp`;
    server = await startHttp(port, {
      MCP_AUTH_MODE: "oauth",
      MCP_OAUTH_ISSUER: idp.issuer,
      MCP_OAUTH_JWKS_URL: `${idp.origin}/jwks`,
      MCP_OAUTH_AUDIENCE: audience,
      MCP_PUBLIC_URL: url,
      MCP_OAUTH_REQUIRED_SCOPES: "mcp:tools",
      MCP_OAUTH_ALLOW_ANY_SUBJECT: "true",
    });
  });
  after(async () => {
    await stop(server);
    await idp?.close();
  });

  test("the endpoint and its metadata follow the path of MCP_PUBLIC_URL", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/evolution/mcp`);
    assert.equal(res.status, 200);
    const metadata = await res.json();
    assert.equal(metadata.resource, url);
    assert.deepEqual(metadata.scopes_supported, ["mcp:tools"]);

    const token = await idp.sign({ aud: audience, scope: "mcp:tools" });
    assert.equal((await post(url, bearer(token))).status, 200);
    assert.equal((await post(`http://127.0.0.1:${port}/mcp`, bearer(token))).status, 404);
  });

  test("any subject holding the required scope is served, as a scope string or an scp array", async () => {
    const scopeString = await idp.sign({ aud: audience, sub: "someone", scope: "openid mcp:tools" });
    assert.equal((await post(url, bearer(scopeString))).status, 200);
    const scpArray = await idp.sign({ aud: audience, sub: "someone-else", scp: ["mcp:tools"] });
    assert.equal((await post(url, bearer(scpArray))).status, 200);
  });

  test("MCP_OAUTH_AUDIENCE replaces MCP_PUBLIC_URL as the accepted audience", async () => {
    const res = await post(url, bearer(await idp.sign({ aud: url, scope: "mcp:tools" })));
    assert.equal(res.status, 401);
  });

  test("a token without a required scope gets 403 insufficient_scope", async () => {
    const res = await post(url, bearer(await idp.sign({ aud: audience, scope: "mcp" })));
    assert.equal(res.status, 403);
    assert.match(res.headers.get("www-authenticate") ?? "", /^Bearer error="insufficient_scope"/);
  });
});

describe("OAuth with a refused MCP_OAUTH_JWKS_URL", { timeout: 20000 }, () => {
  const issuer = "https://idp.example"; // never contacted: the JWKS URL is explicit
  let port, url, server;
  before(async () => {
    port = await freePort();
    url = `http://127.0.0.1:${port}/mcp`;
    server = await startHttp(port, {
      MCP_OAUTH_ISSUER: issuer,
      MCP_OAUTH_JWKS_URL: `http://127.0.0.1:${await freePort()}/jwks`, // nothing listens there
      MCP_PUBLIC_URL: url,
      MCP_OAUTH_ALLOWED_SUBJECTS: "owner-123",
    });
  });
  after(() => stop(server));

  test("a refused JWKS connection gets 500 and the log names the network error", async () => {
    const { privateKey } = await generateKeyPair("ES256");
    const token = await new SignJWT({ sub: "owner-123" })
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .setIssuer(issuer)
      .setAudience(url)
      .setExpirationTime("5m")
      .sign(privateKey);
    const res = await post(url, bearer(token));
    assert.equal(res.status, 500);
    assert.equal(res.headers.get("www-authenticate"), null);
    await waitForLog(server, /token check unavailable: .*ECONNREFUSED/);
  });
});

describe("HTTP mode behind an authenticating gateway (MCP_AUTH_MODE=none) with JSON responses", { timeout: 20000 }, () => {
  let evolution, respond, port, url, server;
  const fetchInstances = rpc(2, "tools/call", { name: "evolution_instance_fetch", arguments: {} });
  const sendText = (text) =>
    rpc(3, "tools/call", { name: "evolution_message_send_text", arguments: { number: "15551234567", text } });
  before(async () => {
    // Local stand-in for Evolution; each test decides how it answers.
    evolution = createServer((req, res) => respond(req, res));
    await listen(evolution);
    port = await freePort();
    url = `http://127.0.0.1:${port}/mcp`;
    server = await startHttp(port, {
      EVOLUTION_BASE_URL: `http://127.0.0.1:${evolution.address().port}`,
      EVOLUTION_MAX_MESSAGE_BYTES: "65536",
      MCP_AUTH_MODE: "none",
      MCP_ALLOW_UNAUTHENTICATED: "true",
      MCP_JSON_RESPONSE: "true",
    });
  });
  after(async () => {
    await stop(server);
    if (evolution) await close(evolution);
  });

  test("requests without a token are answered with plain JSON", async () => {
    const res = await post(url, {}, rpc(1, "tools/list"));
    assert.equal(res.status, 200, res.text);
    assert.match(res.headers.get("content-type"), /^application\/json/);
    assert.deepEqual(toolNames(JSON.parse(res.text).result.tools), defaultTools);
  });

  test("tool results are capped at 150000 bytes when EVOLUTION_MAX_RESULT_BYTES is unset", async () => {
    const instances = Array.from({ length: 3000 }, (_, i) => ({ name: `instance-${i}`, connectionStatus: "open" }));
    const payload = JSON.stringify(instances);
    assert.ok(payload.length > 150000 && payload.length < 4194304, `fixture is ${payload.length} bytes`);
    respond = (_req, res) => res.end(payload);

    const { result } = JSON.parse((await post(url, {}, fetchInstances)).text);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /exceeds EVOLUTION_MAX_RESULT_BYTES=150000\b/);
  });

  test("request bodies are limited by EVOLUTION_MAX_MESSAGE_BYTES", async () => {
    assert.equal((await post(url, {}, sendText("z".repeat(60000)))).status, 200);
    assert.equal((await post(url, {}, sendText("z".repeat(100000)))).status, 413);
  });

  test("SIGTERM lets an in-flight tool call finish, then exits 0", async () => {
    let release;
    const received = new Promise((resolve) => {
      respond = (_req, res) => {
        release = () => res.end(JSON.stringify([{ name: "slow-instance", connectionStatus: "open" }]));
        resolve();
      };
    });
    const inFlight = post(url, {}, fetchInstances);
    await received;
    server.child.kill("SIGTERM");
    await waitForLog(server, /SIGTERM/);
    release();

    const res = await inFlight;
    assert.equal(res.status, 200);
    const { result } = JSON.parse(res.text);
    assert.notEqual(result.isError, true, result.content[0].text);
    assert.match(result.content[0].text, /slow-instance/);
    assert.deepEqual(await server.exited, { code: 0, signal: null });
    assert.equal(server.stdout, "");
  });
});

test("HTTP mode refuses to start without an explicit, safe auth decision", { timeout: 30000 }, async () => {
  const token = randomBytes(32).toString("base64url");
  const issuer = "https://idp.example";
  const cases = [
    ["no auth configured", {}, /MCP_AUTH_TOKEN/],
    ["a 31-character token", { MCP_AUTH_TOKEN: "x".repeat(31) }, /at least 32 characters/],
    ["oauth without MCP_PUBLIC_URL", { MCP_OAUTH_ISSUER: issuer, MCP_OAUTH_ALLOWED_SUBJECTS: "owner-123" }, /MCP_PUBLIC_URL/],
    ["oauth without allowed subjects", { MCP_OAUTH_ISSUER: issuer, MCP_PUBLIC_URL: "https://mcp.example/mcp" }, /MCP_OAUTH_ALLOWED_SUBJECTS/],
    ["none without the explicit opt-in", { MCP_AUTH_MODE: "none" }, /MCP_ALLOW_UNAUTHENTICATED=true/],
    ["an unknown MCP_AUTH_MODE", { MCP_AUTH_MODE: "cloudflare-access" }, /MCP_AUTH_MODE/],
    ["a token and an issuer without MCP_AUTH_MODE", { MCP_AUTH_TOKEN: token, MCP_OAUTH_ISSUER: issuer }, /MCP_AUTH_MODE/],
    ["an invalid MCP_TRANSPORT", { MCP_TRANSPORT: "sse", MCP_AUTH_TOKEN: token }, /MCP_TRANSPORT/],
  ];

  const outcomes = await Promise.all(
    cases.map(async ([, env]) => {
      const proc = spawnEntry({ MCP_TRANSPORT: "http", MCP_HOST: "127.0.0.1", MCP_PORT: String(await freePort()), ...env });
      const ready = waitForLog(proc, /ready \(http\)/).then(() => true, () => false);
      const started = await Promise.race([ready, proc.exited.then(() => false)]);
      if (started) proc.child.kill();
      const { code } = await proc.exited;
      return { started, code, stdout: proc.stdout, stderr: proc.stderr };
    }),
  );

  cases.forEach(([name, , error], i) => {
    const { started, code, stdout, stderr } = outcomes[i];
    assert.equal(started, false, `${name}: started`);
    assert.equal(code, 1, `${name}: exit code`);
    assert.match(stderr, /fatal:/, name);
    assert.match(stderr, error, name);
    assert.equal(stdout, "", name);
  });
});

test("EVOLUTION_MAX_RESULT_BYTES defaults to 150000 in HTTP mode and to 4194304 over stdio", () => {
  assert.equal(loadConfig({ ...evolutionEnv, MCP_TRANSPORT: "http" }).maxResultBytes, 150000);
  assert.equal(loadConfig({ ...evolutionEnv, MCP_TRANSPORT: " HTTP " }).maxResultBytes, 150000);
  assert.equal(loadConfig(evolutionEnv).maxResultBytes, 4194304);
  assert.equal(loadConfig({ ...evolutionEnv, MCP_TRANSPORT: "stdio" }).maxResultBytes, 4194304);
});

test("an explicit EVOLUTION_MAX_RESULT_BYTES still wins in HTTP mode", () => {
  const config = loadConfig({ ...evolutionEnv, MCP_TRANSPORT: "http", EVOLUTION_MAX_RESULT_BYTES: "4194304" });
  assert.equal(config.maxResultBytes, 4194304);
});

test("HTTP settings default to 127.0.0.1:3000/mcp and fall back to PORT when MCP_PORT is unset", async () => {
  const { loadHttpConfig } = await import("../dist/http.js");
  const token = "t".repeat(32); // the shortest accepted token
  const defaults = loadHttpConfig({ MCP_AUTH_TOKEN: token });
  assert.deepEqual([defaults.host, defaults.port, defaults.path, defaults.auth.mode], ["127.0.0.1", 3000, "/mcp", "bearer"]);
  assert.equal(loadHttpConfig({ MCP_AUTH_TOKEN: token, PORT: "8080" }).port, 8080);
  assert.equal(loadHttpConfig({ MCP_AUTH_TOKEN: token, PORT: "8080", MCP_PORT: "3100" }).port, 3100);
});

test("MCP_ALLOWED_HOSTS replaces the hosts derived from MCP_PUBLIC_URL and tolerates ports and schemes", async () => {
  const { loadHttpConfig } = await import("../dist/http.js");
  const env = { MCP_AUTH_TOKEN: "t".repeat(32), MCP_PUBLIC_URL: "https://mcp-evo.example.com/mcp" };
  assert.deepEqual(loadHttpConfig(env).allowedHosts, ["mcp-evo.example.com", "localhost", "127.0.0.1"]);
  const explicit = loadHttpConfig({ ...env, MCP_ALLOWED_HOSTS: "MCP-Evo.Example.Com:443, https://evo.example.com/mcp" });
  assert.deepEqual(explicit.allowedHosts, ["mcp-evo.example.com", "evo.example.com"]);
});

test("HTTP settings that could never work or would weaken auth are rejected at startup", async () => {
  const { loadHttpConfig } = await import("../dist/http.js");
  const token = randomBytes(32).toString("base64url");
  const oauth = { MCP_OAUTH_ISSUER: "https://idp.example", MCP_PUBLIC_URL: "https://mcp.example/mcp", MCP_OAUTH_ALLOWED_SUBJECTS: "owner-123" };
  const cases = [
    ["a short token in the rotation list", { MCP_AUTH_TOKEN: `${token},short` }, /MCP_AUTH_TOKEN values must be at least 32 characters/],
    ["a token with a space, never sent intact", { MCP_AUTH_TOKEN: `${token} ${token}` }, /MCP_AUTH_TOKEN values may only contain/],
    ["a plain-http public URL", { MCP_AUTH_TOKEN: token, MCP_PUBLIC_URL: "http://mcp.example/mcp" }, /MCP_PUBLIC_URL must use https/],
    ["a public URL that is not a URL", { MCP_AUTH_TOKEN: token, MCP_PUBLIC_URL: "mcp.example/mcp" }, /MCP_PUBLIC_URL is not a valid URL/],
    ["a public URL with a query string", { MCP_AUTH_TOKEN: token, MCP_PUBLIC_URL: "https://mcp.example/mcp?key=1" }, /MCP_PUBLIC_URL must not have a query/],
    ["MCP_PATH unlike the public URL path", { MCP_AUTH_TOKEN: token, MCP_PUBLIC_URL: "https://mcp.example/mcp", MCP_PATH: "/other" }, /MCP_PATH \(\/other\) must match/],
    ["an MCP_PATH with route syntax", { MCP_AUTH_TOKEN: token, MCP_PATH: "/mcp/:id" }, /MCP_PATH .*must start with/],
    ["an MCP_PATH without a leading slash", { MCP_AUTH_TOKEN: token, MCP_PATH: "mcp" }, /MCP_PATH .*must start with/],
    ["an invalid MCP_ALLOWED_HOSTS entry", { MCP_AUTH_TOKEN: token, MCP_ALLOWED_HOSTS: "bad host" }, /MCP_ALLOWED_HOSTS has an invalid host/],
    ["an MCP_PORT out of range", { MCP_AUTH_TOKEN: token, MCP_PORT: "70000" }, /MCP_PORT must be an integer between 1 and 65535/],
    ["a plain-http issuer", { ...oauth, MCP_OAUTH_ISSUER: "http://idp.example" }, /MCP_OAUTH_ISSUER must use https/],
    ["a JWKS URL that is not http(s)", { ...oauth, MCP_OAUTH_JWKS_URL: "file:///etc/jwks.json" }, /MCP_OAUTH_JWKS_URL must be an http\(s\) URL/],
    ["a JWKS URL that is not a URL", { ...oauth, MCP_OAUTH_JWKS_URL: "idp.example/jwks" }, /MCP_OAUTH_JWKS_URL must be an http\(s\) URL/],
  ];
  for (const [name, env, error] of cases) {
    assert.throws(() => loadHttpConfig(env), error, name);
  }
  // The checks above reject only what they name: a valid OAuth setup with an internal http JWKS loads.
  assert.equal(loadHttpConfig({ ...oauth, MCP_OAUTH_JWKS_URL: "http://keycloak:8080/certs" }).auth.mode, "oauth");
});

test("a plain-http MCP_OAUTH_JWKS_URL is accepted only for a private host", async () => {
  // The key set decides which signatures are trusted: over plain http to a public host, anyone on
  // the path could serve their own keys.
  const { loadHttpConfig } = await import("../dist/http.js");
  const oauth = { MCP_OAUTH_ISSUER: "https://idp.example", MCP_PUBLIC_URL: "https://mcp.example/mcp", MCP_OAUTH_ALLOWED_SUBJECTS: "owner-123" };
  const jwksUrl = (url) => loadHttpConfig({ ...oauth, MCP_OAUTH_JWKS_URL: url }).auth.jwksUrl.href;
  const accepted = [
    "https://idp.example.com/.well-known/jwks.json",
    "http://keycloak:8080/certs", // single-label name: a Docker or Easypanel service
    "http://localhost:8080/jwks",
    "http://127.0.0.1:8080/jwks",
    "http://127.8.9.10/jwks",
    "http://[::1]:8080/jwks",
    "http://10.0.0.5/jwks",
    "http://172.16.0.1/jwks",
    "http://172.31.255.254/jwks",
    "http://192.168.1.10/jwks",
    "http://[fc00::1]/jwks",
    "http://[fd12:3456::1]/jwks",
    "http://idp.internal/jwks",
    "http://auth.corp.internal/jwks",
    "http://idp.local/jwks",
  ];
  for (const url of accepted) assert.equal(jwksUrl(url), url, url);
  const refused = [
    "http://idp.example.com/.well-known/jwks.json",
    "http://203.0.113.10/jwks",
    "http://11.0.0.1/jwks",
    "http://172.15.255.255/jwks",
    "http://172.32.0.1/jwks",
    "http://192.169.0.1/jwks",
    "http://[2001:db8::1]/jwks",
    "http://idp.internal.example.com/jwks",
    "http://idp.notlocal/jwks",
  ];
  for (const url of refused) assert.throws(() => jwksUrl(url), /MCP_OAUTH_JWKS_URL must use https/, url);
});

test("stdio mode never loads express or jose", { timeout: 10000 }, async (t) => {
  if (typeof nodeModule.registerHooks !== "function") {
    t.skip("module.registerHooks needs Node.js 22.15 or later");
    return;
  }
  // Logs every bare specifier the entry point resolves.
  const hook = `import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!/^(\\.|\\/|node:|file:)/.test(specifier)) process.stderr.write("resolve " + specifier + "\\n");
    return nextResolve(specifier, context);
  },
});`;
  const proc = spawnEntry({}, { args: ["--import", `data:text/javascript,${encodeURIComponent(hook)}`], stdin: "pipe" });
  t.after(() => proc.child.kill());
  await waitForLog(proc, /ready \(stdio\)/);
  proc.child.stdin.end();
  await proc.exited;

  const resolved = [...proc.stderr.matchAll(/^resolve (\S+)$/gm)].map((match) => match[1]);
  assert.ok(resolved.includes("@modelcontextprotocol/sdk/server/stdio.js"), "the hook saw the stdio transport");
  assert.deepEqual(resolved.filter((specifier) => /^(express|jose)(\/|$)/.test(specifier)), []);
});
