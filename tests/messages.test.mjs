import assert from "node:assert/strict";
import { test } from "node:test";
import { EvolutionClient, ToolInputError } from "../dist/client.js";
import { messageGroup } from "../dist/tools/message.js";

const client = new EvolutionClient({
  baseUrl: "https://evolution.test",
  apiKey: "test-key",
  defaultInstance: "main",
  timeoutMs: 5000,
});
const group = "120363000000000000@g.us";
const mentions = { mentionsEveryOne: true, mentioned: ["5215512345678@s.whatsapp.net"] };

async function run(name, args) {
  const tool = messageGroup.tools.find((entry) => entry.name === name);
  return tool.handler(client, tool.inputSchema.parse(args));
}

/** Answers every call with 201 and records the path and JSON body of each request. */
function captureFetch(t) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ key: { id: "sent" } }), { status: 201 });
  });
  return requests;
}

function refuseFetch(t) {
  return t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected network call");
  });
}

test("URL documents without fileName send the decoded name of the URL's last path segment", async (t) => {
  const requests = captureFetch(t);
  const media = "https://cdn.example.test/files/Factura%20Mayo.pdf?token=a.b#page=2";
  await run("evolution_message_send_media", { number: "5215512345678", mediatype: "document", media });
  assert.deepEqual(requests, [{
    path: "/message/sendMedia/main",
    body: { number: "5215512345678", mediatype: "document", media, fileName: "Factura Mayo.pdf" },
  }]);
});

