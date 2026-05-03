#!/usr/bin/env node

// pi-link CLI — launch Pi with session resume by name
//
// Usage:
//   pi-link <name> [--global|-g] [flags...]
//                                Resume or create a named session, connected to link.
//   pi-link list [--global|-g]   List pi-link sessions in current cwd (or everywhere).
//   pi-link resolve <name> [--global|-g]
//                                Print just the session path (machine-readable).

import { readdir, stat } from "fs/promises";
import { createReadStream, existsSync, readFileSync } from "fs";
import { createInterface } from "readline";
import { join } from "path";
import { homedir } from "os";
import { spawn } from "child_process";

// ── Pi config resolution ───────────────────────────────────────────────────
// Match Pi's session-dir lookup order so list/resolve/<name> see what Pi sees.
// Custom sessionDir → flat layout; default → <agentDir>/sessions/<encoded-cwd>.

// Match Pi's expandTildePath: only `~` and `~/...`.
function expandTilde(p) {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function readSessionDirFromSettings(settingsPath) {
  if (!existsSync(settingsPath)) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch (err) {
    console.error(`pi-link: ignored ${settingsPath}: ${err.message}`);
    return undefined;
  }
  const value = parsed?.sessionDir;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value;
}

// PI_CODING_AGENT_DIR also relocates global settings.json to <agentDir>/settings.json.
function resolveAgentDir() {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (env) return expandTilde(env);
  return join(homedir(), ".pi", "agent");
}

// Returns { dir, isCustom }. isCustom drives layout in scanSessions:
// true → flat <dir>/*.jsonl, false → <dir>/<encoded-cwd>/*.jsonl.
function resolveSessionDir(cwd, agentDir) {
  const env = process.env.PI_CODING_AGENT_SESSION_DIR;
  if (env) return { dir: expandTilde(env), isCustom: true };

  const projectDir = readSessionDirFromSettings(join(cwd, ".pi", "settings.json"));
  if (projectDir) return { dir: expandTilde(projectDir), isCustom: true };

  const globalDir = readSessionDirFromSettings(join(agentDir, "settings.json"));
  if (globalDir) return { dir: expandTilde(globalDir), isCustom: true };

  return { dir: join(agentDir, "sessions"), isCustom: false };
}

// Reads a session JSONL file and returns its display name, cwd, id, link
// status, and message count.
//
// Name precedence: latest valid `link-name` custom entry wins as the
// authoritative pi-link name. `session_info.name` is only a fallback for
// sessions that never set a link-name. Historical link-names are not aliases.
async function getSessionMeta(filePath) {
  let linkName;
  let sessionName;
  let cwd;
  let id;
  let hasLinkName = false;
  let messages = 0;
  const rl = createInterface({ input: createReadStream(filePath, "utf-8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "session") {
        if (typeof entry.cwd === "string") cwd = entry.cwd;
        if (typeof entry.id === "string") id = entry.id;
      } else if (entry.type === "session_info" && typeof entry.name === "string") {
        sessionName = entry.name.trim().replace(/\s+/g, " ") || undefined;
      } else if (entry.type === "custom" && entry.customType === "link-name") {
        hasLinkName = true;
        if (entry.data && typeof entry.data.name === "string") {
          const n = entry.data.name.trim().replace(/\s+/g, " ");
          if (n) linkName = n;
        }
      } else if (entry.type === "message" || entry.type === "user" || entry.type === "assistant") {
        messages++;
      }
    } catch {
      // skip malformed lines (incl. partial last line of active sessions)
    }
  }
  return { name: linkName ?? sessionName, cwd, id, hasLinkName, messages };
}

function normalizePath(p) {
  let s = p.replace(/[/\\]+/g, "/").replace(/\/+$/, "");
  if (process.platform === "win32") s = s.toLowerCase();
  return s;
}

// Replace $HOME with ~ in display paths. Comparison is normalized
// (case-insensitive on Windows) but display preserves original casing.
function displayPath(p) {
  if (!p) return p;
  const home = homedir();
  const normP = normalizePath(p);
  const normHome = normalizePath(home);
  if (normP === normHome) return "~";
  if (normP.startsWith(normHome + "/")) return "~" + p.slice(home.length).replace(/\\/g, "/");
  return p;
}

const useAnsi =
  !!process.stdout.isTTY &&
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb";
const bold = (s) => (useAnsi ? `\x1b[1m${s}\x1b[22m` : s);
const dim = (s) => (useAnsi ? `\x1b[2m${s}\x1b[22m` : s);

function relTime(d) {
  const sec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return d.toISOString().slice(0, 10);
}

async function loadSessionRecord(filePath) {
  try {
    const meta = await getSessionMeta(filePath);
    const stats = await stat(filePath);
    return { ...meta, modified: stats.mtime, path: filePath };
  } catch {
    return null;
  }
}

// Returns meta + mtime + path for every readable session in `dir`. Custom
// layout is flat (<dir>/*.jsonl); default layout has one subdir level per
// encoded cwd (<dir>/<sub>/*.jsonl). Errors on individual files/dirs are
// silently skipped — active or partially-written sessions are tolerated.
async function scanSessions(dir, isCustom) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const tasks = [];
  if (isCustom) {
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      tasks.push(loadSessionRecord(join(dir, entry.name)));
    }
  } else {
    for (const sub of entries) {
      if (!sub.isDirectory()) continue;
      const subPath = join(dir, sub.name);
      let files;
      try { files = await readdir(subPath); } catch { continue; }
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        tasks.push(loadSessionRecord(join(subPath, file)));
      }
    }
  }

  return (await Promise.all(tasks)).filter((s) => s !== null);
}

