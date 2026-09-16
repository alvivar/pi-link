#!/usr/bin/env node

// pi-link CLI — launch Pi with session resume by name
//
// Usage:
//   pi-link <name> [--global|-g] [flags...]
//                                Resume or create a named session, connected to link.
//   pi-link --list [--global|-g] List pi-link sessions in current cwd (or everywhere).
//   pi-link --status [--json]   Show terminals connected to the running hub right now.
//   pi-link --resolve <name> [--global|-g]
//                                Print just the session path (machine-readable).
//   pi-link --version            Print the installed pi-link version.

import { readdir, stat } from "fs/promises";
import { createReadStream, existsSync, readFileSync } from "fs";
import { createInterface } from "readline";
import { join } from "path";
import { homedir } from "os";
import { spawn } from "child_process";

// Canonicalize a link/session name: trim + collapse internal whitespace.
// Must match the extension's normalizeName (index.ts).
function normalizeName(s) {
  return s.trim().replace(/\s+/g, " ");
}

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
// status, and message count. Returns null when `scopeCwd` is given and the
// session's header names a different cwd.
//
// Name precedence: latest valid `link-name` custom entry wins as the
// authoritative pi-link name. `session_info.name` is only a fallback for
// sessions that never set a link-name. Historical link-names are not aliases.
//
// A scoped scan only ever keeps sessions from `scopeCwd`, so a session whose
// header names another cwd is abandoned there instead of being read to EOF for
// a name that would be filtered out anyway. Pi writes that header as the first
// complete line of the file, before any history.
//
// Only `undefined` means unscoped: a normalized scope is the empty string at
// POSIX root, which is a real scope and must not read as "no scope".
async function getSessionMeta(filePath, scopeCwd) {
  let linkName;
  let sessionName;
  let cwd;
  let id;
  let hasLinkName = false;
  let messages = 0;
  const input = createReadStream(filePath, "utf-8");
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "session") {
        if (typeof entry.cwd === "string") {
          if (scopeCwd !== undefined && normalizePath(entry.cwd) !== scopeCwd) {
            rl.close();
            input.destroy();
            return null;
          }
          cwd = entry.cwd;
        }
        if (typeof entry.id === "string") id = entry.id;
      } else if (entry.type === "session_info" && typeof entry.name === "string") {
        sessionName = normalizeName(entry.name) || undefined;
      } else if (entry.type === "custom" && entry.customType === "link-name") {
        hasLinkName = true;
        if (entry.data && typeof entry.data.name === "string") {
          const n = normalizeName(entry.data.name);
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

// What `--status` prints for a field the hub could not report. Declared here,
// above the dispatcher: the mode handlers are hoisted functions, but a `const`
// read from one would still be in its temporal dead zone when dispatch runs.
const UNKNOWN = "?";

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

async function loadSessionRecord(filePath, scopeCwd) {
  try {
    const meta = await getSessionMeta(filePath, scopeCwd);
    if (!meta) return null; // known-foreign: not even worth a stat
    const stats = await stat(filePath);
    return { ...meta, modified: stats.mtime, path: filePath };
  } catch {
    return null;
  }
}

// Returns meta + mtime + path for every readable session in `dir`, or only
// those from `scopeCwd` when it is given. Custom layout is flat
// (<dir>/*.jsonl); default layout has one subdir level per encoded cwd
// (<dir>/<sub>/*.jsonl). Errors on individual files/dirs are silently skipped
// — active or partially-written sessions are tolerated.
async function scanSessions(dir, isCustom, scopeCwd) {
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
      tasks.push(loadSessionRecord(join(dir, entry.name), scopeCwd));
    }
  } else {
    for (const sub of entries) {
      if (!sub.isDirectory()) continue;
      const subPath = join(dir, sub.name);
      let files;
      try { files = await readdir(subPath); } catch { continue; }
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        tasks.push(loadSessionRecord(join(subPath, file), scopeCwd));
      }
    }
  }

  return (await Promise.all(tasks)).filter((s) => s !== null);
}

