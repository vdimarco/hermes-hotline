# Hermes Hotline

Talk to Hermes, and through Hermes to Claude Code, Codex and your other agents, on a Fitbit Sense 2. The watch cannot run your own apps, but it can answer phone calls with its speaker and microphone. So Hermes calls your phone through Twilio, you answer on the watch, and you talk.

1. `node call.mjs "why"` asks Twilio to ring your phone. Hermes runs it when you ask for a call, and an agent can run it when it needs you.
2. You answer on the watch. Twilio turns your speech into text and opens a WebSocket to the call server.
3. The call server sends the text to the [Hermes Agent](https://github.com/NousResearch/hermes-agent) API server and streams the answer back. Twilio speaks it through the watch.

| File | What it does |
| --- | --- |
| `call.mjs` | Rings your phone |
| `call-server.mjs` | Connects the call to Hermes. Runs on the computer that runs Hermes |
| `hotline.mjs` | Shared code: settings, Twilio signatures, call tokens, the Hermes stream |
| `.env.example` | The settings. Copy it to `.env` |
| `hermes-skill/watch-call/` | A Hermes skill, so Hermes calls you when you ask |
| `test/call.test.mjs` | The tests: `npm test` |

## Set up

You need a Twilio account with a phone number that can make calls, and a Hermes gateway on a computer that stays on. Use Node 22.

### 1. Answer calls on the watch

1. In the Google Health app, set up calls for the Sense 2. The phone pairs with the watch a second time, for calls.
2. Call your phone from another phone. Answer on the watch to make sure that you hear the caller.

### 2. Turn on the Hermes API server

1. Run `openssl rand -hex 32` and keep the result.
2. Add these lines to `~/.hermes/.env`:

   ```sh
   API_SERVER_ENABLED=true
   API_SERVER_KEY=the-result-from-step-1
   ```

3. Run `hermes gateway restart`. Hermes refuses a key shorter than 16 characters.

### 3. Start the call server

Do these steps on the computer that runs Hermes.

1. Clone this repository to `~/hermes-hotline` and run `npm ci` in it.
2. Copy `.env.example` to `.env` and fill it in. `HERMES_API_KEY` is the key from step 2.
3. Give the call server a public HTTPS address. With Tailscale, run `tailscale funnel --bg 8650`. Put the address it shows in `CALL_PUBLIC_URL`.
4. Run `npm start`. Keep it running, for example as a service.

### 4. Test a call

1. Run `node call.mjs "This is a test call."`.
2. The watch rings within a few seconds. Answer it.
3. Say "What are my agents doing?". Hermes answers through the watch.

If the call does not connect, read the call server's output. Lines start with `call:`. A Twilio trial account calls only numbers that you verified in Twilio.

### 5. Let Hermes call you

1. Copy `hermes-skill/watch-call` to `~/.hermes/skills/watch-call`.
2. If you cloned the repository somewhere other than `~/hermes-hotline`, change the path in the skill's `SKILL.md`.
3. Tell Hermes "call me" in Telegram. On Android, you can say it from the watch: reply by voice to any Hermes message.

To have an agent call you when it waits for you, run a line like this next to it ([herdr](https://herdr.dev) shown):

```sh
herdr agent wait codex --until blocked && node ~/hermes-hotline/call.mjs "Codex is waiting for your answer."
```

## Use

- Save the Twilio number as a contact named Hermes. Then the watch shows who is calling.
- Talk normally. To stop a long answer, start to speak. Hermes stops and listens.
- Hang up when you are done. If Hermes is in the middle of a step, it finishes. Ask about the result on the next call.
- Every call continues one Hermes conversation, `watch-call`. To start a new one, change `HERMES_CONVERSATION`.

## How it works

`call.mjs` posts to Twilio's Calls API with inline TwiML, so Twilio needs no webhook. The TwiML connects the answered call to `<ConversationRelay url="wss://<your host>/relay">`. It passes the reason for the call and a one-time call token: `<expiry>.<nonce>.<HMAC-SHA256>`, keyed with the Twilio auth token and valid for 10 minutes.

Twilio does the speech to text and the text to speech, so the call server handles text only.

- It accepts the WebSocket only with a valid `X-Twilio-Signature`. That is the base64 HMAC-SHA1, keyed with the auth token, of the `wss://` address from the TwiML.
- It accepts the session only when the setup message carries a valid call token that it has not seen before. Any other message before that ends the session.
- It sends each sentence to Hermes `POST /v1/responses` with streaming on, in one named conversation, with short voice instructions that Hermes adds to its own system prompt. The first sentence of a call also carries the reason for the call.
- It forwards Hermes's answer and its progress notes as text for Twilio to speak. After 6 silent seconds it says "Working on it."
- When you speak over Hermes, Twilio sends an interrupt and the server stops that turn. A hang-up does not stop the turn. Hermes finishes it and keeps the result in the conversation.

The call server listens on 127.0.0.1 and is reached only through your tunnel. The Hermes API server stays on 127.0.0.1.

## Security and limits

- `call.mjs` calls only `OWNER_PHONE_NUMBER`.
- Anyone who answers your phone can talk to Hermes, with all of its tools.
- Twilio charges for each minute of a call, and for the speech service.
- People near you hear Hermes through the watch speaker.
- The Sense 2 has no dialer. A call can start only from Hermes, an agent or a command.

## Develop

Run `npm ci`, then `npm test`. The tests place a call against a stand-in Twilio API and open call sessions the way Twilio does, against a stand-in Hermes API server. Forged signatures, forged or reused call tokens and messages before setup must never reach Hermes.
