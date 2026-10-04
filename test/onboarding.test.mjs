// The guided setup and the doctor, run against a pretend computer: files in memory, recorded commands,
// and stand-ins for Hermes, Twilio, Tailscale and the call server. Usage: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseEnv, upsertEnv } from "../hotline.mjs";
import {
  SetupError, hermesHome, refreshService, runChecks, runSetup, runWatchdog, servicePlan, skillText, tailscale, telegramChat,
} from "../onboarding.mjs";

const results = [];
const test = async (name, fn) => { const t0 = Date.now(); await fn(); results.push(`ok  ${name} (${Date.now() - t0} ms)`); };
const repoFile = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

const SID = "AC" + "0123456789abcdef".repeat(2), TOKEN = "twilio-auth-token", REPO = "/home/me/hermes-hotline";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// A pretend computer. `world` holds what the stand-in services know and do.
function fakeSys({ platform = "linux", files = {}, paths = [], which = {}, world = {}, home = "/home/me" } = {}) {
  const fs = new Map(Object.entries(files)), modes = new Map(), dirs = new Set(paths), commands = [], requests = [], telegram = [];
  const w = { hermesUp: true, hermesKey: null, account: { status: "active", type: "Full", friendly_name: "Desk" },
    numbers: ["+15550001111"], available: ["+14155550123"], verified: true, serverUp: true, publicUp: true,
    enabled: true, timerActive: true, linger: true, telegramUp: true, ...world };
  const run = async (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    commands.push(line);
    if (w.fail?.(line)) return { code: 1, stdout: "", stderr: "it broke" };
    if (/tailscale status --json$/i.test(line)) return w.tailscale ? { code: 0, stdout: JSON.stringify(w.tailscale) } : { code: 1, stdout: "" };
    if (line.endsWith("gateway restart")) w.hermesUp = true;
    if (line === "systemctl --user restart hermes-hotline.service") w.serverUp = true;
    if (line.includes(" is-enabled ")) return w.enabled ? { code: 0, stdout: "enabled\n" } : { code: 1, stdout: "disabled\n" };
    if (line.includes(" is-active ")) return w.timerActive ? { code: 0, stdout: "active\n" } : { code: 3, stdout: "inactive\n" };
    if (line.includes("--property=Linger")) return { code: 0, stdout: `Linger=${w.linger ? "yes" : "no"}\n` };
    return { code: 0, stdout: "", stderr: "" };
  };
  const fetch = async (url, options = {}) => {
    requests.push({ url, ...options, form: typeof options.body === "string" ? null : options.body ? Object.fromEntries(new URLSearchParams(options.body)) : null });
    if (url.startsWith("https://api.telegram.org/")) {
      if (!w.telegramUp) throw new Error("getaddrinfo ENOTFOUND api.telegram.org");
      telegram.push({ url, ...JSON.parse(options.body) });
      return json({ ok: true });
    }
    if (url.startsWith("http://127.0.0.1:8642/")) {
      if (!w.hermesUp) throw new Error("connect ECONNREFUSED");
      if (url.endsWith("/health")) return json({ status: "ok", platform: "hermes-agent" });
      return options.headers?.Authorization === `Bearer ${w.hermesKey}` ? json({ data: [] }) : json({ error: "unauthorized" }, 401);
    }
    if (url === "http://127.0.0.1:8650/health") return w.serverUp ? json({ ok: true }) : json({}, 502);
    if (url.endsWith("/health")) return w.publicUp ? json({ ok: true }) : json({}, 502);
    const path = url.replace(`https://api.twilio.com/2010-04-01/Accounts/${SID}`, "");
    if (options.headers?.Authorization !== "Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64")) return json({ message: "Authenticate" }, 401);
    if (path === ".json") return json(w.account);
    if (path.startsWith("/IncomingPhoneNumbers.json") && options.method === "POST") {
      w.numbers.push(options.body.get("PhoneNumber"));
      return json({ phone_number: options.body.get("PhoneNumber") }, 201);
    }
    if (path.startsWith("/IncomingPhoneNumbers.json")) {
      const only = new URL(url).searchParams.get("PhoneNumber");
      return json({ incoming_phone_numbers: w.numbers.filter((n) => !only || n === only).map((n) => ({ phone_number: n, capabilities: { voice: true } })) });
    }
    if (path.startsWith("/AvailablePhoneNumbers/")) return json({ available_phone_numbers: w.available.map((n) => ({ phone_number: n, locality: "San Francisco" })) });
    if (path.startsWith("/OutgoingCallerIds.json")) return json({ outgoing_caller_ids: w.verified ? [{ phone_number: "x" }] : [] });
    if (path === "/Calls.json") return json({ sid: "CA42" }, 201);
    return json({ message: "not found" }, 404);
  };
  return {
    platform, home, repoDir: REPO, nodePath: "/usr/bin/node", env: {}, uid: 501, user: "me",
    files: fs, modes, commands, requests, telegram, world: w,
    which: (cmd) => which[cmd] ?? null,
    exists: (p) => fs.has(p) || dirs.has(p),
    read: (p) => fs.get(p) ?? null,
    write: (p, text, mode) => { fs.set(p, text); modes.set(p, mode); },
    mkdir: (p) => dirs.add(p),
    sleep: async () => {},
    run, fetch,
  };
}