// Find sessions whose current display name matches `targetName`, restricted to
// `scopeCwd` when given and searched across every cwd when not. Falls back to
// `session_info.name` for sessions without a link-name (so `pi-link <name>`
// can attach link to a previously-unlinked named session).
//
// The cwd predicate is applied here as well as in the scan: a session whose
// header carries no cwd is not rejected early, and must still be left out of a
// scoped result.
async function findSessionsByName(targetName, dir, isCustom, scopeCwd) {
  return (await scanSessions(dir, isCustom, scopeCwd))
    .filter((s) => s.name === targetName)
    .filter((s) => scopeCwd === undefined || (s.cwd && normalizePath(s.cwd) === scopeCwd))
    .map((s) => ({ path: s.path, cwd: s.cwd || "?", modified: s.modified }))
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

// List pi-link sessions (those with at least one link-name entry), restricted
// to `scopeCwd` when given and covering every cwd when not.
async function listSessions({ dir, isCustom, scopeCwd }) {
  return (await scanSessions(dir, isCustom, scopeCwd))
    .filter((s) => s.hasLinkName)
    .filter((s) => scopeCwd === undefined || (s.cwd && normalizePath(s.cwd) === scopeCwd))
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

// Reject Pi flags that pi-link manages, plus --link-name (which exists at the
// `pi` level for link-only naming, but the wrapper's combined-mode contract
// conflicts with it). Called from Phase 4 (mode entry) and Phase 5 (after
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
  console.error("       pi-link --status [--json]");
  console.error("       pi-link --resolve <name> [--global|-g]");
  console.error("       pi-link --version");
  console.error("");
  console.error("By default, name lookup is scoped to the current cwd.");
  console.error("--global / -g widens the search to sessions in any cwd.");
  console.error("--list reads saved sessions; --status asks the running hub who is connected.");
}

function printVersion() {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
    );
    console.log(pkg.version ?? "unknown");
  } catch {
    console.log("unknown");
  }
}

function describeMode(mode) {
  switch (mode) {
    case "help": return "--help";
    case "version": return "--version";
    case "list": return "--list";
    case "status": return "--status";
    case "resolve": return "--resolve";
    case "launcher": return "session name";
    default: return mode;
  }
}

// ── Parser ─────────────────────────────────────────────────────────────────
//
// Single sequential pass populates `state`; dispatcher reads it. Phases:
//   1. Global flags (--global, --help, --version, --json, --)
//   2. Mode-selecting flags (--list, --status, --resolve, --resolve=<name>)
//   3. Mode-specific extra-token rejection
//   4. Launcher mode entry (mode null + bare positional)
//   5. Launcher passthrough (mode launcher) with orphan-positional rejection

