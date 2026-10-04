# Hermes Hotline

Talk to Hermes, and through Hermes to Claude Code, Codex and your other agents, on a Fitbit Sense 2. The watch cannot run your own apps, but it can answer phone calls with its speaker and microphone. So Hermes calls your phone through Twilio, you answer on the watch, and you talk.

1. `node call.mjs "why"` asks Twilio to ring your phone. Hermes runs it when you ask for a call, and an agent can run it when it needs you.
2. You answer on the watch. Twilio turns your speech into text and opens a WebSocket to the call server.
3. The call server sends the text to the [Hermes Agent](https://github.com/NousResearch/hermes-agent) API server and streams the answer back. Twilio speaks it through the watch.

| File | What it does |
| --- | --- |
| `setup.mjs`, `onboarding.mjs` | `npm run setup` sets everything up. `npm run doctor` checks it. `npm run update` updates it. The watchdog keeps it running |
| `call.mjs` | Rings your phone |
| `call-server.mjs` | Connects the call to Hermes. Runs on the computer that runs Hermes |
| `hotline.mjs` | Shared code: settings, Twilio requests and signatures, call tokens, the Hermes stream |
| `.env.example` | The settings that setup fills in |
| `hermes-skill/watch-call/` | A Hermes skill, so Hermes calls you when you ask |
| `test/` | The tests: `npm test` |

## Set up

Do steps 1 to 3 once. Then setup does the rest on the computer that runs Hermes. That computer must stay on and awake.

### 1. Answer calls on the watch

1. In the Google Health app, set up calls for the Sense 2. The phone pairs with the watch a second time, for calls.
2. Call your phone from another phone. Answer on the watch to make sure that you hear the caller.

### 2. Prepare Twilio

1. Make an account at [twilio.com](https://www.twilio.com) and upgrade it from the trial. A trial call waits for a key press, and the watch has no keypad.
2. In the Twilio Console, under Voice > Settings, accept the Predictive and Generative AI/ML Features Addendum. Without it, calls cannot reach Hermes.

Setup can buy the phone number that calls you, or use a number that you have.

### 3. Install Tailscale

Install [Tailscale](https://tailscale.com/download) on the computer that runs Hermes, and sign in. Setup uses Tailscale Funnel to give the call server a public HTTPS address. If you use another tunnel, setup asks for its address.

### 4. Run setup

On the computer that runs Hermes, with Node 22:

```sh
git clone https://github.com/vdimarco/hermes-hotline ~/hermes-hotline
cd ~/hermes-hotline
npm ci
npm run setup
```

Setup asks before each change. It:

- turns on the Hermes API server if it is off, and restarts the gateway
- checks your Twilio account, and picks or buys the number that calls you
- makes the call server public with Tailscale Funnel
- saves the settings in `.env` and installs the Hermes skill
- installs a service that starts the call server with the computer, and a watchdog: launchd on a Mac, systemd on Linux, scheduled tasks on Windows
- places a test call to your phone

To change a setting later, run setup again and press Enter to keep the other values.

### 5. Check it

`npm run doctor` checks each part and tells you how to fix what fails. It changes nothing.

## Always on

Setup makes the call server hard to stop:

- The service manager starts the call server with the computer. When the process stops for any reason, such as a crash or `kill -9`, the service manager starts it again within seconds. On Linux, systemd never stops trying.
- A watchdog runs every 5 minutes. If the call server runs but does not answer, the watchdog restarts it. Then it runs the doctor's checks.
- When a check fails on two runs in a row, the watchdog sends you a Telegram message through Hermes's bot. When the problem is gone, it sends one more. It uses `TELEGRAM_BOT_TOKEN` and `TELEGRAM_HOME_CHANNEL` from Hermes's `.env`.

On Linux, run this once too. Then the call server starts at boot before you log in, and keeps running after you log out:

```sh
sudo loginctl enable-linger $USER
```

The calls need Hermes too. If you start the Hermes gateway by hand, run `hermes gateway install` once. It installs a service that restarts the gateway.

| To | Run |
| --- | --- |
| Update to the newest version | `npm run update` |
| Check every part | `npm run doctor` |
| Read the logs on Linux | `journalctl --user -u hermes-hotline -u hermes-hotline-watchdog -f` |
| Stop it on purpose on Linux | `systemctl --user stop hermes-hotline-watchdog.timer hermes-hotline` |
| Start it again on Linux | `systemctl --user start hermes-hotline hermes-hotline-watchdog.timer` |

On a Mac and on Windows, the logs are in `logs/`. To watch the logs in a [herdr](https://herdr.dev) pane, run the log command there. Keep the call server itself under the service manager, because the service manager restarts it when it stops.

### Let an agent call you

Run a line like this next to an agent, so it calls you when it waits for you ([herdr](https://herdr.dev) shown):

```sh
herdr agent wait codex --until blocked && node ~/hermes-hotline/call.mjs "Codex is waiting for your answer."
```

## Use

- Tell Hermes "call me". On Android, you can send it from the watch. In the Google Health app, tap Connections, your Sense 2, Notifications, Quick replies, then Telegram, and change one reply to "Call me". Then pick that reply on any Hermes message. Fitbit's voice replies have a known transcription bug on the Sense 2, but a quick reply is fixed text.
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

Run `npm ci`, then `npm test`. The call tests place a call against a stand-in Twilio API and open call sessions the way Twilio does, against a stand-in Hermes API server. Forged signatures, forged or reused call tokens and messages before setup must never reach Hermes. A client that resets its connection, or sends a message over the size limit, must not stop the server. The setup tests run setup, doctor, the watchdog and update on a pretend Linux, Mac and Windows computer.

Setup has run from start to finish on Linux. The watchdog has run against a real call server, with a stand-in for systemd: it found a frozen server and started a new one. The Mac and Windows service steps have tests, but have not run on a real Mac or Windows computer yet.
