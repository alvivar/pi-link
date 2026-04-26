#!/usr/bin/env node

// pi-link CLI — launch Pi with session resume by name
//
// Usage:
//   pi-link <name> [flags...]   Resume or create a named session, connected to link.
//   pi-link resolve <name>      Print just the session path (machine-readable).

import { readdir, stat } from "fs/promises";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { join } from "path";
import { homedir } from "os";
import { spawn } from "child_process";

const SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");

async function getSessionMeta(filePath) {
  let name;
  let cwd;
  const rl = createInterface({ input: createReadStream(filePath, "utf-8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "session" && typeof entry.cwd === "string") cwd = entry.cwd;
      if (entry.type === "session_info" && typeof entry.name === "string") {
        name = entry.name.trim().replace(/\s+/g, " ") || undefined;
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
        const { name, cwd } = await getSessionMeta(filePath);
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

if (command === "resolve") {
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
  console.error("Usage: pi-link <name> [pi flags...]\n       pi-link resolve <name>");
  process.exit(0);
}
