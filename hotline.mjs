// Shared parts of the watch call. Twilio rings your phone, you answer on the Fitbit, and you talk to Hermes.
// This file holds the settings, Twilio's request signature, the one-time call token, placing the call,
// and reading the answer that Hermes streams back. Setup: README.md.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export const CALL_SETTINGS = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "OWNER_PHONE_NUMBER", "CALL_PUBLIC_URL"];
export const SERVER_SETTINGS = ["TWILIO_AUTH_TOKEN", "CALL_PUBLIC_URL", "HERMES_API_KEY"];
const TOKEN_TTL_S = 600; // a call can ring and connect within ten minutes of being placed

// Hermes layers this on top of its own system prompt for every turn of a call.
export const VOICE_INSTRUCTIONS = [
  "This turn comes from a phone call. The user hears your answer through the speaker on their watch.",
  "Speak in short, plain sentences. Do not use markdown, lists, code, links or emoji.",
  "Keep each answer under 40 words unless the user asks for detail.",
  "Before a step that takes more than a few seconds, say in one short sentence what you are starting.",
].join(" ");

// Reads KEY=value lines, with or without "export". Comments, blank lines and lower-case names are skipped.
export function parseEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

// Sets KEY=value lines in env-file text. Changes lines in place, adds new ones at the end, keeps the rest.
export function upsertEnv(text, updates) {
  const lines = String(text).split(/\r?\n/);
  while (lines.length && lines.at(-1) === "") lines.pop();
  const left = new Map(Object.entries(updates).filter(([, v]) => v !== undefined));
  const out = lines.map((line) => {
    const m = line.match(/^(\s*(?:export\s+)?)([A-Z][A-Z0-9_]*)\s*=/);
    if (!m || !left.has(m[2])) return line;
    const value = left.get(m[2]);
    left.delete(m[2]);
    return `${m[1]}${m[2]}=${value}`;
  });
  for (const [k, v] of left) out.push(`${k}=${v}`);
  return out.join("\n") + "\n";
}

// Reads .env next to this file. A value already in the environment wins.
export function loadEnv(file = new URL("./.env", import.meta.url), base = process.env) {
  const env = { ...base };
  if (!existsSync(file)) return env;
  for (const [k, v] of Object.entries(parseEnv(readFileSync(file, "utf8")))) if (env[k] === undefined) env[k] = v;
  return env;
}

export const missing = (env, keys) => keys.filter((k) => !env[k]);

export const sameText = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

// X-Twilio-Signature: base64 HMAC-SHA1 of the URL, then each POST parameter name and value in sorted order.
export const twilioSignature = (authToken, url, params = {}) =>
  createHmac("sha1", authToken).update(url + Object.keys(params).sort().map((k) => k + params[k]).join("")).digest("base64");

// The WebSocket address that Twilio opens when you answer. The server checks the signature against it.
export const relayBase = (publicUrl) => String(publicUrl).replace(/^https:/, "wss:").replace(/\/+$/, "");
export const relayUrl = (publicUrl) => relayBase(publicUrl) + "/relay";

// "<expiry seconds>.<nonce>.<mac>": made when the call is placed, accepted once by the server.
export function callToken(secret, now = Date.now()) {
  const body = `${Math.floor(now / 1000) + TOKEN_TTL_S}.${randomBytes(12).toString("base64url")}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

export function tokenOk(secret, token, now = Date.now()) {
  const [exp, nonce, mac] = String(token || "").split(".");
  if (!exp || !nonce || !mac) return false;
  return sameText(mac, createHmac("sha256", secret).update(`${exp}.${nonce}`).digest("base64url")) && Number(exp) * 1000 >= now;
}

const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);

export function callTwiml(env, reason, token) {
  const greeting = reason ? `Hermes here. ${reason}` : "Hermes here. What do you need?";
  return `<Response><Connect><ConversationRelay url="${xml(relayUrl(env.CALL_PUBLIC_URL))}" welcomeGreeting="${xml(greeting)}">` +
    `<Parameter name="token" value="${xml(token)}"/><Parameter name="reason" value="${xml(reason)}"/>` +
    "</ConversationRelay></Connect></Response>";
}

// One request to Twilio's REST API for this account. GET without a form, POST with one.
// TWILIO_API_BASE changes the API address (default https://api.twilio.com).
export async function twilioRequest(env, path, { form, post = fetch } = {}) {
  const base = String(env.TWILIO_API_BASE || "https://api.twilio.com").replace(/\/+$/, "");
  const r = await post(`${base}/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}${path}`, {
    method: form ? "POST" : "GET",
    headers: {
      Authorization: "Basic " + Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64"),
      ...(form && { "Content-Type": "application/x-www-form-urlencoded" }),
    },
    ...(form && { body: new URLSearchParams(form) }),
  });
  const reply = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Twilio answered ${r.status}: ${reply.message || "no details"}`);
  return reply;
}

// Rings OWNER_PHONE_NUMBER from the Twilio number. Returns the Twilio call SID.
export async function placeCall(env, reason = "", { post = fetch, now = Date.now() } = {}) {
  const gaps = missing(env, CALL_SETTINGS);
  if (gaps.length) throw new Error(`Set ${gaps.join(", ")} in .env`);
  if (!/^https:\/\//.test(env.CALL_PUBLIC_URL)) throw new Error("CALL_PUBLIC_URL must start with https://");
  const why = String(reason).replace(/\s+/g, " ").trim().slice(0, 200);
  const reply = await twilioRequest(env, "/Calls.json", {
    post,
    form: {
      To: env.OWNER_PHONE_NUMBER, From: env.TWILIO_PHONE_NUMBER, Timeout: "30",
      Twiml: callTwiml(env, why, callToken(env.TWILIO_AUTH_TOKEN, now)),
    },
  });
  return reply.sid;
}

// Yields { event, data } for each server-sent event. Lines that start with ":" are keepalives.
export async function* readSse(body) {
  const decoder = new TextDecoder();
  let buf = "", event = "", data = [];
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (line === "") {
        if (data.length) {
          const raw = data.join("\n");
          let parsed;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          yield { event: event || "message", data: parsed };
        }
        event = "";
        data = [];
      } else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
  }
}

// Sends one spoken turn to the Hermes API server and yields the words to speak, as they arrive.
// Hermes's progress notes ("commentary") are spoken too, so a long step is not silent.
export async function* hermesSpeech(env, input, { signal, post = fetch } = {}) {
  const base = String(env.HERMES_API_URL || "http://127.0.0.1:8642").replace(/\/+$/, "");
  const r = await post(base + "/v1/responses", {
    method: "POST",
    signal,
    headers: { Authorization: "Bearer " + env.HERMES_API_KEY, "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ input, instructions: VOICE_INSTRUCTIONS, conversation: env.HERMES_CONVERSATION || "watch-call", stream: true, store: true }),
  });
  if (!r.ok || !r.body) throw new Error(`Hermes answered ${r.status}`);
  for await (const { event, data } of readSse(r.body)) {
    if (event === "response.output_text.delta" && data.delta) yield data.delta;
    else if (event === "response.output_item.done" && data.item?.phase === "commentary") {
      const note = (data.item.content || []).map((part) => part.text || "").join("").trim();
      if (note) yield note + " ";
    } else if (event === "response.failed") throw new Error("Hermes failed the turn");
    else if (event === "response.completed") return;
  }
}