test("documents without a fileName that ends in an extension fail before any request", async (t) => {
  const fetch = refuseFetch(t);
  for (const change of [
    { media: "JVBERi0xLjQK" },
    { media: "JVBERi0xLjQK", fileName: "" },
    { media: "https://cdn.example.test/download?file=report.pdf" },
    { media: "https://cdn.example.test/files/" },
    { media: "https://cdn.example.test/files/report.pdf", fileName: "report" },
  ]) {
    await assert.rejects(
      run("evolution_message_send_media", { number: "5215512345678", mediatype: "document", ...change }),
      ToolInputError,
      JSON.stringify(change),
    );
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("a fileName without an extension is rejected for every media type", async (t) => {
  const fetch = refuseFetch(t);
  for (const change of [
    { mediatype: "image", media: "https://cdn.example.test/photo.png", fileName: "photo" },
    { mediatype: "video", media: "AAAAIGZ0eXA=", fileName: "clip" },
    { mediatype: "audio", media: "SUQzBAA=", fileName: "voice", mimetype: "audio/mpeg" },
  ]) {
    await assert.rejects(
      run("evolution_message_send_media", { number: "5215512345678", ...change }),
      ToolInputError,
      JSON.stringify(change),
    );
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("base64 audio needs a mimetype or a fileName with an extension; URL audio does not", async (t) => {
  const requests = captureFetch(t);
  const base = { number: "5215512345678", mediatype: "audio" };
  await assert.rejects(run("evolution_message_send_media", { ...base, media: "SUQzBAA=" }), ToolInputError);
  assert.equal(requests.length, 0);
  await run("evolution_message_send_media", { ...base, media: "SUQzBAA=", mimetype: "audio/mpeg" });
  await run("evolution_message_send_media", { ...base, media: "SUQzBAA=", fileName: "note.mp3" });
  await run("evolution_message_send_media", { ...base, media: "https://cdn.example.test/audio/stream" });
  assert.deepEqual(requests.map((request) => request.body), [
    { ...base, media: "SUQzBAA=", mimetype: "audio/mpeg" },
    { ...base, media: "SUQzBAA=", fileName: "note.mp3" },
    { ...base, media: "https://cdn.example.test/audio/stream" },
  ]);
});

// Evolution API tests fileName for truthiness (2.3.7 prepareMediaMessage, sendMedia controller),
// so "" behaves exactly like an omitted fileName there.
test("an empty fileName counts as omitted and is not sent", async (t) => {
  const requests = captureFetch(t);
  for (const args of [
    { mediatype: "image", media: "https://cdn.example.test/p.png", caption: "hi" },
    { mediatype: "video", media: "AAAAIGZ0eXA=" },
    { mediatype: "audio", media: "SUQzBAA=", mimetype: "audio/mpeg" },
  ]) {
    await run("evolution_message_send_media", { number: "5215512345678", ...args, fileName: "" });
  }
  assert.deepEqual(requests.map((request) => request.body), [
    { number: "5215512345678", mediatype: "image", media: "https://cdn.example.test/p.png", caption: "hi" },
    { number: "5215512345678", mediatype: "video", media: "AAAAIGZ0eXA=" },
    { number: "5215512345678", mediatype: "audio", media: "SUQzBAA=", mimetype: "audio/mpeg" },
  ]);
});

test("a URL document with an empty fileName sends the name taken from the URL", async (t) => {
  const requests = captureFetch(t);
  const media = "https://cdn.example.test/files/report.pdf";
  await run("evolution_message_send_media", { number: "5215512345678", mediatype: "document", media, fileName: "" });
  assert.deepEqual(requests.map((request) => request.body), [
    { number: "5215512345678", mediatype: "document", media, fileName: "report.pdf" },
  ]);
});

test("base64 audio with an empty fileName still needs a mimetype", async (t) => {
  const fetch = refuseFetch(t);
  await assert.rejects(
    run("evolution_message_send_media", { number: "5215512345678", mediatype: "audio", media: "SUQzBAA=", fileName: "" }),
    ToolInputError,
  );
  assert.equal(fetch.mock.callCount(), 0);
});

test("multipart media with an empty fileName sends no fileName field and names the file part 'upload'", async (t) => {
  let form;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    form = init.body;
    return new Response(JSON.stringify({ key: { id: "sent" } }), { status: 201 });
  });
  await run("evolution_message_send_media", {
    number: "5215512345678", mediatype: "image", media: "AQIDBA==", transport: "multipart", fileName: "",
  });
  assert.ok(form instanceof FormData);
  assert.deepEqual([...form.keys()].sort(), ["file", "mediatype", "number"]);
  assert.equal(form.get("file").name, "upload");
});

test("poll, sticker, buttons and carousel accept mention options but never send them", async (t) => {
  const requests = captureFetch(t);
  const reply = [{ type: "reply", displayText: "OK", id: "ok" }];
  await run("evolution_message_send_poll", {
    number: group, name: "Lunch?", selectableCount: 1, values: ["Yes", "No"], delay: 0, ...mentions,
  });
  await run("evolution_message_send_sticker", { number: group, sticker: "https://cdn.example.test/s.webp", ...mentions });
  await run("evolution_message_send_buttons", { number: group, title: "Pick one", buttons: reply, ...mentions });
  await run("evolution_message_send_carousel", {
    number: group, body: "Menu", cards: [{ body: "Card", buttons: reply }], ...mentions,
  });
  assert.deepEqual(requests, [
    {
      path: "/message/sendPoll/main",
      body: { number: group, name: "Lunch?", selectableCount: 1, values: ["Yes", "No"], delay: 0 },
    },
    { path: "/message/sendSticker/main", body: { number: group, sticker: "https://cdn.example.test/s.webp" } },
    { path: "/message/sendButtons/main", body: { number: group, title: "Pick one", buttons: reply } },
    { path: "/message/sendCarousel/main", body: { number: group, body: "Menu", cards: [{ body: "Card", buttons: reply }] } },
  ]);
});

test("list messages still send mentions, which Evolution API 2.3.7 applies", async (t) => {
  const requests = captureFetch(t);
  const sections = [{ title: "Menu", rows: [{ title: "Tacos", rowId: "tacos" }] }];
  await run("evolution_message_send_list", {
    number: group, title: "Order", buttonText: "Open", footerText: "Thanks", sections, ...mentions,
  });
  assert.deepEqual(requests[0].body, {
    number: group, title: "Order", buttonText: "Open", footerText: "Thanks", sections, ...mentions,
  });
});

test("an empty mentioned list is rejected before sending", () => {
  const text = messageGroup.tools.find((entry) => entry.name === "evolution_message_send_text");
  assert.throws(
    () => text.inputSchema.parse({ number: group, text: "Hi all", mentioned: [] }),
    (err) => {
      assert.equal(err.name, "ZodError");
      assert.deepEqual(err.issues.map((issue) => issue.path), [["mentioned"]]);
      return true;
    },
  );
});

test("carousel card titles are accepted but not sent (Evolution never reads them)", async (t) => {
  const requests = captureFetch(t);
  const buttons = [{ type: "url", displayText: "Open", url: "https://shop.example.test" }];
  await run("evolution_message_send_carousel", {
    number: "5215512345678",
    body: "Our picks",
    cards: [
      { title: "Tacos", body: "Three tacos", imageUrl: "https://cdn.example.test/tacos.jpg", buttons },
      { title: "Tortas", body: "One torta", buttons },
    ],
  });
  assert.deepEqual(requests[0].body.cards, [
    { body: "Three tacos", imageUrl: "https://cdn.example.test/tacos.jpg", buttons },
    { body: "One torta", buttons },
  ]);
});

test("contacts without wuid send the digits of phoneNumber as wuid", async (t) => {
  const requests = captureFetch(t);
  await run("evolution_message_send_contact", {
    number: "5215512345678",
    contact: [
      { fullName: "Ana", phoneNumber: "+52 1 55 1234 5678" },
      { fullName: "Luis", phoneNumber: "+52 55 8765 4321", wuid: "5215587654321" },
      { fullName: "Short", phoneNumber: "+1 555-0123" },
    ],
  });
  assert.deepEqual(requests, [{
    path: "/message/sendContact/main",
    body: {
      number: "5215512345678",
      contact: [
        { fullName: "Ana", phoneNumber: "+52 1 55 1234 5678", wuid: "5215512345678" },
        { fullName: "Luis", phoneNumber: "+52 55 8765 4321", wuid: "5215587654321" },
        { fullName: "Short", phoneNumber: "+1 555-0123" },
      ],
    },
  }]);
});
