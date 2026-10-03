# Working in hermes-hotline

- Use Node 22. Run `npm ci` once, then `npm test` before you push. CI runs the same test.
- Keep the call server's checks: Twilio's signature on the `wss://` address, a one-time call token in the setup message, and nothing sent to Hermes before a valid setup. The tests fail if you remove one.
- `call.mjs` calls only `OWNER_PHONE_NUMBER`. Do not add a way to call another number.
- Secrets live in `.env`, which git ignores. Never commit it.
- Write docs in plain, short sentences, the way `README.md` reads.
