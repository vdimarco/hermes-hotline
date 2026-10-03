// The steps behind `npm run setup` and `npm run doctor`. Each step talks to the person through `io`
// and to the computer through `sys` (files, commands, network), so the tests can run every step
// without a real Hermes, Twilio or Tailscale. setup.mjs supplies the real `io` and `sys`.
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { CALL_SETTINGS, missing, parseEnv, placeCall, relayUrl, twilioRequest, upsertEnv } from "./hotline.mjs";

export const SERVICE_LABEL = "com.hermes-hotline.call-server";
export const SYSTEMD_UNIT = "hermes-hotline.service";
export const WINDOWS_TASK = "Hermes Hotline";
const SKILL_COMMAND = "node ~/hermes-hotline/call.mjs";

export class SetupError extends Error {}

// Where Hermes keeps its settings: HERMES_HOME, else the same default that Hermes uses.
export function hermesHome(sys) {
  if (sys.env.HERMES_HOME) return sys.env.HERMES_HOME;
  if (sys.platform === "win32") return join(sys.env.LOCALAPPDATA || join(sys.home, "AppData", "Local"), "hermes");
  return join(sys.home, ".hermes");
}

export async function hermesState(sys, url, key) {
  try {
    if (!(await sys.fetch(url + "/health", { signal: AbortSignal.timeout(3000) })).ok) return "down";
    const r = await sys.fetch(url + "/v1/models", { headers: { Authorization: "Bearer " + key }, signal: AbortSignal.timeout(5000) });
    if (r.ok) return "ok";
    return r.status === 401 || r.status === 403 ? "bad-key" : "down";
  } catch {
    return "down";
  }
}

async function healthy(sys, url, tries = 1) {
  for (let i = 0; i < tries; i++) {
    if (i) await sys.sleep(2000);
    try {
      const r = await sys.fetch(url, { signal: AbortSignal.timeout(5000) });
      if (r.ok && (await r.json().catch(() => ({}))).ok === true) return true;
    } catch {}
  }
  return false;
}

async function restartHermes({ io, sys }) {
  const hermes = sys.which("hermes");
  if (hermes && (await io.confirm("Restart the Hermes gateway now? Setup runs: hermes gateway restart", true))) {
    if ((await sys.run(hermes, ["gateway", "restart"], { inherit: true })).code === 0) return;
    io.say("  The restart did not work.");
  }
  await io.pause("Restart Hermes yourself, then press Enter.");
}

export async function stepHermes(ctx, saved) {
  const { io, sys } = ctx;
  io.say("\n1. Hermes");
  const home = hermesHome(sys);
  if (!sys.exists(home)) throw new SetupError(`Hermes is not in ${home}. Install Hermes, or set HERMES_HOME to its folder. Then run setup again.`);
  const envFile = join(home, ".env");
  const hermesEnv = parseEnv(sys.read(envFile) || "");
  let url = saved.HERMES_API_URL || `http://127.0.0.1:${hermesEnv.API_SERVER_PORT || "8642"}`;
  let key = hermesEnv.API_SERVER_KEY || saved.HERMES_API_KEY || "";
  if (hermesEnv.API_SERVER_ENABLED !== "true" || key.length < 16) {
    if (!(await io.confirm(`The Hermes API server is off. Turn it on? Setup adds two lines to ${envFile}.`, true)))
      throw new SetupError("The call server talks to Hermes through its API server. Turn it on, then run setup again.");
    if (key.length < 16) key = randomBytes(32).toString("hex"); // Hermes refuses a key shorter than 16 characters
    sys.write(envFile, upsertEnv(sys.read(envFile) || "", { API_SERVER_ENABLED: "true", API_SERVER_KEY: key }), 0o600);
    io.say(`  ✓ Turned on the API server in ${envFile}.`);
    await restartHermes(ctx);
  }
  let state = await hermesState(sys, url, key);
  if (state === "down") {
    io.say(`  Hermes does not answer at ${url}.`);
    await restartHermes(ctx);
    url = (await io.ask("Address of the Hermes API server", url)).replace(/\/+$/, "");
    state = await hermesState(sys, url, key);
  }
  if (state === "bad-key") {
    io.say("  Hermes refused the API key in its .env file. Its config.yaml may set another one.");
    key = await io.secret("Paste the API_SERVER_KEY that Hermes uses (typing is hidden)");
    state = await hermesState(sys, url, key);
  }
  if (state === "down") throw new SetupError(`Hermes does not answer at ${url}. Start Hermes, then run setup again.`);
  if (state === "bad-key") throw new SetupError("Hermes refused the API key. Check API_SERVER_KEY in Hermes, then run setup again.");
  io.say(`  ✓ The Hermes API server answers at ${url}.`);
  return { home, url, key };
}

