#!/usr/bin/env node

// pi-link CLI — launch Pi with session resume by name
//
// Usage:
//   pi-link <name> [--global|-g] [flags...]
//                                Resume or create a named session, connected to link.
//   pi-link --list [--global|-g] List pi-link sessions in current cwd (or everywhere).
//   pi-link --resolve <name> [--global|-g]
//                                Print just the session path (machine-readable).
//
// Deprecated subcommand forms `pi-link list` / `pi-link resolve <name>` still
// work for one release with a stderr warning.

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

const rawArgs = process.argv.slice(2);

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

// Reject Pi flags that pi-link manages, plus --link-name (which exists at the
// `pi` level for link-only naming, but the wrapper's combined-mode contract
// conflicts with it). Called from Phase 6 (mode entry) and Phase 7 (after
// launcher name), so it fires on both `pi-link --session foo` and
// `pi-link foo --session bar` with the friendly message.
function rejectManagedFlag(token) {
  const key = token.split("=")[0];
  if (key === "--link-name") {
    console.error(
      "Error: --link-name is not accepted by the pi-link wrapper.\n" +
      "  Use 'pi-link <name>' for combined link+session,\n" +
      "  or run 'pi --link-name <name>' directly to set link name without session resolution.",
    );
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

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function printHelp() {
  console.error("Usage: pi-link <name> [--global|-g] [pi flags...]");
  console.error("       pi-link --list [--global|-g]");
  console.error("       pi-link --resolve <name> [--global|-g]");
  console.error("");
  console.error("By default, name lookup is scoped to the current cwd.");
  console.error("--global / -g widens the search to sessions in any cwd.");
}

function printDeprecationWarning(form) {
  const canonical = form === "list" ? "--list" : "--resolve";
  console.error(
    `Warning: 'pi-link ${form}' is deprecated. Use 'pi-link ${canonical}' instead. ` +
    `(Subcommand form will be removed in a future release.)`,
  );
}

function describeMode(mode) {
  switch (mode) {
    case "help": return "--help";
    case "list": return "--list";
    case "resolve": return "--resolve";
    case "launcher": return "session name";
    default: return mode;
  }
}

// ── Parser ─────────────────────────────────────────────────────────────────
//
// Single sequential pass populates `state`; dispatcher reads it. Phases (per
// PLAN-cli-flags.md):
//   1. Renamed-flag rejection (always-on for --all/-a)
//   2. Global flags (--global, --help, --)
//   3. Mode-selecting flags (--list, --resolve, --resolve=<name>)
//   4. Deprecated subcommands (list, resolve <name>) — only at mode-null position
//   5. Mode-specific extra-token rejection (with deprecated-resolve leniency)
//   6. Launcher mode entry (mode null + bare positional)
//   7. Launcher passthrough (mode launcher) with orphan-positional rejection

const state = {
  mode: null, // null | "help" | "list" | "resolve" | "launcher"
  resolveName: null,
  launcherName: null,
  global: false,
  piPassthrough: [],
  deprecated: null, // null | "list" | "resolve"
};

function setMode(mode) {
  if (state.mode !== null && state.mode !== mode) {
    fail(`cannot combine ${describeMode(state.mode)} and ${describeMode(mode)}`);
  }
  state.mode = mode;
}

let lastWasFlag = false;

for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];

  // Phase 1: renamed-flag rejection.
  rejectRenamedFlag(a);

  // Phase 2: global flags / scope-affecting tokens.
  if (a === "--global" || a === "-g") {
    state.global = true;
    lastWasFlag = false;
    continue;
  }
  if (a === "--help" || a === "-h") {
    setMode("help"); // errors if combined with another mode
    continue;
  }
  if (a === "--") {
    // `--` only meaningful in launcher mode (separates pi flags from positionals).
    if (state.mode !== "launcher") {
      fail(`-- is only valid after a session name`);
    }
    for (let j = i + 1; j < rawArgs.length; j++) {
      state.piPassthrough.push(rawArgs[j]);
    }
    i = rawArgs.length;
    break;
  }

  // Phase 3: mode-selecting flags.
  if (a === "--list") {
    setMode("list");
    continue;
  }
  if (a.startsWith("--resolve=")) {
    setMode("resolve");
    if (state.resolveName !== null) fail(`--resolve specified more than once`);
    state.resolveName = a.slice("--resolve=".length);
    continue;
  }
  if (a === "--resolve") {
    setMode("resolve");
    if (state.resolveName !== null) fail(`--resolve specified more than once`);
    const next = rawArgs[i + 1];
    if (next === undefined || next.startsWith("-")) {
      fail(`--resolve requires a name argument.\n  Usage: pi-link --resolve <name> [--global|-g]`);
    }
    state.resolveName = next;
    i++; // consume the value
    continue;
  }

  // Phase 4: deprecated subcommands (only at mode-null position).
  if (state.mode === null && (a === "list" || a === "resolve")) {
    state.deprecated = a;
    if (a === "list") {
      setMode("list");
    } else {
      setMode("resolve");
      const next = rawArgs[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        state.resolveName = next;
        i++;
      }
      // else: leave null; Phase 5 leniency or post-parse validation handles it.
    }
    continue;
  }

  // Phase 5: mode-specific extra-token rejection.
  if (state.mode === "help") {
    fail(`--help does not accept arguments: ${a}`);
  }
  if (state.mode === "list") {
    fail(`--list does not accept argument: ${a}\n  Usage: pi-link --list [--global|-g]`);
  }
  if (state.mode === "resolve") {
    // Deprecated-form leniency: `pi-link resolve --global foo` was order-independent;
    // if we entered via deprecated path and haven't bound a name yet, take this.
    if (
      state.deprecated === "resolve" &&
      state.resolveName === null &&
      !a.startsWith("-")
    ) {
      state.resolveName = a;
      continue;
    }
    fail(`--resolve accepts exactly one name; got extra: ${a}`);
  }

  // Phase 6: launcher mode entry. state.mode === null here, no name set yet.
  // (lastWasFlag is still false here — only Phase 7 sets it, and Phase 7 requires launcher mode.)
  if (state.mode === null) {
    rejectManagedFlag(a);
    if (a.startsWith("-")) {
      fail(`Unknown argument: ${a}\n  Usage: pi-link <name> [--global|-g] [pi flags...]`);
    }
    state.mode = "launcher";
    state.launcherName = a;
    continue;
  }

  // Phase 7: launcher mode, name set. Tokens go to passthrough or get rejected.
  rejectManagedFlag(a);
  if (a.startsWith("-")) {
    state.piPassthrough.push(a);
    // `--key=value` is self-contained; only `--key` (without `=`) might consume
    // the next token as its value.
    lastWasFlag = !a.includes("=");
    continue;
  }
  // Bare positional: allowed only if it follows a flag without `=`.
  if (lastWasFlag) {
    state.piPassthrough.push(a);
    lastWasFlag = false;
    continue;
  }
  fail(`Unexpected argument after session name: ${a}\n  Use -- to pass positional arguments to pi.`);
}

