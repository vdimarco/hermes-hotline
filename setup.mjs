// Guided setup: npm run setup. Add --yes to accept every default without asking.
// Also: --check (npm run doctor), --watchdog (run by the service manager), --service (npm run update, after git pull).
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, extname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { SetupError, refreshService, runChecks, runSetup, runWatchdog } from "./onboarding.mjs";

const args = process.argv.slice(2);
const yes = args.includes("--yes");

// Finds a command on the PATH, as the shell would. On Windows, also tries the PATHEXT endings.
function which(cmd) {
  const exts = process.platform === "win32" ? ["", ...(process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    for (const ext of exts) {
      const file = join(dir, cmd + ext);
      try { if (statSync(file).isFile()) return file; } catch {}
    }
  }
  return null;
}

const sys = {
  platform: process.platform,
  home: homedir(),
  repoDir: dirname(fileURLToPath(import.meta.url)),
  nodePath: process.execPath,
  env: process.env,
  uid: process.getuid?.() ?? 0,
  user: userInfo().username,
  fetch: (url, options) => fetch(url, options),
  which,
  // Never throws: a command that cannot start returns code -1.
  run: (cmd, argv, { inherit = false } = {}) => new Promise((resolve) => {
    const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(extname(cmd));
    const child = spawn(cmd, argv, { stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"], shell });
    let stdout = "", stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", (e) => resolve({ code: -1, stdout, stderr: e.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  }),
  read: (file) => (existsSync(file) ? readFileSync(file, "utf8") : null),
  write: (file, text, mode) => {
    writeFileSync(file, text, mode ? { mode } : undefined);
    if (mode) chmodSync(file, mode);
  },
  mkdir: (dir) => mkdirSync(dir, { recursive: true }),
  exists: existsSync,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

async function line(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

// Reads a line without showing it. Falls back to a normal line when the input is not a terminal.
function hidden(question) {
  if (!process.stdin.isTTY) return line(question);
  process.stdout.write(question);
  return new Promise((resolve) => {
    let value = "";
    const stdin = process.stdin;
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(value.trim());
        }
        if (c === "\u0003") process.exit(130); // Ctrl+C
        value = c === "\u007f" || c === "\b" ? value.slice(0, -1) : value + c;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onData);
  });
}

const io = {
  say: (text) => console.log(text),
  ask: async (question, fallback = "") => {
    if (yes) {
      if (!fallback && !/optional/i.test(question)) throw new SetupError(`"${question}" needs an answer. Run setup without --yes.`);
      return fallback;
    }
    return (await line(`${question}${fallback ? ` [${fallback}]` : ""}: `)) || fallback;
  },
  secret: async (question) => {
    if (yes) throw new SetupError(`"${question}" needs an answer. Run setup without --yes.`);
    return hidden(`${question}: `);
  },
  confirm: async (question, yesDefault = true) => {
    if (yes) return yesDefault;
    const answer = (await line(`${question} ${yesDefault ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
    return answer ? answer.startsWith("y") : yesDefault;
  },
  pause: async (text) => {
    if (!yes) await line(`${text} `);
  },
};

try {
  if (args.includes("--check")) process.exit((await runChecks({ io, sys })) ? 0 : 1);
  if (args.includes("--watchdog")) process.exit((await runWatchdog({ io, sys })) ? 0 : 1);
  if (args.includes("--service")) process.exit((await refreshService({ io, sys })) ? 0 : 1);
  await runSetup({ io, sys });
} catch (e) {
  if (!(e instanceof SetupError)) throw e;
  console.error(`\n${e.message}`);
  process.exit(1);
}
