#!/usr/bin/env node

// pi-link CLI — resolve session by name and launch Pi with --link-name
//
// Usage:
//   pi-link start <name> [pi-flags...]
//
// If a session named <name> exists, resumes it.
// If not, creates a new session.
// Always connects to the link as <name>.

import { readdir, stat } from "fs/promises";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { join } from "path";
import { homedir } from "os";
import { spawn } from "child_process";

const SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");

// ── Session scanning ───────────────────────────────────────────────────────

async function getSessionName(filePath) {
  let name;
  let cwd;
  const rl = createInterface({ input: createReadStream(filePath, "utf-8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "session" && entry.cwd) cwd = entry.cwd;
      if (entry.type === "session_info" && entry.name !== undefined) {
        name = entry.name?.trim() || undefined;
      }
    } catch {
      // skip malformed lines
    }
  }
  return { name, cwd };
}

async function findSessionsByName(targetName) {
  let cwdDirs;
  try {
    cwdDirs = await readdir(SESSIONS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const matches = [];

  for (const dir of cwdDirs) {
    if (!dir.isDirectory()) continue;
    const dirPath = join(SESSIONS_DIR, dir.name);

    let files;
    try {
      files = await readdir(dirPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = join(dirPath, file);
      try {
        const { name, cwd } = await getSessionName(filePath);
        if (name === targetName) {
          const stats = await stat(filePath);
          matches.push({ path: filePath, cwd: cwd || "?", modified: stats.mtime });
        }
      } catch {
        continue;
      }
    }
  }

  // Local-first: current cwd matches before others, then by modified time
  const localCwd = process.cwd();
  matches.sort((a, b) => {
    const aLocal = a.cwd === localCwd ? 1 : 0;
    const bLocal = b.cwd === localCwd ? 1 : 0;
    if (aLocal !== bLocal) return bLocal - aLocal;
    return b.modified.getTime() - a.modified.getTime();
  });
  return matches;
}

// ── CLI ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

if (command !== "start" || args.length < 2) {
  console.log(`Usage: pi-link start <name> [pi-flags...]

Start Pi connected to the link as <name>.
Resumes a session named <name> if one exists, otherwise creates a new session.

Examples:
  pi-link start worker-1
  pi-link start worker-1 --model sonnet
  pi-link start worker-1 --model sonnet --thinking high`);
  process.exit(command === "start" ? 1 : 0);
}

const name = args[1].trim().replace(/\s+/g, " ");
if (!name) {
  console.error("Error: name cannot be empty.");
  process.exit(1);
}

const extraFlags = args.slice(2);
for (const flag of ["--session", "--link-name"]) {
  if (extraFlags.includes(flag)) {
    console.error(`Error: ${flag} is managed by pi-link start. Remove it.`);
    process.exit(1);
  }
}

console.log(`Searching for session "${name}"...`);
const matches = await findSessionsByName(name);

const piArgs = [];

if (matches.length === 1) {
  console.log(`Resuming session: ${matches[0].path}`);
  piArgs.push("--session", matches[0].path);
} else if (matches.length > 1) {
  console.error(`\nMultiple sessions named "${name}":\n`);
  for (const m of matches) {
    console.error(`  ${m.modified.toISOString().slice(0, 19)}  cwd: ${m.cwd}`);
    console.error(`  ${m.path}\n`);
  }
  console.error(`Use pi --session <path> --link-name ${name} to pick one.`);
  process.exit(1);
} else {
  console.log("No existing session found. Starting new session.");
}

piArgs.push("--link-name", name, ...extraFlags);

// On Windows, resolve 'pi' through the shell so .cmd/.ps1 shims work
const isWin = process.platform === "win32";
const cmd = isWin ? "cmd" : "pi";
const cmdArgs = isWin ? ["/c", "pi", ...piArgs] : piArgs;

const child = spawn(cmd, cmdArgs, { stdio: "inherit" });

child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error(`Failed to start pi: ${err.message}`);
  process.exit(1);
});