// ── Post-parse validation ──────────────────────────────────────────────────

if (state.mode === "resolve") {
  if (state.resolveName === null) {
    fail(`--resolve requires a name argument.\n  Usage: pi-link --resolve <name> [--global|-g]`);
  }
  const normalized = state.resolveName.trim().replace(/\s+/g, " ");
  if (!normalized) {
    fail(`--resolve requires a non-empty name argument.\n  Usage: pi-link --resolve <name> [--global|-g]`);
  }
  state.resolveName = normalized;
}
if (state.mode === "launcher") {
  const normalized = state.launcherName.trim().replace(/\s+/g, " ");
  if (!normalized) {
    fail(`session name cannot be empty.\n  Usage: pi-link <name> [--global|-g] [pi flags...]`);
  }
  state.launcherName = normalized;
}

if (state.deprecated) {
  printDeprecationWarning(state.deprecated);
}

// ── Dispatch ───────────────────────────────────────────────────────────────

switch (state.mode) {
  case null:
  case "help":
    printHelp();
    process.exit(0);
    break; // unreachable; present to satisfy no-fallthrough lints
  case "list":
    await runList(state);
    break;
  case "resolve":
    await runResolve(state);
    break;
  case "launcher":
    await runLauncher(state);
    break;
  default:
    fail(`internal error: unknown mode ${state.mode}`);
}

// ── Mode handlers ──────────────────────────────────────────────────────────

async function runList(state) {
  const { dir, isCustom } = resolveSessionDir(process.cwd(), resolveAgentDir());
  const sessions = await listSessions({ all: state.global, dir, isCustom });
  if (sessions.length === 0) {
    console.log(state.global ? "No pi-link sessions found." : "No pi-link sessions found in this cwd.");
    console.log("Start one: pi-link <name>");
    return;
  }
  const columns = state.global
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
}

async function runResolve(state) {
  const name = state.resolveName; // already normalized
  const { dir, isCustom } = resolveSessionDir(process.cwd(), resolveAgentDir());
  const { local, all } = await findSessionsByName(name, dir, isCustom);
  const matches = state.global ? all : local;
  if (matches.length === 1) {
    process.stdout.write(matches[0].path);
    return; // exit 0
  }
  if (matches.length > 1) {
    printCandidates(name, matches); // exits 1
  }
  // matches.length === 0 → not found; exit 2 to distinguish from ambiguous.
  console.error(`No session named "${name}" found${state.global ? "" : " in this cwd"}.`);
  if (!state.global && all.length > 0) {
    console.error(`(${all.length} match${all.length === 1 ? "" : "es"} in other cwds — try --global to consider ${all.length === 1 ? "it" : "them"}.)`);
  }
  process.exit(2);
}

async function runLauncher(state) {
  const name = state.launcherName; // already normalized
  const { dir, isCustom } = resolveSessionDir(process.cwd(), resolveAgentDir());
  const { local, all } = await findSessionsByName(name, dir, isCustom);
  const matches = state.global ? all : local;
  if (matches.length > 1) {
    printCandidates(name, matches);
  }

  const piArgs = [];
  if (matches.length === 1) {
    console.error(`Resuming session: ${matches[0].path}`);
    piArgs.push("--session", matches[0].path);
  } else {
    if (!state.global && all.length > local.length) {
      const elsewhere = all.length - local.length;
      console.error(`No "${name}" in this cwd. (${elsewhere} match${elsewhere === 1 ? "" : "es"} in other cwds — use --global to consider ${elsewhere === 1 ? "it" : "them"}.)`);
    }
    console.error("Starting new session.");
  }
  piArgs.push("--link", ...state.piPassthrough);

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
}
