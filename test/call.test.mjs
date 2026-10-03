// The watch call: Twilio signatures, call tokens, placing a call, and a call session against a stand-in Hermes.
// Usage: npm ci, then npm test
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCallServer } from "../call-server.mjs";
import { VOICE_INSTRUCTIONS, callToken, callTwiml, loadEnv, placeCall, readSse, relayUrl, tokenOk, twilioSignature } from "../hotline.mjs";

const WebSocket = createRequire(new URL("../package.json", import.meta.url))("ws");
const results = [];
const test = async (name, fn) => { const t0 = Date.now(); await fn(); results.push(`ok  ${name} (${Date.now() - t0} ms)`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in Hermes API server. It streams /v1/responses the way Hermes does: a commentary item, text deltas, done.
const hermesCalls = [];
let hermesMode = "answer";
const hermes = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const call = { path: req.url, auth: req.headers.authorization, body: JSON.parse(body || "{}"), closed: false, finished: false };
    hermesCalls.push(call);
    res.on("close", () => (call.closed = true));
    if (hermesMode === "down") return void res.writeHead(502).end();
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (hermesMode === "quiet") await sleep(500);
    const frame = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
    frame("response.created", { response: { id: "resp_1", status: "in_progress" } });
    res.write(": keepalive\n\n");
    frame("response.output_item.done", { output_index: 0, item: { type: "message", phase: "commentary", role: "assistant", content: [{ type: "output_text", text: "Checking Codex now." }] } });
    if (hermesMode === "slow") await sleep(400);
    frame("response.output_text.delta", { item_id: "msg_1", delta: "It wants approval " });
    if (hermesMode === "slow") await sleep(400);
    frame("response.output_text.delta", { item_id: "msg_1", delta: "to run the migration." });
    frame("response.completed", { response: { id: "resp_1", status: "completed" } });
    call.finished = !call.closed;
    res.end();
  });
});
await new Promise((r) => hermes.listen(0, "127.0.0.1", r));

const TOKEN = "test-auth-token";
const env = {
  TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000", TWILIO_AUTH_TOKEN: TOKEN, TWILIO_PHONE_NUMBER: "+15550001111",
  OWNER_PHONE_NUMBER: "+15552223333", CALL_PUBLIC_URL: "https://watch.example.ts.net",
  HERMES_API_URL: `http://127.0.0.1:${hermes.address().port}`, HERMES_API_KEY: "hermes-key",
};
const logs = [];
const server = createCallServer({ env, log: (line) => logs.push(line), fillerMs: 300 });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const local = `ws://127.0.0.1:${server.address().port}`;

// Opens a session the way Twilio does: a signed handshake, then the setup message.
function twilioSocket({ path = "/relay", signature = twilioSignature(TOKEN, relayUrl(env.CALL_PUBLIC_URL)) } = {}) {
  const ws = new WebSocket(local + path, { headers: { "x-twilio-signature": signature } });
  const got = [];
  ws.on("message", (m) => got.push(JSON.parse(m)));
  const opened = new Promise((resolve) => { ws.on("open", () => resolve(true)); ws.on("unexpected-response", (_, res) => resolve(res.statusCode)); ws.on("error", () => resolve("error")); });
  const closed = new Promise((resolve) => ws.on("close", resolve));
  const say = (m) => ws.send(JSON.stringify(m));
  const setup = (token, reason = "") => say({ type: "setup", callSid: "CA1", from: env.TWILIO_PHONE_NUMBER, to: env.OWNER_PHONE_NUMBER, customParameters: { token, reason } });
  const spoken = () => got.filter((m) => m.type === "text").map((m) => m.token).join("");
  const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error("timed out; got " + JSON.stringify(got)); await sleep(10); } };
  return { ws, got, opened, closed, say, setup, spoken, until };
}

