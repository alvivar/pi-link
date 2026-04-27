#!/usr/bin/env node

// pi-link CLI — launch Pi with session resume by name
//
// Usage:
//   pi-link <name> [flags...]   Resume or create a named session, connected to link.
//   pi-link list [--all|-a]     List pi-link sessions in current cwd (or everywhere).
//   pi-link resolve <name>      Print just the session path (machine-readable).

import { readdir, stat } from "fs/promises";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { join } from "path";
import { homedir } from "os";
import { spawn } from "child_process";

const SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");

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

// Walks SESSIONS_DIR in parallel, returning meta + mtime + path for every
// readable session. Callers filter and sort. Errors on individual files/dirs
// are silently skipped — active or partially-written sessions are tolerated.
async function scanSessions() {
  let cwdDirs;
  try {
    cwdDirs = await readdir(SESSIONS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const tasks = [];
  for (const dir of cwdDirs) {
    if (!dir.isDirectory()) continue;
    const dirPath = join(SESSIONS_DIR, dir.name);
    let files;
    try { files = await readdir(dirPath); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = join(dirPath, file);
      tasks.push((async () => {
        try {
          const meta = await getSessionMeta(filePath);
          const stats = await stat(filePath);
          return { ...meta, modified: stats.mtime, path: filePath };
        } catch {
          return null;
        }
      })());
    }
  }

  return (await Promise.all(tasks)).filter((s) => s !== null);
}

// Find sessions whose current display name matches `targetName`. Local cwd
// matches sort first, then by recency. Falls back to `session_info.name` for
// sessions without a link-name (so `pi-link <name>` can attach link to a
// previously-unlinked named session).
async function findSessionsByName(targetName) {
  const localCwd = normalizePath(process.cwd());
  return (await scanSessions())
    .filter((s) => s.name === targetName)
    .map((s) => ({ path: s.path, cwd: s.cwd || "?", modified: s.modified }))
    .sort((a, b) => {
      const aLocal = normalizePath(a.cwd) === localCwd ? 1 : 0;
      const bLocal = normalizePath(b.cwd) === localCwd ? 1 : 0;
      if (aLocal !== bLocal) return bLocal - aLocal;
      return b.modified.getTime() - a.modified.getTime();
    });
}

// List pi-link sessions (those with at least one link-name entry). Default
// scope is current cwd; `all` widens to every directory.
async function listSessions({ all }) {
  const localCwd = normalizePath(process.cwd());
  return (await scanSessions())
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
  let all = false;
  for (const a of args) {
    if (a === "--all" || a === "-a") all = true;
    else {
      console.error(`Unknown argument: ${a}`);
      console.error("Usage: pi-link list [--all|-a]");
      process.exit(1);
    }
  }
  const sessions = await listSessions({ all });
  if (sessions.length === 0) {
    console.log(all ? "No pi-link sessions found." : "No pi-link sessions found in this cwd.");
    console.log("Start one: pi-link <name>");
    process.exit(0);
  }
  const columns = all
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
  const name = args[0]?.trim().replace(/\s+/g, " ");
  if (!name) {
    console.error("Usage: pi-link resolve <name>");
    process.exit(1);
  }
  const matches = await findSessionsByName(name);
  if (matches.length === 1) {
    process.stdout.write(matches[0].path);
  } else if (matches.length > 1) {
    printCandidates(name, matches);
  }
} else if (command && command !== "--help" && command !== "-h") {
  // pi-link <name> [flags...] — resolve and launch Pi
  const name = command.trim().replace(/\s+/g, " ");
  if (!name) {
    console.error("Usage: pi-link <name> [pi flags...]");
    process.exit(1);
  }

  // Reject conflicting flags
  for (const flag of args) {
    const key = flag.split("=")[0];
    if (["--session", "--continue", "-c", "--resume", "-r", "--fork", "--no-session", "--session-dir"].includes(key)) {
      console.error(`Error: ${key} is managed by pi-link. Remove it.`);
      process.exit(1);
    }
    // Catch the removed extension flag before forwarding args to Pi.
    if (key === "--link-name") {
      console.error("Error: --link-name was removed. Use: pi-link <name>");
      process.exit(1);
    }
  }

  const matches = await findSessionsByName(name);
  if (matches.length > 1) {
    printCandidates(name, matches);
  }

  const piArgs = [];
  if (matches.length === 1) {
    console.error(`Resuming session: ${matches[0].path}`);
    piArgs.push("--session", matches[0].path);
  } else {
    console.error("No existing session found. Starting new session.");
  }
  piArgs.push("--link", ...args);

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
  console.error("Usage: pi-link <name> [pi flags...]");
  console.error("       pi-link list [--all|-a]");
  console.error("       pi-link resolve <name>");
  process.exit(0);
}