async function buyNumber({ io, sys }, env) {
  const country = (await io.ask("Country of the new number (two letters)", "US")).toUpperCase();
  const area = await io.ask("Area code (optional)", "");
  const query = new URLSearchParams({ VoiceEnabled: "true", PageSize: "5", ...(area && { AreaCode: area }) });
  const found = await twilioRequest(env, `/AvailablePhoneNumbers/${country}/Local.json?${query}`, { post: sys.fetch });
  const pick = found.available_phone_numbers?.[0];
  if (!pick) throw new SetupError("Twilio has no number like that. Try another area code, or buy one in the Twilio Console.");
  const place = pick.locality || pick.region || country;
  if (!(await io.confirm(`Buy ${pick.phone_number} (${place})? Twilio bills it every month.`, false)))
    throw new SetupError("Setup did not buy a number. Buy one in the Twilio Console, then run setup again.");
  const bought = await twilioRequest(env, "/IncomingPhoneNumbers.json", { post: sys.fetch, form: { PhoneNumber: pick.phone_number } });
  io.say(`  ✓ Bought ${bought.phone_number}.`);
  return bought.phone_number;
}

export async function stepTwilio(ctx, saved) {
  const { io, sys } = ctx;
  io.say("\n2. Twilio");
  io.say("  The Account SID and the auth token are on the Twilio Console home page: https://console.twilio.com");
  const sid = (await io.ask("Account SID", saved.TWILIO_ACCOUNT_SID || "")).trim();
  if (!/^AC[0-9a-fA-F]{32}$/.test(sid)) throw new SetupError("An Account SID starts with AC and has 34 characters.");
  const keep = saved.TWILIO_AUTH_TOKEN && saved.TWILIO_ACCOUNT_SID === sid && (await io.confirm("Keep the saved auth token?", true));
  const token = keep ? saved.TWILIO_AUTH_TOKEN : (await io.secret("Auth token (typing is hidden)")).trim();
  const env = { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_API_BASE: saved.TWILIO_API_BASE };
  let account;
  try {
    account = await twilioRequest(env, ".json", { post: sys.fetch });
  } catch (e) {
    throw new SetupError(/ 401:/.test(e.message) ? "Twilio refused the Account SID or the auth token." : e.message);
  }
  if (account.status !== "active") throw new SetupError(`The Twilio account is ${account.status}. It must be active.`);
  const trial = account.type === "Trial";
  io.say(`  ✓ The Twilio account "${account.friendly_name}" works.`);
  if (trial) io.say("  ! This is a trial account. Before each call, Twilio plays a notice and waits for a key press, and the watch has no keypad. Upgrade the account in the Twilio Console before you use the watch.");

  const numbers = ((await twilioRequest(env, "/IncomingPhoneNumbers.json?PageSize=50", { post: sys.fetch })).incoming_phone_numbers || [])
    .filter((n) => n.capabilities?.voice !== false).map((n) => n.phone_number);
  let from;
  if (!numbers.length) {
    io.say("  This account has no phone number that can call.");
    from = await buyNumber(ctx, env);
  } else {
    io.say("  Your Twilio numbers:");
    numbers.forEach((n, i) => io.say(`    ${i + 1}) ${n}`));
    io.say("    n) Buy a new number");
    const fallback = String(Math.max(numbers.indexOf(saved.TWILIO_PHONE_NUMBER), 0) + 1);
    const choice = (await io.ask("Which number calls you", fallback)).trim().toLowerCase();
    if (choice === "n") from = await buyNumber(ctx, env);
    else {
      from = numbers[Number(choice) - 1];
      if (!from) throw new SetupError(`Type a number from 1 to ${numbers.length}, or n.`);
    }
  }
  io.say("  ! Calls reach Hermes through Twilio ConversationRelay. Accept its Predictive and Generative AI/ML Features Addendum in the Twilio Console, under Voice > Settings.");
  return { ...env, TWILIO_PHONE_NUMBER: from, trial };
}

