// Rings your phone so you can talk to Hermes on your Fitbit. The call server must be running.
// Usage: node call.mjs "one sentence: why you are calling"
import { loadEnv, placeCall } from "./hotline.mjs";

try {
  const sid = await placeCall(loadEnv(), process.argv.slice(2).join(" "));
  console.log(`Calling your phone. Twilio call ${sid}`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