// Answers questions in order. Each answer is [part of the question, answer]; undefined means "press Enter".
function scriptedIo(answers) {
  const said = [], left = [...answers];
  const take = (q) => {
    const i = left.findIndex(([part]) => q.includes(part));
    if (i < 0) throw new Error("unexpected question: " + q);
    return left.splice(i, 1)[0][1];
  };
  return {
    said, left,
    text: () => said.join("\n"),
    say: (t) => said.push(t),
    ask: async (q, fallback) => { const a = take(q); return a === undefined || a === "" ? fallback : a; },
    secret: async (q) => take(q),
    confirm: async (q, yesDefault) => { const a = take(q); return a === undefined ? yesDefault : a; },
    pause: async (t) => said.push(t),
  };
}

const repoFiles = () => ({
  [`${REPO}/.env.example`]: repoFile(".env.example"),
  [`${REPO}/hermes-skill/watch-call/SKILL.md`]: repoFile("hermes-skill/watch-call/SKILL.md"),
});

await test("env files: values change in place, new ones go at the end, comments stay", () => {
  const text = "# Twilio\nTWILIO_AUTH_TOKEN=\n\nCALL_PORT=8650\n";
  assert.equal(upsertEnv(text, { TWILIO_AUTH_TOKEN: "abc", NEW_KEY: "1", SKIPPED: undefined }), "# Twilio\nTWILIO_AUTH_TOKEN=abc\n\nCALL_PORT=8650\nNEW_KEY=1\n");
  assert.equal(upsertEnv("", { A: "1" }), "A=1\n");
  assert.deepEqual(parseEnv("# x\nA=1\nB = 'two words'\nlower=no\nexport C=3\n"), { A: "1", B: "two words", C: "3" });
  assert.equal(upsertEnv("export API_SERVER_KEY=old\n", { API_SERVER_KEY: "new" }), "export API_SERVER_KEY=new\n", "no second copy of an exported key");
});

await test("Hermes's folder follows HERMES_HOME, then each system's default", () => {
  assert.equal(hermesHome({ env: { HERMES_HOME: "/srv/hermes" }, platform: "linux", home: "/home/me" }), "/srv/hermes");
  assert.equal(hermesHome({ env: {}, platform: "linux", home: "/home/me" }), "/home/me/.hermes");
  assert.equal(hermesHome({ env: {}, platform: "darwin", home: "/Users/me" }), "/Users/me/.hermes");
  assert.equal(hermesHome({ env: { LOCALAPPDATA: "C:/Users/me/AppData/Local" }, platform: "win32", home: "C:/Users/me" }), "C:/Users/me/AppData/Local/hermes");
});