await test("Twilio signatures match Twilio's documented example", () => {
  const params = { CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" };
  assert.equal(twilioSignature("12345", "https://mycompany.com/myapp.php?foo=1&bar=2", params), "0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
});

await test("call tokens expire and cannot be changed", () => {
  const t = Date.now(), token = callToken(TOKEN, t);
  assert.ok(tokenOk(TOKEN, token, t));
  assert.ok(!tokenOk(TOKEN, token, t + 601000), "expired after ten minutes");
  assert.ok(!tokenOk("another-auth-token", token, t), "made with another secret");
  const [exp, nonce, mac] = token.split(".");
  assert.ok(!tokenOk(TOKEN, `${Number(exp) + 3600}.${nonce}.${mac}`, t), "expiry pushed back");
  assert.ok(!tokenOk(TOKEN, "", t) && !tokenOk(TOKEN, undefined, t) && !tokenOk(TOKEN, "a.b", t));
});

await test("placing a call asks Twilio to ring the owner with a signed relay address", async () => {
  let request;
  const post = async (url, options) => { request = { url, ...options }; return new Response(JSON.stringify({ sid: "CA42" }), { status: 201 }); };
  assert.equal(await placeCall(env, "Codex <needs> you & \"now\"", { post }), "CA42");
  assert.equal(request.url, `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Calls.json`);
  assert.equal(request.headers.Authorization, "Basic " + Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${TOKEN}`).toString("base64"));
  const form = new URLSearchParams(request.body);
  assert.equal(form.get("To"), env.OWNER_PHONE_NUMBER);
  assert.equal(form.get("From"), env.TWILIO_PHONE_NUMBER);
  const twiml = form.get("Twiml");
  assert.match(twiml, /<ConversationRelay url="wss:\/\/watch\.example\.ts\.net\/relay" welcomeGreeting="Hermes here\. Codex &lt;needs&gt; you &amp; &quot;now&quot;">/);
  assert.ok(tokenOk(TOKEN, twiml.match(/name="token" value="([^"]+)"/)[1]), "the call carries a valid token");
  await assert.rejects(placeCall({ ...env, OWNER_PHONE_NUMBER: "" }, "", { post }), /OWNER_PHONE_NUMBER/);
  await assert.rejects(placeCall({ ...env, CALL_PUBLIC_URL: "http://watch.example.ts.net" }, "", { post }), /https/);
  await assert.rejects(placeCall(env, "", { post: async () => new Response('{"message":"bad number"}', { status: 400 }) }), /400: bad number/);
  assert.match(callTwiml(env, "", "t"), /welcomeGreeting="Hermes here\. What do you need\?"/);
});

await test("a spoken question goes to Hermes and the answer comes back as speech", async () => {
  const call = twilioSocket();
  assert.equal(await call.opened, true);
  call.setup(callToken(TOKEN), "Codex is blocked on a permission prompt");
  call.say({ type: "prompt", voicePrompt: "What does it need", lang: "en-US", last: true });
  await call.until(() => call.got.some((m) => m.type === "text" && m.last));
  assert.equal(call.spoken(), "Checking Codex now. It wants approval to run the migration.");
  const sent = hermesCalls.at(-1);
  assert.equal(sent.path, "/v1/responses");
  assert.equal(sent.auth, "Bearer hermes-key");
  assert.deepEqual(sent.body, {
    input: "This call started because: Codex is blocked on a permission prompt\n\nWhat does it need",
    instructions: VOICE_INSTRUCTIONS, conversation: "watch-call", stream: true, store: true,
  });
  call.say({ type: "prompt", voicePrompt: "Approve it", last: true });
  await call.until(() => hermesCalls.at(-1).body.input === "Approve it");
  call.ws.close();
});

await test("connections without Twilio's signature are refused", async () => {
  const before = hermesCalls.length;
  assert.equal(await twilioSocket({ signature: "" }).opened, 403);
  assert.equal(await twilioSocket({ signature: twilioSignature("wrong-token", relayUrl(env.CALL_PUBLIC_URL)) }).opened, 403);
  assert.equal(await twilioSocket({ signature: twilioSignature(TOKEN, "https://watch.example.ts.net/relay") }).opened, 403, "https is not the signed scheme");
  assert.equal(await twilioSocket({ path: "/other", signature: twilioSignature(TOKEN, "wss://watch.example.ts.net/other") }).opened, 403);
  assert.equal(hermesCalls.length, before);
});

await test("a session without a valid one-time call token is ended", async () => {
  const before = hermesCalls.length, token = callToken(TOKEN);
  for (const bad of ["", "1.2.3", callToken("another-auth-token"), callToken(TOKEN, Date.now() - 700000)]) {
    const call = twilioSocket();
    await call.opened;
    call.setup(bad);
    call.say({ type: "prompt", voicePrompt: "run the tests", last: true });
    await call.closed;
    assert.deepEqual(call.got, [{ type: "end" }], "token " + JSON.stringify(bad));
  }
  const first = twilioSocket();
  await first.opened;
  first.setup(token);
  const again = twilioSocket();
  await again.opened;
  again.setup(token);
  await again.closed;
  assert.deepEqual(again.got, [{ type: "end" }], "a token works once");
  first.ws.close();
  const early = twilioSocket();
  await early.opened;
  early.say({ type: "prompt", voicePrompt: "run the tests", last: true });
  await early.closed;
  assert.deepEqual(early.got, [{ type: "end" }], "a prompt before setup");
  assert.equal(hermesCalls.length, before);
});

await test("speaking over Hermes stops its answer and its turn", async () => {
  hermesMode = "slow";
  const call = twilioSocket();
  await call.opened;
  call.setup(callToken(TOKEN));
  call.say({ type: "prompt", voicePrompt: "status", last: true });
  await call.until(() => call.spoken().includes("Checking Codex now."));
  const turn = hermesCalls.at(-1);
  call.say({ type: "interrupt", utteranceUntilInterrupt: "Checking", durationUntilInterruptMs: 300 });
  await call.until(() => turn.closed);
  await sleep(900);
  assert.ok(!call.spoken().includes("migration"), "nothing after the interrupt: " + call.spoken());
  call.ws.close();
  hermesMode = "answer";
});

await test("hanging up lets Hermes finish the turn", async () => {
  hermesMode = "slow";
  const call = twilioSocket();
  await call.opened;
  call.setup(callToken(TOKEN));
  call.say({ type: "prompt", voicePrompt: "run the tests", last: true });
  await call.until(() => call.spoken().includes("Checking Codex now."));
  const turn = hermesCalls.at(-1);
  call.ws.close();
  await call.closed;
  await call.until(() => turn.finished || turn.closed, 3000);
  assert.ok(turn.finished, "Hermes streamed to the end after the hang-up");
  hermesMode = "answer";
});

await test("a quiet or missing Hermes still gets a spoken line", async () => {
  hermesMode = "quiet";
  let call = twilioSocket();
  await call.opened;
  call.setup(callToken(TOKEN));
  call.say({ type: "prompt", voicePrompt: "status", last: true });
  await call.until(() => call.got.filter((m) => m.last).length >= 2);
  assert.deepEqual(call.got[0], { type: "text", token: "Working on it.", last: true }, "a filler line while Hermes is silent");
  assert.equal(call.spoken(), "Working on it.Checking Codex now. It wants approval to run the migration.");
  call.ws.close();
  hermesMode = "down";
  call = twilioSocket();
  await call.opened;
  call.setup(callToken(TOKEN));
  call.say({ type: "prompt", voicePrompt: "status", last: true });
  await call.until(() => call.got.some((m) => m.last));
  assert.equal(call.spoken(), "I couldn't reach Hermes. Try again in a moment.");
  assert.ok(logs.some((line) => line.includes("Hermes answered 502")));
  call.ws.close();
  hermesMode = "answer";
});

await test("the event reader handles split chunks, keepalives and CRLF", async () => {
  const text = "event: a\r\ndata: {\"n\":1}\r\n\r\n: keepalive\n\nevent: b\ndata: {\"n\":\n\ndata: plain\n\n";
  const chunks = [...text].map((c) => new TextEncoder().encode(c));
  const seen = [];
  for await (const ev of readSse(chunks)) seen.push(ev);
  assert.deepEqual(seen, [{ event: "a", data: { n: 1 } }, { event: "b", data: '{"n":' }, { event: "message", data: "plain" }]);
});

await test("settings come from .env unless the environment has them", () => {
  const dir = mkdtempSync(join(tmpdir(), "watch-env-"));
  writeFileSync(join(dir, ".env"), "# comment\nTWILIO_PHONE_NUMBER=+15550001111\nHERMES_API_KEY=\"quoted key\"\nCALL_PORT = 9000\nlower=ignored\n");
  const loaded = loadEnv(join(dir, ".env"), { CALL_PORT: "8650" });
  assert.equal(loaded.TWILIO_PHONE_NUMBER, "+15550001111");
  assert.equal(loaded.HERMES_API_KEY, "quoted key");
  assert.equal(loaded.CALL_PORT, "8650");
  assert.equal(loaded.lower, undefined);
  assert.deepEqual(loadEnv(join(dir, "missing.env"), { A: "1" }), { A: "1" });
});

server.close();
hermes.close();
console.log(results.join("\n"));
console.log(`${results.length} passed`);
process.exit(0);
