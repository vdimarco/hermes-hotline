// The watch call server. Run it on the computer where the Hermes gateway runs, behind an HTTPS tunnel:
//   node call-server.mjs
// When you answer the call on your Fitbit, Twilio opens a WebSocket here. Twilio turns your speech into text,
// this server sends the text to Hermes, and Twilio speaks Hermes's answer back through the watch.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { SERVER_SETTINGS, hermesSpeech, loadEnv, missing, relayBase, relayUrl, sameText, tokenOk, twilioSignature } from "./hotline.mjs";

export function createCallServer({ env, post = fetch, log = console.log, now = Date.now, fillerMs = 6000 } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const spent = new Map(); // call token -> expiry in ms; each token opens one session

  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") return void res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    res.writeHead(404).end();
  });

  // Twilio signs the handshake with the wss:// address from the TwiML, so check that address.
  server.on("upgrade", (req, socket, head) => {
    // Node hands over the raw socket with no error listener. Without one, a client that resets would stop the server.
    socket.on("error", () => {});
    const signed = relayBase(env.CALL_PUBLIC_URL) + req.url;
    const signature = String(req.headers["x-twilio-signature"] || "");
    const pathOk = new URL(req.url, "http://local").pathname === "/relay";
    if (!pathOk || ![signed, signed + "/"].some((url) => sameText(signature, twilioSignature(env.TWILIO_AUTH_TOKEN, url)))) {
      log("call: refused a connection without a valid Twilio signature");
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, session);
  });

  function session(ws) {
    let ready = false, reason = "", first = true, heard = "", turn = null;
    const send = (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
    const hangUp = (why) => { log("call: " + why); send({ type: "end" }); ws.close(); };
    const setupTimer = setTimeout(() => ready || hangUp("no setup message"), 10000);

    async function answer(text) {
      turn?.abort();
      const ctl = new AbortController();
      turn = ctl;
      const input = first && reason ? `This call started because: ${reason}\n\n${text}` : text;
      first = false;
      let spoke = false;
      const filler = setTimeout(() => turn === ctl && !spoke && send({ type: "text", token: "Working on it.", last: true }), fillerMs);
      try {
        for await (const words of hermesSpeech(env, input, { signal: ctl.signal, post })) {
          if (ctl.signal.aborted) return;
          spoke = true;
          send({ type: "text", token: words, last: false });
        }
        if (!ctl.signal.aborted) send({ type: "text", token: spoke ? "" : "Done.", last: true });
      } catch (e) {
        if (ctl.signal.aborted) return;
        log("call: Hermes failed, " + e.message);
        send({ type: "text", token: "I couldn't reach Hermes. Try again in a moment.", last: true });
      } finally {
        clearTimeout(filler);
        if (turn === ctl) turn = null;
      }
    }

    ws.on("message", (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.type === "setup") {
        const token = m.customParameters?.token, t = now();
        for (const [k, exp] of spent) if (exp < t) spent.delete(k);
        if (ready || !tokenOk(env.TWILIO_AUTH_TOKEN, token, t) || spent.has(token)) return hangUp("setup without a valid call token");
        spent.set(token, Number(token.split(".")[0]) * 1000);
        ready = true;
        clearTimeout(setupTimer);
        reason = String(m.customParameters?.reason || "").slice(0, 200);
        log(`call: connected ${m.callSid || ""}`);
        return;
      }
      if (!ready) return hangUp("message before setup");
      if (m.type === "prompt") {
        heard = (heard + " " + String(m.voicePrompt || "")).trim();
        if (m.last === false) return;
        const text = heard;
        heard = "";
        if (text) answer(text);
      } else if (m.type === "interrupt") {
        turn?.abort(); // you spoke over Hermes: stop speaking and stop that turn
        turn = null;
      } else if (m.type === "error") log("call: Twilio error, " + m.description);
    });
    // A bad frame or a message over maxPayload: ws closes this call. Without a listener, it would stop the server.
    ws.on("error", (e) => log("call: connection error, " + e.message));
    // Hanging up does not stop Hermes: the turn finishes and stays in the conversation for the next call.
    ws.on("close", () => clearTimeout(setupTimer));
  }

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = loadEnv();
  const gaps = missing(env, SERVER_SETTINGS);
  if (gaps.length) {
    console.error(`Set ${gaps.join(", ")} in .env`);
    process.exit(1);
  }
  const port = Number(env.CALL_PORT || 8650);
  createCallServer({ env }).listen(port, "127.0.0.1", () =>
    console.log(`Call server on http://127.0.0.1:${port}. Twilio connects to ${relayUrl(env.CALL_PUBLIC_URL)}`));
}