// Find sessions whose current display name matches `targetName`. Returns both
// local-cwd matches and all matches (cross-cwd) so the caller can default to
// local while still surfacing a hint when non-local matches exist. Falls back
// to `session_info.name` for sessions without a link-name (so `pi-link <name>`
// can attach link to a previously-unlinked named session).
async function findSessionsByName(targetName, dir, isCustom) {
  const localCwd = normalizePath(process.cwd());
  const all = (await scanSessions(dir, isCustom))
    .filter((s) => s.name === targetName)
    .map((s) => ({ path: s.path, cwd: s.cwd || "?", modified: s.modified }))
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());
  const local = all.filter((s) => normalizePath(s.cwd) === localCwd);
  return { local, all };
}

// List pi-link sessions (those with at least one link-name entry). Default
// scope is current cwd; `all` widens to every directory.
async function listSessions({ all, dir, isCustom }) {
  const localCwd = normalizePath(process.cwd());
  return (await scanSessions(dir, isCustom))
    .filter((s) => s.hasLinkName)
    .filter((s) => all || (s.cwd && normalizePath(s.cwd) === localCwd))
    .map((s) => ({
      name: s.name || "(unnamed)",
      cwd: s.cwd || "?",
      id: s.id ? s.id.slice(0, 8) : "?",
      messages: s.messages,
      modified: s.modified,
      path: s.path,
    }))
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

// Renders a plain-text table. Widths are computed from unstyled cells; ANSI
// styles are applied after padding so column alignment is preserved when piped
// or styled. Mark a column with `dim: true` to render its cells dim.
function renderTable(rows, columns) {
  const widths = columns.map((c) => Math.max(c.header.length, ...rows.map((r) => String(c.get(r)).length)));
  const padCell = (text, i) => (i === columns.length - 1 ? text : text.padEnd(widths[i]));
  const styleBody = (text, i) => (columns[i].dim ? dim(text) : text);
  const headerLine = columns.map((c, i) => bold(padCell(c.header, i))).join("  ");
  const bodyLines = rows.map((r) =>
    columns.map((c, i) => styleBody(padCell(String(c.get(r)), i), i)).join("  "),
  );
  return [headerLine, ...bodyLines].join("\n");
}

// ── CLI ────────────────────────────────────────────────────────────────────

const [command, ...args] = process.argv.slice(2);

// Reject pi-link flags renamed in 0.1.12 with a clear pointer to the new name.
// Same intent as `rejectManagedFlag` (specific message > generic "Unknown argument")
// but for our own renames, not Pi-managed flags.
function rejectRenamedFlag(token) {
  if (token === "--all" || token === "-a") {
    const replacement = token === "-a" ? "-g" : "--global";
    console.error(`Error: ${token} was renamed to ${replacement}.`);
    process.exit(1);
  }
}

// Reject Pi flags that pi-link manages, plus the removed --link-name extension flag.
// Runs on both the first token (so `pi-link --session foo` errors clearly) and on each
// flag in args (so `pi-link foo --session bar` does too).
function rejectManagedFlag(token) {
  const key = token.split("=")[0];
  if (key === "--link-name") {
    console.error("Error: --link-name was removed. Use: pi-link <name>");
    process.exit(1);
  }
  if (["--session", "--continue", "-c", "--resume", "-r", "--fork", "--no-session", "--session-dir"].includes(key)) {
    console.error(`Error: ${key} is managed by pi-link. Remove it.`);
    process.exit(1);
  }
}

function printCandidates(name, matches) {
  console.error(`Multiple sessions named "${name}":\n`);
  for (const m of matches) {
    console.error(`  ${m.modified.toISOString().slice(0, 19)}  cwd: ${m.cwd}`);
    console.error(`  ${m.path}\n`);
  }
  console.error(`Use: pi --session <path> --link`);
  process.exit(1);
}

if (command === "list") {
  let global = false;
  for (const a of args) {
    rejectRenamedFlag(a);
    if (a === "--global" || a === "-g") global = true;
    else {
      console.error(`Unknown argument: ${a}`);
      console.error("Usage: pi-link list [--global|-g]");
      process.exit(1);
    }
  }
  const { dir, isCustom } = resolveSessionDir(process.cwd(), resolveAgentDir());
  const sessions = await listSessions({ all: global, dir, isCustom });
  if (sessions.length === 0) {
    console.log(global ? "No pi-link sessions found." : "No pi-link sessions found in this cwd.");
    console.log("Start one: pi-link <name>");
    process.exit(0);
  }
  const columns = global
    ? [
        { header: "NAME", get: (s) => s.name },
        { header: "CWD", get: (s) => displayPath(s.cwd) },
        { header: "MODIFIED", get: (s) => relTime(s.modified), dim: true },
        { header: "MESSAGES", get: (s) => s.messages, dim: true },
        { header: "ID", get: (s) => s.id, dim: true },
      ]
    : [
        { header: "NAME", get: (s) => s.name },
        { header: "MODIFIED", get: (s) => relTime(s.modified), dim: true },
        { header: "MESSAGES", get: (s) => s.messages, dim: true },
        { header: "ID", get: (s) => s.id, dim: true },
      ];
  console.log(renderTable(sessions, columns));
  if (process.stdout.isTTY) {
    console.log("");
    console.log(dim("Resume: pi-link <name>"));
  }
} else if (command === "resolve") {
  let global = false;
  const positional = [];
  for (const a of args) {
    rejectRenamedFlag(a);
    if (a === "--global" || a === "-g") global = true;
    else if (a.startsWith("-")) {
      console.error(`Unknown argument: ${a}`);
      console.error("Usage: pi-link resolve <name> [--global|-g]");
      process.exit(1);
    } else positional.push(a);
  }
  if (positional.length !== 1) {
    console.error("Usage: pi-link resolve <name> [--global|-g]");
    process.exit(1);
  }
  const name = positional[0].trim().replace(/\s+/g, " ");
  const { dir, isCustom } = resolveSessionDir(process.cwd(), resolveAgentDir());
  const { local, all } = await findSessionsByName(name, dir, isCustom);
  const matches = global ? all : local;
  if (matches.length === 1) {
    process.stdout.write(matches[0].path);
  } else if (matches.length > 1) {
    printCandidates(name, matches);
  }
} else if (command && command !== "--help" && command !== "-h") {
  // pi-link [--global|-g] <name> [pi flags...] — resolve and launch Pi.
  // Walk every token in one pass: pull out --global wherever it appears, treat
  // the first non-flag token as the name, reject managed flags, forward the rest.
  let global = false;
  let name = null;
  const piPassthrough = [];
  for (const token of [command, ...args]) {
    rejectRenamedFlag(token);
    if (token === "--global" || token === "-g") { global = true; continue; }
    rejectManagedFlag(token);
    if (name === null) {
      // Before the name is set, an unknown leading flag is almost certainly a
      // user mistake (`pi-link --model gpt-4 foo`) — don't silently treat it
      // as a session name. After the name is set, anything goes (forwarded to Pi).
      if (token.startsWith("-")) {
        console.error(`Unknown argument before name: ${token}`);
        console.error("Usage: pi-link <name> [--global|-g] [pi flags...]");
        process.exit(1);
      }
      name = token;
    } else piPassthrough.push(token);
  }
  if (!name) {
    console.error("Usage: pi-link <name> [--global|-g] [pi flags...]");
    process.exit(1);
  }
  name = name.trim().replace(/\s+/g, " ");
  if (!name) {
    console.error("Usage: pi-link <name> [--global|-g] [pi flags...]");
    process.exit(1);
  }

  const { dir, isCustom } = resolveSessionDir(process.cwd(), resolveAgentDir());
  const { local, all } = await findSessionsByName(name, dir, isCustom);
  const matches = global ? all : local;
  if (matches.length > 1) {
    printCandidates(name, matches);
  }

  const piArgs = [];
  if (matches.length === 1) {
    console.error(`Resuming session: ${matches[0].path}`);
    piArgs.push("--session", matches[0].path);
  } else {
    if (!global && all.length > local.length) {
      const elsewhere = all.length - local.length;
      console.error(`No "${name}" in this cwd. (${elsewhere} match${elsewhere === 1 ? "" : "es"} in other cwds — use --global to consider ${elsewhere === 1 ? "it" : "them"}.)`);
    }
    console.error("Starting new session.");
  }
  piArgs.push("--link", ...piPassthrough);

  const isWin = process.platform === "win32";
  const cmd = isWin ? "cmd.exe" : "pi";
  const cmdArgs = isWin ? ["/d", "/c", "pi", ...piArgs] : piArgs;

  // PI_LINK_NAME is the internal handoff to the pi-link extension on the Pi side.
  // The extension consumes and deletes it on startup; never expose this as a public API.
  const child = spawn(cmd, cmdArgs, {
    stdio: "inherit",
    env: { ...process.env, PI_LINK_NAME: name },
  });
  child.once("exit", (code, signal) => {
    if (code !== null) process.exit(code);
    process.exit(signal === "SIGINT" ? 130 : 1);
  });
  child.once("error", (err) => {
    console.error(`Failed to start pi: ${err.message}`);
    process.exit(1);
  });
} else {
  console.error("Usage: pi-link <name> [--global|-g] [pi flags...]");
  console.error("       pi-link list [--global|-g]");
  console.error("       pi-link resolve <name> [--global|-g]");
  console.error("");
  console.error("By default, name lookup is scoped to the current cwd.");
  console.error("--global / -g widens the search to sessions in any cwd.");
  process.exit(0);
}
