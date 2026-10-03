---
name: watch-call
description: Ring the user's phone so they can talk to you through their Fitbit watch. Use when the user asks you to call them, or when work waits on their answer and they asked to be called for that.
version: 1.0.0
platforms: [linux, macos]
---

# Watch call

The user wears a Fitbit Sense 2. The watch cannot run apps, but it can answer phone calls. This skill rings their phone. They answer on the watch and talk to you. Their speech reaches you as text through your API server, and Twilio speaks your answer through the watch.

## Place the call

Run this with the terminal tool. Change the path if the repository is somewhere else.

```bash
node ~/hermes-hotline/call.mjs "One short sentence that says why you are calling."
```

The phone rings within a few seconds. The user first hears "Hermes here." and then your sentence.

## Rules

- Call only when the user asks for a call, or when they asked to be called for this kind of event.
- Call once for each reason.
- The script calls only the phone number in `.env`. Do not try to call another number.
- If the script prints an error, tell the user the error in one sentence.