const state = {
  mode: null, // null | "help" | "version" | "list" | "status" | "resolve" | "launcher"
  resolveName: null,
  launcherName: null,
  global: false,
  json: false,
  piPassthrough: [],
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

  // Phase 1: global flags / scope-affecting tokens.
  if (a === "--global" || a === "-g") {
    state.global = true;
    lastWasFlag = false;
    continue;
  }
  if (a === "--help" || a === "-h") {
    setMode("help"); // errors if combined with another mode
    continue;
  }
  if (a === "--version") {
    setMode("version"); // errors if combined with another mode
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

  // `--json` modifies --status only. Claimed before a mode exists so order does
  // not matter, but never in launcher mode, where it belongs to pi.
  if (a === "--json" && (state.mode === null || state.mode === "status")) {
    state.json = true;
    continue;
  }

  // Phase 2: mode-selecting flags.
  if (a === "--list") {
    setMode("list");
    continue;
  }
  // Selects the wrapper's own mode only before a session name has been seen.
  // After that it is pi's flag, exactly like `--json` above — intercepting it
  // unconditionally would break `pi-link foo --status`.
  if (a === "--status" && state.mode !== "launcher") {
    setMode("status");
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

  // Phase 3: mode-specific extra-token rejection.
  if (state.mode === "help") {
    fail(`--help does not accept arguments: ${a}`);
  }
  if (state.mode === "version") {
    fail(`--version does not accept arguments: ${a}`);
  }
  if (state.mode === "list") {
    fail(`--list does not accept argument: ${a}\n  Usage: pi-link --list [--global|-g]`);
  }
  if (state.mode === "status") {
    fail(`--status does not accept arguments: ${a}\n  Usage: pi-link --status [--json]`);
  }
  if (state.mode === "resolve") {
    fail(`--resolve accepts exactly one name; got extra: ${a}`);
  }

  // Phase 4: launcher mode entry. state.mode === null here, no name set yet.
  // (lastWasFlag is still false here — only Phase 5 sets it, and Phase 5 requires launcher mode.)
  if (state.mode === null) {
    rejectManagedFlag(a);
    if (a.startsWith("-")) {
      fail(`Unknown argument: ${a}\n  Usage: pi-link <name> [--global|-g] [pi flags...]`);
    }
    if (a === "list" || a === "resolve") {
      fail(`'pi-link ${a}' was removed. Use 'pi-link --${a}'.`);
    }
    state.mode = "launcher";
    state.launcherName = a;
    continue;
  }

  // Phase 5: launcher mode, name set. Tokens go to passthrough or get rejected.
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
  const normalized = normalizeName(state.resolveName);
  if (!normalized) {
    fail(`--resolve requires a non-empty name argument.\n  Usage: pi-link --resolve <name> [--global|-g]`);
  }
  state.resolveName = normalized;
}
// `--status` reads one running hub, so a cwd scope is meaningless rather than
// merely unused: silently ignoring `-g` would imply a filter that cannot exist.
if (state.mode === "status" && state.global) {
  fail(`cannot combine --status and --global`);
}
if (state.json && state.mode !== "status") {
  fail(`--json is only valid with --status`);
}
if (state.mode === "launcher") {
  const normalized = normalizeName(state.launcherName);
  if (!normalized) {
    fail(`session name cannot be empty.\n  Usage: pi-link <name> [--global|-g] [pi flags...]`);
  }
  state.launcherName = normalized;
}

// ── Dispatch ───────────────────────────────────────────────────────────────

switch (state.mode) {
  case null:
  case "help":
    printHelp();
    process.exit(0);
    break; // unreachable; present to satisfy no-fallthrough lints
  case "version":
    printVersion();
    process.exit(0);
    break; // unreachable; present to satisfy no-fallthrough lints
  case "list":
    await runList(state);
    break;
  case "status":
    await runStatus(state);
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

// A local operation scans only its own cwd; `--global` scans every cwd.
function localScope(state) {
  return state.global ? undefined : normalizePath(process.cwd());
}

async function runList(state) {
  const { dir, isCustom } = resolveSessionDir(process.cwd(), resolveAgentDir());
  const sessions = await listSessions({ dir, isCustom, scopeCwd: localScope(state) });
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

// ── Status (live hub query) ────────────────────────────────────────────────
//
// `--list` reads saved history; `--status` asks the hub who is connected now.
// The two answer different questions, so they share no code path.

// Mirrors the extension's formatTokens so both renderings of one number agree.
function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}K`;
  return `${n}`;
}

// `92K/272K (34%)`, or `?/272K` when the hub has a window but no token count.
// Only reached for a validated payload, so `c` is null or a well-typed snapshot;
// a non-positive window is still possible and still means nothing to report.
function formatContext(c) {
  if (!c || c.window <= 0) return UNKNOWN;
  const window = formatTokens(c.window);
  if (typeof c.tokens !== "number") return `${UNKNOWN}/${window}`;
  return `${formatTokens(c.tokens)}/${window} (${Math.round((c.tokens / c.window) * 100)}%)`;
}

function formatAge(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

// `status` and `sinceSeconds` are an optional pair: the hub omits them for a
// terminal it has registered but not yet heard from. Absence means unknown, so
// it must render as unknown — printing `idle` there would be an invention, and
// acting on it is the misreporting this command exists to end.
function formatTerminalStatus(entry) {
  if (typeof entry.status !== "string") return UNKNOWN;
  return `${entry.status} (${formatAge(entry.sinceSeconds)})`;
}

function failUnsupported() {
  console.error("Link hub does not support /status \u2014 update pi-link and restart terminals.");
  process.exit(1);
}

function failNoHub(port) {
  console.error(`No link hub running on :${port}.`);
  process.exit(2);
}

// The fields the table reads, checked before any of them is read. A body that
// lacks them or mistypes them — a different service, a truncated proxy, a newer
// hub gone incompatible — must produce the unsupported message, never a stack
// trace. Passing says the rows can be printed, nothing more: what the CLI never
// prints it never checks, so the hub's payload invariants, and whether a hub sent
// this at all, are not established here.
function isContextField(c) {
  if (c === null) return true;
  if (!c || typeof c !== "object") return false;
  return (c.tokens === null || typeof c.tokens === "number") && typeof c.window === "number";
}

function isTerminalEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  if (typeof entry.name !== "string") return false;
  // `status` and `sinceSeconds` are one optional pair: both or neither.
  //
  // The value is checked for shape, not vocabulary. `idle`/`thinking`/
  // `compacting`/`tool:<name>` are today's kinds, but that set has already grown
  // once (`compacting`, in 0.3.0) and the CLI never branches on it — it
  // only prints it. Freezing the list here would make a newer hub's fifth kind
  // reject the whole payload, and only while some terminal happened to be in that
  // state: an intermittent failure telling the user to update. An empty string is
  // still rejected, because it renders as a blank cell with a bare duration.
  const hasStatus = "status" in entry;
  if (hasStatus !== ("sinceSeconds" in entry)) return false;
  if (hasStatus && (typeof entry.status !== "string" || entry.status === "" || typeof entry.sinceSeconds !== "number")) {
    return false;
  }
  if ("cwd" in entry && typeof entry.cwd !== "string") return false;
  return "context" in entry && isContextField(entry.context);
}

function isStatusPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  return Array.isArray(payload.terminals) && payload.terminals.every((e) => isTerminalEntry(e));
}

async function runStatus(state) {
  // Deliberately unvalidated: a bad value fails the fetch and is reported with
  // the port in the message, which is the diagnosis.
  const port = process.env.PI_LINK_PORT ?? 9900;
  // One deadline covers the whole exchange, headers and body alike, so it has to
  // be readable afterwards to tell a timeout from a malformed answer.
  const deadline = AbortSignal.timeout(2000);
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/status`, { signal: deadline });
  } catch {
    // Refused, unreachable or timed out: no hub is answering at this instant.
    failNoHub(port);
  }

  if (!response.ok) failUnsupported();

  let body;
  try {
    body = await response.text();
  } catch {
    // A listener that sends headers and then stalls is still an unanswered
    // query, not an old hub: every timeout reports as "no hub".
    if (deadline.aborted) failNoHub(port);
    failUnsupported();
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    failUnsupported();
  }
  if (!isStatusPayload(payload)) failUnsupported();

  if (state.json) {
    process.stdout.write(body);
    return;
  }

  console.log(
    renderTable(payload.terminals, [
      { header: "NAME", get: (e) => e.name },
      { header: "STATUS", get: (e) => formatTerminalStatus(e) },
      { header: "CONTEXT", get: (e) => formatContext(e.context) },
      { header: "CWD", get: (e) => (e.cwd ? displayPath(e.cwd) : UNKNOWN), dim: true },
    ]),
  );
}