export async function stepOwner({ io, sys }, saved, twilio) {
  io.say("\n3. Your phone");
  const owner = (await io.ask("Your phone number, the one paired with the watch, for example +15551234567", saved.OWNER_PHONE_NUMBER || ""))
    .replace(/[\s().-]/g, "");
  if (!/^\+[1-9]\d{6,14}$/.test(owner)) throw new SetupError("Write the full number with + and the country code, for example +15551234567.");
  if (owner === twilio.TWILIO_PHONE_NUMBER) throw new SetupError("That is the Twilio number. Write your own phone number.");
  if (twilio.trial) {
    const ids = await twilioRequest(twilio, `/OutgoingCallerIds.json?PhoneNumber=${encodeURIComponent(owner)}`, { post: sys.fetch });
    if (!ids.outgoing_caller_ids?.length)
      io.say(`  ! A trial account calls only verified numbers. Verify ${owner} in the Twilio Console, under Phone Numbers > Verified Caller IDs.`);
  }
  return owner;
}

// Tailscale's CLI is on the PATH on Linux and Windows. The Mac app keeps it inside the app.
export async function tailscale(sys) {
  const bins = [sys.which("tailscale"), sys.platform === "darwin" && "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
  for (const bin of bins) {
    if (!bin || !sys.exists(bin)) continue;
    const r = await sys.run(bin, ["status", "--json"]);
    if (r.code !== 0) continue;
    try {
      const status = JSON.parse(r.stdout);
      const dns = String(status.Self?.DNSName || "").replace(/\.$/, "");
      if (status.BackendState === "Running" && dns) return { bin, dns };
    } catch {}
  }
  return null;
}

export async function stepPublicUrl(ctx, saved, port) {
  const { io, sys } = ctx;
  io.say("\n4. Public address");
  const ts = await tailscale(sys);
  if (ts) {
    io.say(`  Tailscale runs on this computer as ${ts.dns}.`);
    if (await io.confirm(`Make port ${port} public with Tailscale Funnel? Setup runs: tailscale funnel --bg ${port}`, true)) {
      if ((await sys.run(ts.bin, ["funnel", "--bg", String(port)], { inherit: true })).code !== 0)
        throw new SetupError(`Tailscale Funnel did not start. Allow Funnel for this computer in the Tailscale admin console, then run setup again. On Linux, run "sudo tailscale funnel --bg ${port}" if it asks for permission.`);
      io.say(`  ✓ Tailscale Funnel sends https://${ts.dns} to port ${port}.`);
      return `https://${ts.dns}`;
    }
  } else {
    io.say("  Tailscale does not run on this computer. Install it from https://tailscale.com/download, sign in, and run setup again. To use another tunnel, type its address.");
  }
  const url = (await io.ask("Public HTTPS address of the call server", saved.CALL_PUBLIC_URL || "")).trim().replace(/\/+$/, "");
  if (!/^https:\/\/[^/\s]+$/.test(url)) throw new SetupError("Use an https:// address with no path.");
  return url;
}

export function saveSettings({ io, sys }, settings) {
  const file = join(sys.repoDir, ".env");
  const current = sys.read(file) ?? sys.read(join(sys.repoDir, ".env.example")) ?? "";
  sys.write(file, upsertEnv(current, settings), 0o600);
  io.say(`  ✓ Saved the settings in ${file}.`);
}

export function skillText(template, callPath) {
  return template.replace(SKILL_COMMAND, `node "${callPath}"`).replace(" Change the path if the repository is somewhere else.", "");
}

export function installSkill({ io, sys }, home) {
  const template = sys.read(join(sys.repoDir, "hermes-skill", "watch-call", "SKILL.md"));
  const dest = join(home, "skills", "watch-call", "SKILL.md");
  sys.mkdir(dirname(dest));
  sys.write(dest, skillText(template, join(sys.repoDir, "call.mjs")));
  io.say(`  ✓ Installed the Hermes skill in ${dest}. Tell Hermes "call me" to use it.`);
}

const xml = (s) => String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);