await test("Tailscale counts only when it runs and has a name", async () => {
  const sys = fakeSys({ which: { tailscale: "/usr/bin/tailscale" }, paths: ["/usr/bin/tailscale"],
    world: { tailscale: { BackendState: "Running", Self: { DNSName: "desk.tail1234.ts.net." } } } });
  assert.deepEqual(await tailscale(sys), { bin: "/usr/bin/tailscale", dns: "desk.tail1234.ts.net" });
  sys.world.tailscale = { BackendState: "Stopped", Self: { DNSName: "desk.tail1234.ts.net." } };
  assert.equal(await tailscale(sys), null);
  const mac = fakeSys({ platform: "darwin", paths: ["/Applications/Tailscale.app/Contents/MacOS/Tailscale"],
    world: { tailscale: { BackendState: "Running", Self: { DNSName: "mac.tail1234.ts.net." } } } });
  assert.equal((await tailscale(mac)).bin, "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "the Mac app's own CLI");
});

await test("each system gets a service that restarts the call server, and a watchdog", () => {
  const line = (c) => [c.cmd, ...c.args].join(" ");
  const linux = servicePlan(fakeSys());
  assert.match(linux.files[0].path, /\.config\/systemd\/user\/hermes-hotline\.service$/);
  assert.match(linux.files[0].text, /ExecStart="\/usr\/bin\/node" "\/home\/me\/hermes-hotline\/call-server\.mjs"\nWorkingDirectory=\/home\/me\/hermes-hotline\nRestart=always/);
  assert.match(linux.files[0].text, /\[Unit\][^[]*\nStartLimitIntervalSec=0\n/, "systemd never stops restarting it");
  assert.match(linux.files[1].path, /\.config\/systemd\/user\/hermes-hotline-watchdog\.service$/);
  assert.match(linux.files[1].text, /Type=oneshot\nExecStart="\/usr\/bin\/node" "\/home\/me\/hermes-hotline\/setup\.mjs" --watchdog\n/);
  assert.match(linux.files[2].path, /hermes-hotline-watchdog\.timer$/);
  assert.match(linux.files[2].text, /OnUnitActiveSec=5min\n[^]*WantedBy=timers\.target/);
  assert.deepEqual(linux.commands.map(line), [
    "systemctl --user daemon-reload", "systemctl --user enable hermes-hotline.service", "systemctl --user restart hermes-hotline.service",
    "systemctl --user enable --now hermes-hotline-watchdog.timer", "loginctl enable-linger me"]);
  assert.deepEqual(linux.restart.map(line), ["systemctl --user restart hermes-hotline.service"]);
  assert.deepEqual(linux.checks.map(line), [
    "systemctl --user is-enabled hermes-hotline.service", "systemctl --user is-active hermes-hotline-watchdog.timer", "loginctl show-user me --property=Linger"]);

  const mac = servicePlan(fakeSys({ platform: "darwin", home: "/Users/me" }));
  assert.equal(mac.files[0].path, "/Users/me/Library/LaunchAgents/com.hermes-hotline.call-server.plist");
  assert.match(mac.files[0].text, /<array><string>\/usr\/bin\/node<\/string><string>\/home\/me\/hermes-hotline\/call-server\.mjs<\/string><\/array>/);
  assert.match(mac.files[0].text, /<key>KeepAlive<\/key><true\/>/);
  assert.equal(mac.files[1].path, "/Users/me/Library/LaunchAgents/com.hermes-hotline.watchdog.plist");
  assert.match(mac.files[1].text, /<string>\/home\/me\/hermes-hotline\/setup\.mjs<\/string><string>--watchdog<\/string><\/array>/);
  assert.match(mac.files[1].text, /<key>StartInterval<\/key><integer>300<\/integer>/);
  assert.doesNotMatch(mac.files[1].text, /KeepAlive/, "the watchdog runs and ends");
  assert.deepEqual(mac.commands.map(line), [
    "launchctl bootout gui/501/com.hermes-hotline.call-server", `launchctl bootstrap gui/501 ${mac.files[0].path}`,
    "launchctl bootout gui/501/com.hermes-hotline.watchdog", `launchctl bootstrap gui/501 ${mac.files[1].path}`]);
  assert.deepEqual(mac.restart.map(line), ["launchctl kickstart -k gui/501/com.hermes-hotline.call-server"]);

  const win = servicePlan(fakeSys({ platform: "win32" }));
  assert.match(win.files[0].text, /^@echo off\r\ncd \/d ".*hermes-hotline"\r\n:start\r\n"\/usr\/bin\/node" ".*call-server\.mjs" >> ".*call-server\.log" 2>&1\r\nping -n 6 127\.0\.0\.1 >nul\r\ngoto start\r\n$/);
  assert.match(win.files[1].text, /"\/usr\/bin\/node" ".*setup\.mjs" --watchdog >> ".*watchdog\.log" 2>&1\r\n$/);
  assert.equal(win.commands[0].args.join(" "), `/Create /TN Hermes Hotline /TR "${win.files[0].path}" /SC ONLOGON /F`);
  assert.equal(win.commands[1].args.join(" "), `/Create /TN Hermes Hotline Watchdog /TR "${win.files[1].path}" /SC MINUTE /MO 5 /F`);
  assert.deepEqual(win.restart.map(line), ["schtasks /End /TN Hermes Hotline", "schtasks /Run /TN Hermes Hotline"]);
  assert.equal(servicePlan(fakeSys({ platform: "freebsd" })), null);
});

await test("the installed skill runs call.mjs from where the repo is", () => {
  const text = skillText(repoFile("hermes-skill/watch-call/SKILL.md"), "/opt/hermes hotline/call.mjs");
  assert.match(text, /node "\/opt\/hermes hotline\/call\.mjs" "One short sentence/);
  assert.doesNotMatch(text, /~\/hermes-hotline|Change the path/);
});

await test("setup on a fresh Linux desktop turns on Hermes's API, saves everything, starts the service and calls", async () => {
  const sys = fakeSys({
    files: { ...repoFiles(), "/home/me/.hermes/.env": "OPENROUTER_API_KEY=keep-me\n" },
    paths: ["/home/me/.hermes", "/usr/bin/tailscale"],
    which: { hermes: "/usr/local/bin/hermes", tailscale: "/usr/bin/tailscale" },
    world: { hermesUp: false, tailscale: { BackendState: "Running", Self: { DNSName: "desk.tail1234.ts.net." } }, fail: (l) => l.startsWith("loginctl") },
  });
  const io = scriptedIo([
    ["Hermes API server is off", true], ["Restart the Hermes gateway", true],
    ["Account SID", SID], ["Auth token", TOKEN], ["Which number calls you", undefined],
    ["Your phone number", "+1 (555) 222-3333"], ["Tailscale Funnel", true],
    ["Start the call server", true], ["Call +15552223333 now", true],
  ]);
  sys.world.hermesKey = null;
  const realWrite = sys.write;
  sys.write = (p, text, mode) => { // Hermes reads its new key when it restarts
    realWrite(p, text, mode);
    if (p === "/home/me/.hermes/.env") sys.world.hermesKey = parseEnv(text).API_SERVER_KEY;
  };
  await runSetup({ io, sys });
  assert.deepEqual(io.left, [], "every question was asked");

  const hermesEnv = parseEnv(sys.files.get("/home/me/.hermes/.env"));
  assert.equal(hermesEnv.OPENROUTER_API_KEY, "keep-me");
  assert.equal(hermesEnv.API_SERVER_ENABLED, "true");
  assert.match(hermesEnv.API_SERVER_KEY, /^[0-9a-f]{64}$/);
  assert.equal(sys.modes.get("/home/me/.hermes/.env"), 0o600);

  const saved = parseEnv(sys.files.get(`${REPO}/.env`));
  assert.deepEqual({ ...saved }, {
    TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN, TWILIO_PHONE_NUMBER: "+15550001111", OWNER_PHONE_NUMBER: "+15552223333",
    CALL_PUBLIC_URL: "https://desk.tail1234.ts.net", CALL_PORT: "8650",
    HERMES_API_KEY: hermesEnv.API_SERVER_KEY, HERMES_API_URL: "http://127.0.0.1:8642", HERMES_CONVERSATION: "watch-call",
  });
  assert.match(sys.files.get(`${REPO}/.env`), /^# npm run setup writes these settings/, "the comments from .env.example stay");
  assert.equal(sys.modes.get(`${REPO}/.env`), 0o600);
  assert.match(sys.files.get("/home/me/.hermes/skills/watch-call/SKILL.md"), /node "\/home\/me\/hermes-hotline\/call\.mjs"/);
  assert.ok(sys.files.has("/home/me/.config/systemd/user/hermes-hotline.service"));
  assert.ok(sys.files.has("/home/me/.config/systemd/user/hermes-hotline-watchdog.service"));
  assert.ok(sys.files.has("/home/me/.config/systemd/user/hermes-hotline-watchdog.timer"));
  assert.deepEqual(sys.commands.filter((c) => !c.includes("status --json")), [
    "/usr/local/bin/hermes gateway restart", "/usr/bin/tailscale funnel --bg 8650",
    "systemctl --user daemon-reload", "systemctl --user enable hermes-hotline.service", "systemctl --user restart hermes-hotline.service",
    "systemctl --user enable --now hermes-hotline-watchdog.timer", "loginctl enable-linger me"]);
  assert.match(io.text(), /a watchdog that checks the call server every 5 minutes/);
  assert.match(io.text(), /Hermes's \.env has no TELEGRAM_BOT_TOKEN/, "says where watchdog problems go");
  const call = sys.requests.find((r) => r.url.endsWith("/Calls.json"));
  assert.equal(call.form.To, "+15552223333");
  assert.equal(call.form.From, "+15550001111");
  assert.match(call.form.Twiml, /url="wss:\/\/desk\.tail1234\.ts\.net\/relay"/);
  assert.match(io.text(), /AI\/ML Features Addendum/);
  assert.match(io.text(), /run: sudo loginctl enable-linger me/, "a failed linger is a note, not a stop");
  assert.match(io.text(), /Done\. Tell Hermes "call me"/);
});

await test("setup on a Mac with a trial account buys a number and warns about the trial", async () => {
  const sys = fakeSys({
    platform: "darwin", home: "/Users/me",
    files: { ...repoFiles(), "/Users/me/.hermes/.env": `API_SERVER_ENABLED=true\nAPI_SERVER_KEY=${"k".repeat(32)}\n` },
    paths: ["/Users/me/.hermes"],
    world: { hermesKey: "k".repeat(32), account: { status: "active", type: "Trial", friendly_name: "Trial" }, numbers: [], verified: false },
  });
  const io = scriptedIo([
    ["Account SID", SID], ["Auth token", TOKEN], ["Country", undefined], ["Area code", "415"], ["Buy +14155550123", true],
    ["Your phone number", "+15552223333"], ["Public HTTPS address", "https://hermes.example.com/"], ["Start the call server", false],
  ]);
  await runSetup({ io, sys });
  assert.deepEqual(io.left, []);
  const search = sys.requests.find((r) => r.url.includes("/AvailablePhoneNumbers/US/Local.json"));
  assert.equal(new URL(search.url).searchParams.get("AreaCode"), "415");
  assert.equal(sys.requests.find((r) => r.method === "POST" && r.url.endsWith("/IncomingPhoneNumbers.json")).form.PhoneNumber, "+14155550123");
  const saved = parseEnv(sys.files.get(`${REPO}/.env`));
  assert.equal(saved.TWILIO_PHONE_NUMBER, "+14155550123");
  assert.equal(saved.CALL_PUBLIC_URL, "https://hermes.example.com");
  assert.equal(saved.HERMES_API_KEY, "k".repeat(32));
  assert.match(io.text(), /This is a trial account/);
  assert.match(io.text(), /Verify \+15552223333 in the Twilio Console/);
  assert.match(io.text(), /Tailscale does not run on this computer/);
  assert.match(io.text(), /npm start/);
  assert.ok(!sys.requests.some((r) => r.url.endsWith("/Calls.json")), "no test call without the service");
  assert.ok(![...sys.files.keys()].some((p) => p.endsWith(".plist")));
});

await test("setup asks for Hermes's key when the one in its .env is not the one it uses", async () => {
  const sys = fakeSys({
    files: { ...repoFiles(), "/home/me/.hermes/.env": `API_SERVER_ENABLED=true\nAPI_SERVER_KEY=${"old".repeat(8)}\n` },
    paths: ["/home/me/.hermes"],
    world: { hermesKey: "the-key-in-config-yaml" },
  });
  const io = scriptedIo([
    ["Paste the API_SERVER_KEY", "the-key-in-config-yaml"], ["Account SID", SID], ["Auth token", TOKEN], ["Which number", undefined],
    ["Your phone number", "+15552223333"], ["Public HTTPS address", "https://hermes.example.com"], ["Start the call server", false],
  ]);
  await runSetup({ io, sys });
  assert.equal(parseEnv(sys.files.get(`${REPO}/.env`)).HERMES_API_KEY, "the-key-in-config-yaml");
});

await test("setup stops with a clear reason when a step cannot work", async () => {
  const base = () => ({ files: { ...repoFiles(), "/home/me/.hermes/.env": `API_SERVER_ENABLED=true\nAPI_SERVER_KEY=${"k".repeat(32)}\n` },
    paths: ["/home/me/.hermes", "/usr/bin/tailscale"], which: { tailscale: "/usr/bin/tailscale" },
    world: { hermesKey: "k".repeat(32), tailscale: { BackendState: "Running", Self: { DNSName: "desk.tail1234.ts.net." } } } });
  const stops = async (sysOptions, answers, reason) => {
    const sys = fakeSys(sysOptions);
    await assert.rejects(runSetup({ io: scriptedIo(answers), sys }), (e) => e instanceof SetupError && reason.test(e.message), String(reason));
    return sys;
  };
  await stops({ ...base(), paths: [] }, [], /HERMES_HOME/);
  await stops(base(), [["Account SID", "12345"]], /starts with AC/);
  await stops(base(), [["Account SID", SID], ["Auth token", "wrong"]], /Twilio refused/);
  await stops({ ...base(), world: { ...base().world, numbers: [] } },
    [["Account SID", SID], ["Auth token", TOKEN], ["Country", undefined], ["Area code", undefined], ["Buy", false]], /did not buy a number/);
  await stops(base(), [["Account SID", SID], ["Auth token", TOKEN], ["Which number", "7"]], /from 1 to 1/);
  await stops(base(), [["Account SID", SID], ["Auth token", TOKEN], ["Which number", undefined], ["Your phone number", "5552223333"]], /\+ and the country code/);
  await stops(base(), [["Account SID", SID], ["Auth token", TOKEN], ["Which number", undefined], ["Your phone number", "+15550001111"]], /That is the Twilio number/);
  await stops({ ...base(), world: { ...base().world, fail: (l) => l.includes("funnel") } },
    [["Account SID", SID], ["Auth token", TOKEN], ["Which number", undefined], ["Your phone number", "+15552223333"], ["Funnel", true]], /Funnel did not start/);
  const sys = await stops({ ...base(), world: { ...base().world, fail: (l) => l.includes("enable hermes") } },
    [["Account SID", SID], ["Auth token", TOKEN], ["Which number", undefined], ["Your phone number", "+15552223333"], ["Funnel", true], ["Start the call server", true]],
    /systemctl --user enable hermes-hotline\.service" failed: it broke/);
  assert.ok(!sys.requests.some((r) => r.url.endsWith("/Calls.json")), "no call after a failed step");
  await stops({ ...base(), world: { ...base().world, publicUp: false } },
    [["Account SID", SID], ["Auth token", TOKEN], ["Which number", undefined], ["Your phone number", "+15552223333"], ["Funnel", true], ["Start the call server", true]],
    /does not answer at https:\/\/desk\.tail1234\.ts\.net\/health/);
});

await test("doctor says what works and what to fix", async () => {
  const settings = upsertEnv(repoFile(".env.example"), {
    TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN, TWILIO_PHONE_NUMBER: "+15550001111", OWNER_PHONE_NUMBER: "+15552223333",
    CALL_PUBLIC_URL: "https://desk.tail1234.ts.net", HERMES_API_KEY: "k".repeat(32),
  });
  const files = { [`${REPO}/.env`]: settings, "/home/me/.hermes/skills/watch-call/SKILL.md": "skill" };
  let io = scriptedIo([]), sys = fakeSys({ files, world: { hermesKey: "k".repeat(32) } });
  assert.equal(await runChecks({ io, sys }), true);
  assert.equal(io.said.filter((l) => l.startsWith("✓")).length, 8);
  assert.ok(io.said.includes("✓ Always on"));

  io = scriptedIo([]);
  assert.equal(await runChecks({ io, sys: fakeSys({ files, world: { hermesKey: "k".repeat(32), linger: false, timerActive: false } }) }), false);
  assert.match(io.text(), /✗ Always on: the watchdog does not run\. Run: npm run setup; the call server stops when you log out, and waits for your login after a reboot\. Run once: sudo loginctl enable-linger me/);
  io = scriptedIo([]);
  assert.equal(await runChecks({ io, sys: fakeSys({ files, world: { hermesKey: "k".repeat(32), enabled: false } }) }), false);
  assert.match(io.text(), /✗ Always on: the call server does not start with the computer\. Run: npm run setup\n/);
  io = scriptedIo([]);
  assert.equal(await runChecks({ io, sys: fakeSys({ platform: "freebsd", files, world: { hermesKey: "k".repeat(32) } }) }), false);
  assert.match(io.text(), /✗ Always on: setup cannot install a service on this system/);

  io = scriptedIo([]);
  sys = fakeSys({ files, world: { hermesKey: "k".repeat(32), serverUp: false, account: { status: "active", type: "Trial", friendly_name: "T" } } });
  assert.equal(await runChecks({ io, sys }), false);
  assert.match(io.text(), /✓ Twilio account: trial\. Upgrade it/);
  assert.match(io.text(), /✗ Call server: no answer at http:\/\/127\.0\.0\.1:8650\/health/);
  assert.match(io.text(), /✗ Public address: not checked, because the call server does not run/);

  io = scriptedIo([]);
  assert.equal(await runChecks({ io, sys: fakeSys({ files, world: { hermesKey: "k".repeat(32), publicUp: false } }) }), false);
  assert.match(io.text(), /✓ Call server\n✗ Public address: no answer at https:\/\/desk\.tail1234\.ts\.net\/health\. Check the tunnel\./);

  io = scriptedIo([]);
  assert.equal(await runChecks({ io, sys: fakeSys({ world: { hermesUp: false } }) }), false);
  assert.match(io.text(), /✗ Settings: TWILIO_ACCOUNT_SID, .* missing from \.env/);
  assert.match(io.text(), /✗ Hermes API server: no answer/);
  assert.match(io.text(), /✗ Hermes skill: not installed/);
});

const installed = (extra = {}) => ({
  ...repoFiles(),
  [`${REPO}/.env`]: upsertEnv(repoFile(".env.example"), {
    TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN, TWILIO_PHONE_NUMBER: "+15550001111", OWNER_PHONE_NUMBER: "+15552223333",
    CALL_PUBLIC_URL: "https://desk.tail1234.ts.net", HERMES_API_KEY: "k".repeat(32),
  }),
  "/home/me/.hermes/skills/watch-call/SKILL.md": "skill",
  "/home/me/.config/systemd/user/hermes-hotline.service": "old unit",
  ...extra,
});

await test("the watchdog restarts a call server that stops answering", async () => {
  const sys = fakeSys({ files: installed(), world: { hermesKey: "k".repeat(32), serverUp: false } });
  const io = scriptedIo([]);
  assert.equal(await runWatchdog({ io, sys }), true);
  assert.ok(sys.commands.includes("systemctl --user restart hermes-hotline.service"));
  assert.match(io.text(), /does not answer at http:\/\/127\.0\.0\.1:8650\/health\. Restarting it\.\nAll checks pass\./);
  assert.deepEqual(sys.telegram, [], "a restart that works sends nothing");

  const healthy = fakeSys({ files: installed(), world: { hermesKey: "k".repeat(32) } });
  await runWatchdog({ io: scriptedIo([]), sys: healthy });
  assert.ok(!healthy.commands.some((c) => c.includes(" restart ")), "no restart while it answers");

  const stuck = fakeSys({ files: installed(), world: { hermesKey: "k".repeat(32), serverUp: false, fail: (l) => l.includes(" restart ") } });
  const stuckIo = scriptedIo([]);
  assert.equal(await runWatchdog({ io: stuckIo, sys: stuck }), false);
  assert.match(stuckIo.text(), /"systemctl --user restart hermes-hotline\.service" failed: it broke\n✗ Call server: no answer/);
});

await test("the watchdog sends one Telegram message for a lasting problem, and one when it clears", async () => {
  const hermesEnv = "TELEGRAM_BOT_TOKEN=123:abc\nTELEGRAM_ALLOWED_USERS=4242, 777\n";
  const sys = fakeSys({ files: installed({ "/home/me/.hermes/.env": hermesEnv }), world: { hermesKey: "k".repeat(32), publicUp: false } });
  assert.deepEqual(telegramChat(sys), { token: "123:abc", chat: "4242" }, "the first allowed user when there is no home channel");
  const run = () => runWatchdog({ io: scriptedIo([]), sys });

  assert.equal(await run(), false);
  assert.equal(sys.telegram.length, 0, "one bad run can be a network drop");
  await run();
  assert.equal(sys.telegram.length, 1);
  assert.equal(sys.telegram[0].url, "https://api.telegram.org/bot123:abc/sendMessage");
  assert.equal(sys.telegram[0].chat_id, "4242");
  assert.match(sys.telegram[0].text, /^Hermes Hotline needs you:\n✗ Public address: no answer at https:\/\/desk\.tail1234\.ts\.net\/health\. Check the tunnel\.$/);
  await run();
  assert.equal(sys.telegram.length, 1, "no repeat while the same problem lasts");

  sys.world.publicUp = true;
  assert.equal(await run(), true);
  assert.equal(sys.telegram.length, 1);
  await run();
  assert.deepEqual(sys.telegram.map((m) => m.text).slice(1), ["Hermes Hotline works again."]);
  await run();
  assert.equal(sys.telegram.length, 2);

  sys.files.set("/home/me/.hermes/.env", hermesEnv + "TELEGRAM_HOME_CHANNEL=-1009\n");
  assert.equal(telegramChat(sys).chat, "-1009", "the home channel comes first");
});

await test("the watchdog tries again when Telegram cannot take the message", async () => {
  const sys = fakeSys({ files: installed({ "/home/me/.hermes/.env": "TELEGRAM_BOT_TOKEN=1:a\nTELEGRAM_HOME_CHANNEL=55\n" }),
    world: { hermesKey: "k".repeat(32), hermesUp: false, telegramUp: false } });
  const io = scriptedIo([]);
  await runWatchdog({ io, sys });
  await runWatchdog({ io, sys });
  assert.match(io.text(), /Could not send a Telegram message/);
  sys.world.telegramUp = true;
  await runWatchdog({ io, sys });
  assert.equal(sys.telegram.length, 1);
  assert.match(sys.telegram[0].text, /✗ Hermes API server: no answer at http:\/\/127\.0\.0\.1:8642\. Start Hermes\./);

  const quiet = fakeSys({ files: installed(), world: { hermesKey: "k".repeat(32), publicUp: false } });
  const quietIo = scriptedIo([]);
  await runWatchdog({ io: quietIo, sys: quiet });
  await runWatchdog({ io: quietIo, sys: quiet });
  assert.match(quietIo.text(), /Could not send a Telegram message\. Hermes's \.env needs TELEGRAM_BOT_TOKEN/, "no Telegram settings: the log says so");
});

await test("update writes the new service files, restarts the call server and runs the checks", async () => {
  const sys = fakeSys({ files: installed(), world: { hermesKey: "k".repeat(32) } });
  const io = scriptedIo([]);
  assert.equal(await refreshService({ io, sys }), true);
  assert.match(sys.files.get("/home/me/.config/systemd/user/hermes-hotline.service"), /StartLimitIntervalSec=0/);
  assert.ok(sys.files.has("/home/me/.config/systemd/user/hermes-hotline-watchdog.timer"));
  assert.ok(sys.commands.includes("systemctl --user restart hermes-hotline.service"));
  assert.match(sys.files.get("/home/me/.hermes/skills/watch-call/SKILL.md"), /node "\/home\/me\/hermes-hotline\/call\.mjs"/, "the skill is new too");
  assert.match(io.text(), /✓ Always on/);

  const noService = installed();
  delete noService["/home/me/.config/systemd/user/hermes-hotline.service"];
  const manual = fakeSys({ files: noService, world: { hermesKey: "k".repeat(32) } });
  const manualIo = scriptedIo([]);
  await refreshService({ io: manualIo, sys: manual });
  assert.match(manualIo.text(), /No service is installed/);
  assert.ok(!manual.commands.includes("systemctl --user daemon-reload"), "update does not install a service nobody asked for");

  await assert.rejects(refreshService({ io: scriptedIo([]), sys: fakeSys({ files: repoFiles() }) }), /missing from \.env\. Run: npm run setup/);
});

console.log(results.join("\n"));
console.log(`${results.length} passed`);