async function runResolve(state) {
  const name = state.resolveName; // already normalized
  const { dir, isCustom } = resolveSessionDir(process.cwd(), resolveAgentDir());
  const matches = await findSessionsByName(name, dir, isCustom, localScope(state));
  if (matches.length === 1) {
    process.stdout.write(matches[0].path);
    return; // exit 0
  }
  if (matches.length > 1) {
    printCandidates(name, matches); // exits 1
  }
  // matches.length === 0 → not found; exit 2 to distinguish from ambiguous.
  // A local scan never reads names from other cwds, so the advice is offered
  // without claiming anything is there.
  console.error(`No session named "${name}" found${state.global ? "" : " in this cwd"}.`);
  if (!state.global) console.error("Use --global to search other cwds.");
  process.exit(2);
}

async function runLauncher(state) {
  const name = state.launcherName; // already normalized
  const { dir, isCustom } = resolveSessionDir(process.cwd(), resolveAgentDir());
  const matches = await findSessionsByName(name, dir, isCustom, localScope(state));
  if (matches.length > 1) {
    printCandidates(name, matches);
  }

  const piArgs = [];
  if (matches.length === 1) {
    console.error(`Resuming session: ${matches[0].path}`);
    piArgs.push("--session", matches[0].path);
  } else {
    if (!state.global) {
      console.error(`No "${name}" found in this cwd. Use --global to search other cwds.`);
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