// The files to write and the commands to run so the call server starts with the computer.
export function servicePlan(sys) {
  const server = join(sys.repoDir, "call-server.mjs"), logDir = join(sys.repoDir, "logs"), log = join(logDir, "call-server.log");
  if (sys.platform === "darwin") {
    const plist = join(sys.home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
    const text = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(sys.nodePath)}</string><string>${xml(server)}</string></array>
  <key>WorkingDirectory</key><string>${xml(sys.repoDir)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
    return {
      name: "a launchd agent", logs: log, dirs: [logDir], files: [{ path: plist, text }],
      commands: [
        { cmd: "launchctl", args: ["bootout", `gui/${sys.uid}/${SERVICE_LABEL}`], optional: true },
        { cmd: "launchctl", args: ["bootstrap", `gui/${sys.uid}`, plist] },
      ],
    };
  }
  if (sys.platform === "linux") {
    const unit = join(sys.home, ".config", "systemd", "user", SYSTEMD_UNIT);
    const text = `[Unit]
Description=Hermes Hotline call server
After=network-online.target

[Service]
ExecStart="${sys.nodePath}" "${server}"
WorkingDirectory=${sys.repoDir}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
    return {
      name: "a systemd user service", logs: `journalctl --user -u ${SYSTEMD_UNIT}`, dirs: [], files: [{ path: unit, text }],
      commands: [
        { cmd: "systemctl", args: ["--user", "daemon-reload"] },
        { cmd: "systemctl", args: ["--user", "enable", SYSTEMD_UNIT] },
        { cmd: "systemctl", args: ["--user", "restart", SYSTEMD_UNIT] },
        { cmd: "loginctl", args: ["enable-linger", sys.user], optional: true,
          note: `To keep the call server running after you log out, run: sudo loginctl enable-linger ${sys.user}` },
      ],
    };
  }
  if (sys.platform === "win32") {
    const launcher = join(logDir, "start-call-server.cmd");
    const text = `@echo off\r\ncd /d "${sys.repoDir}"\r\n"${sys.nodePath}" "${server}" >> "${log}" 2>&1\r\n`;
    return {
      name: "a Windows scheduled task", logs: log, dirs: [logDir], files: [{ path: launcher, text }],
      commands: [
        { cmd: "schtasks", args: ["/Create", "/TN", WINDOWS_TASK, "/TR", `"${launcher}"`, "/SC", "ONLOGON", "/F"] },
        { cmd: "schtasks", args: ["/End", "/TN", WINDOWS_TASK], optional: true },
        { cmd: "schtasks", args: ["/Run", "/TN", WINDOWS_TASK] },
      ],
    };
  }
  return null;
}

// Returns true when the call server runs and Twilio can reach it.
export async function stepService(ctx, settings) {
  const { io, sys } = ctx;
  io.say("\n6. Call server");
  const plan = servicePlan(sys);
  if (!plan) {
    io.say("  Setup cannot install a service on this system. Run npm start and keep it running.");
    return false;
  }
  if (!(await io.confirm(`Start the call server now, and each time this computer starts? Setup installs ${plan.name}.`, true))) {
    io.say("  Start the call server with: npm start");
    return false;
  }
  for (const dir of plan.dirs) sys.mkdir(dir);
  for (const file of plan.files) {
    sys.mkdir(dirname(file.path));
    sys.write(file.path, file.text);
  }
  for (const step of plan.commands) {
    const r = await sys.run(step.cmd, step.args);
    if (r.code === 0) continue;
    if (!step.optional) throw new SetupError(`"${step.cmd} ${step.args.join(" ")}" failed: ${(r.stderr || r.stdout || "").trim()}`);
    if (step.note) io.say("  ! " + step.note);
  }
  io.say(`  ✓ Installed ${plan.name}. Logs: ${plan.logs}`);
  const local = `http://127.0.0.1:${settings.CALL_PORT}/health`;
  if (!(await healthy(sys, local, 15))) throw new SetupError(`The call server does not answer at ${local}. Read the logs: ${plan.logs}`);
  io.say("  ✓ The call server runs.");
  if (!(await healthy(sys, `${settings.CALL_PUBLIC_URL}/health`, 30)))
    throw new SetupError(`The call server does not answer at ${settings.CALL_PUBLIC_URL}/health. Check the tunnel, then run: npm run doctor`);
  io.say(`  ✓ Twilio can reach the call server at ${relayUrl(settings.CALL_PUBLIC_URL)}.`);
  return true;
}

export async function stepTestCall({ io, sys }, settings) {
  io.say("\n7. Test call");
  if (!(await io.confirm(`Call ${settings.OWNER_PHONE_NUMBER} now? Answer on the watch.`, true))) return;
  await placeCall(settings, "This is your test call. Ask me what your agents are doing.", { post: sys.fetch });
  io.say("  ✓ Calling. Answer on the watch.");
}

export async function runSetup(ctx) {
  const { io, sys } = ctx;
  io.say("Hermes Hotline setup. Press Enter to keep a value in [brackets].");
  const saved = parseEnv(sys.read(join(sys.repoDir, ".env")) || "");
  const hermes = await stepHermes(ctx, saved);
  const twilio = await stepTwilio(ctx, saved);
  const owner = await stepOwner(ctx, saved, twilio);
  const port = saved.CALL_PORT || "8650";
  const publicUrl = await stepPublicUrl(ctx, saved, port);
  const settings = {
    TWILIO_ACCOUNT_SID: twilio.TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN: twilio.TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER: twilio.TWILIO_PHONE_NUMBER,
    TWILIO_API_BASE: twilio.TWILIO_API_BASE, OWNER_PHONE_NUMBER: owner, CALL_PUBLIC_URL: publicUrl, CALL_PORT: port,
    HERMES_API_KEY: hermes.key, HERMES_API_URL: hermes.url, HERMES_CONVERSATION: saved.HERMES_CONVERSATION || "watch-call",
  };
  io.say("\n5. Settings");
  saveSettings(ctx, settings);
  installSkill(ctx, hermes.home);
  if (await stepService(ctx, settings)) await stepTestCall(ctx, settings);
  io.say('\nDone. Tell Hermes "call me" when you want to talk. If something stops working, run: npm run doctor');
}

// `npm run doctor`: checks every part and says how to fix what fails. Changes nothing.
export async function runChecks({ io, sys }) {
  const s = parseEnv(sys.read(join(sys.repoDir, ".env")) || "");
  let allOk = true;
  const check = async (name, fn) => {
    try {
      const note = await fn();
      io.say(`✓ ${name}${note ? ": " + note : ""}`);
    } catch (e) {
      allOk = false;
      io.say(`✗ ${name}: ${e.message}`);
    }
  };
  await check("Settings", () => {
    const gaps = missing(s, [...CALL_SETTINGS, "HERMES_API_KEY"]);
    if (gaps.length) throw new Error(`${gaps.join(", ")} missing from .env. Run: npm run setup`);
  });
  const url = s.HERMES_API_URL || "http://127.0.0.1:8642";
  await check("Hermes API server", async () => {
    const state = await hermesState(sys, url, s.HERMES_API_KEY || "");
    if (state === "down") throw new Error(`no answer at ${url}. Start Hermes.`);
    if (state === "bad-key") throw new Error("Hermes refused HERMES_API_KEY. Run: npm run setup");
  });
  await check("Twilio account", async () => {
    const account = await twilioRequest(s, ".json", { post: sys.fetch });
    if (account.status !== "active") throw new Error(`the account is ${account.status}`);
    if (account.type === "Trial") return "trial. Upgrade it before you use the watch: a trial call waits for a key press";
  });
  await check("Twilio number", async () => {
    const list = await twilioRequest(s, `/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(s.TWILIO_PHONE_NUMBER || "")}`, { post: sys.fetch });
    if (!list.incoming_phone_numbers?.length) throw new Error(`${s.TWILIO_PHONE_NUMBER} is not on this Twilio account. Run: npm run setup`);
  });
  const local = `http://127.0.0.1:${s.CALL_PORT || "8650"}/health`;
  let serverUp = false;
  await check("Call server", async () => {
    if (!(await healthy(sys, local))) throw new Error(`no answer at ${local}. Run: npm run setup, or npm start`);
    serverUp = true;
  });
  await check("Public address", async () => {
    if (!serverUp) throw new Error("not checked, because the call server does not run");
    if (!(await healthy(sys, `${s.CALL_PUBLIC_URL}/health`))) throw new Error(`no answer at ${s.CALL_PUBLIC_URL}/health. Check the tunnel.`);
  });
  await check("Hermes skill", () => {
    if (!sys.exists(join(hermesHome(sys), "skills", "watch-call", "SKILL.md"))) throw new Error("not installed. Run: npm run setup");
  });
  return allOk;
}
