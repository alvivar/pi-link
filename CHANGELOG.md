# Changelog

All notable changes to pi-link are documented here.

This changelog is based on the git history from `2026-03-21` (initial commit) through the present. Versions correspond to npm publishes.

---

## 0.1.9 — 2026-04-22

### Added

- **`--link-name <name>` flag.** Connect to link with a chosen terminal name on startup. Implies `--link`. Persists the name, sets the Pi session name if currently unnamed, and resumes an existing session with that name if one exists. Name precedence: `--link-name` > saved `/link-name` > session name > random `t-xxxx`. Session resume is handled by the bundled `pi-link start` helper (`bin/pi-link.mjs`), since Pi's `--session` flag requires a path, not a display name.

---

## 0.1.8 — 2026-04-16

### Added

- **Idle-gated batched delivery for `triggerTurn:true`.** `link_send` with `triggerTurn:true` no longer calls `pi.sendMessage()` immediately. Messages queue in a local inbox, coalesce over a 200ms debounce window, and flush only when the receiver is idle (`ctx.isIdle()`). Delivered as a single `[Link: N message(s) received]` block at the start of a fresh turn. Avoids a Pi platform race where mid-run steering messages can be stranded. `triggerTurn:false` is unchanged (immediate fire-and-forget). (`82977ec`, `ca2996b`)

- **Session name as default terminal identity.** When no explicit `/link-name` is saved for a session, the terminal now adopts the Pi session name instead of a random `t-xxxx` ID. The session name is used at runtime only — it is not saved as `preferredName`, so only explicit `/link-name` calls persist across sessions.

### Changed

- **Removed per-item truncation, raised batch cap.** Deleted the `ITEM_MAX_CHARS` (2 000) constant — it was silently cutting real agent work mid-word. `BATCH_MAX_CHARS` raised from 8 000 → 16 000 (~4K tokens). The batch cap is a soft limit: the first item is always included even if oversized, so one large message fills the batch alone and defers others to the next flush.

### Fixed

- **`flushInbox()` used `pi.isIdle()` instead of `ctx.isIdle()`.** `isIdle()` lives on `ExtensionContext`, not `ExtensionAPI`. Fixed to use the stored `ctx`.

---

## 0.1.7 — 2026-04-09

### Added

- **Bundled `pi-link-coordination` skill.** The coordination guide is now shipped with the package via `pi.skills` manifest entry. Installing pi-link now auto-loads the skill — no manual copy required. The skill provides on-demand guidance for agents delegating work across terminals: tool selection (`link_prompt` vs `link_send`), the golden rule (no sync-after-async on same target), callback contracts, and coordination modes.

---

## 0.1.6 — 2026-04-03

**Pi 0.65.0 migration.** Pi removed `session_switch` and `session_fork` events. All session transitions (startup, reload, `/new`, `/resume`, `/fork`) now fire `session_start` with `event.reason`. Each transition tears down the old extension runtime via `session_shutdown` before creating a fresh one — so there is no live connection to update in-place across sessions.

### Added

- **Persistent connection intent.** `/link-connect` and `/link-disconnect` now save their state to the session via `pi.appendEntry("link-active", ...)`. On `session_start`, the saved preference is checked before falling back to `--link`. Connect once and it stays connected across session resumes without needing the flag. Explicit user intent (`link-active`) takes precedence over the `--link` flag default.

### Removed

- **`cwd_update` message type.** With the old `session_switch` gone, mid-session cwd changes have no trigger. Working directories are now only reported on connect (via `register`/`welcome`). Protocol returns to 9 message types.

- **`session_switch` handler.** The 77-line in-place mutation matrix (hub rename, cwd diffing, client reconnect) is dead under the new lifecycle. Replaced by a unified `session_start` handler + `shouldConnect()` helper.

---

## 0.1.5 — 2026-04-02

### Added

- **Working directory sharing.** Each terminal reports its `cwd` on connect and on session switch. New `cwd_update` protocol message (10th message type) broadcasts mid-session directory changes. `link_list` and `/link` now show per-terminal working directories — full absolute paths in tool output, `~/…` shortened in the TUI. Agents can use this to choose the right target, use explicit paths when terminals differ, and catch wrong-project mistakes early.

- **Header comment cleanup.** Simplified the top-of-file doc comment — removed feature bullet list and install instructions in favor of a concise summary.

---

## 0.1.4 — 2026-03-30

### Added

- **Heartbeat-based prompt timeout.** `link_prompt` no longer uses a fixed 2-minute timeout. The target sends keepalives every 30s while working (reusing `status_update`). The sender resets a 90-second inactivity timer on each keepalive. A 30-minute hard ceiling prevents broken-but-chatty targets from hanging forever. Long tasks with regular activity no longer false-timeout. (`fc73a00`, `5603f0d`)

- **Self-target rejection.** `link_prompt` immediately rejects prompts where `to` equals your own terminal name, instead of sending a round-trip that would fail. (`0086c04`)

- **Immediate failure on disconnect.** Pending `link_prompt` calls fail instantly when the target terminal leaves the network (`terminal_left`), instead of waiting for the inactivity timeout. (`0086c04`)

- **`cleanupPending()` helper.** Single authority for resolving pending prompt state — all paths (response, inactivity, ceiling, abort, disconnect, delivery failure) go through one function, preventing double-resolution races. (`fc73a00`)

---

## 0.1.3 — 2026-03-26

### Added

- **Persistent link names.** `/link-name` saves your preferred name to the session via `pi.appendEntry()`. Resume a session and your name is restored automatically. Session switches (`/resume`) restore the new session's preferred name. Only explicit `/link-name` calls persist — hub-assigned variants like `"builder-2"` are not saved. (`369cf5d`)

### Fixed

- **Self join/leave echoes suppressed.** Hub no longer sends `terminal_joined`/`terminal_left` back to the terminal that triggered the event (e.g., during renames). Previously, renaming on the hub would echo a leave/join pair back to yourself. (`45cb018`)

- **Pre-flight target validation for `link_prompt`.** The sender now checks if the target exists in the local terminal list before sending, returning an immediate error with the current terminal list instead of waiting for a timeout. (`45cb018`)

---

## 0.1.2 — 2026-03-24

### Added

- **Automatic agent status.** Each terminal's activity status is derived from Pi lifecycle events and broadcast across the link. Three states: `idle`, `thinking`, `tool:<name>` — each with a duration computed at render time. New `status_update` protocol message (push model: terminal → hub → all). New joiners receive a status snapshot in the `welcome` message. (`454415a`)

- `/link` and `link_list` now show per-terminal status alongside names.

---

## 0.1.1 — 2026-03-22

### Changed

- **Published to npm.** Install command changed from `pi install git:github.com/alvivar/pi-mesh` to `pi install npm:pi-link`. (`87b394f`, `ed1e6cf`)

---

## 0.1.0 — 2026-03-22

First npm publish. Renamed from `pi-mesh` to `pi-link`. (`57bda8b`)

Everything below shipped together as the initial release.

### Core

- **Hub-spoke WebSocket network** on `127.0.0.1:9900`. First terminal becomes the hub; others connect as clients. All messages route through the hub. (`c239a9e`)

- **Auto-discovery protocol.** Try client → fallback to hub → retry with 2–5s randomized backoff on race conditions. (`c239a9e`)

- **Hub promotion.** When the hub goes down, the first client to reconnect becomes the new hub (race-based, no leader election). (`c239a9e`)

### Tools

- **`link_send`** — fire-and-forget message to a specific terminal or `"*"` for broadcast. Optional `triggerTurn` to kick off the remote LLM via `deliverAs: "steer"`. (`c239a9e`)

- **`link_prompt`** — synchronous RPC: send a prompt to a remote terminal, wait for the LLM's response. Single-queue per terminal (immediate `"Terminal is busy"` rejection, no queuing). 2-minute fixed timeout at this version. (`c239a9e`)

- **`link_list`** — list connected terminals with role info and self-identification. (`c239a9e`)

### Commands

- **`/link`** — show link status (name, role, online count). (`c239a9e`)
- **`/link-name [name]`** — rename this terminal. No-arg form adopts the Pi session name. (`c239a9e`, `2fd67c7`)
- **`/link-broadcast <msg>`** — broadcast a chat message to all other terminals. (`c0bf65a`)
- **`/link-connect`** — connect mid-session without `--link` flag. Enables auto-reconnect. (`a2a0eac`)
- **`/link-disconnect`** — disconnect and suppress auto-reconnect, even if `--link` was passed. (`a2a0eac`)

### Opt-in startup

- **`--link` flag.** Link is off by default — completely silent without the flag. No status bar, no connection attempts, no warnings. (`48d7e97`)

### Protocol hardening (pre-release)

These fixes shipped before 0.1.0 but are worth noting as they shaped the protocol:

- **Early failure on missing targets.** Hub sends `prompt_response` with error for unknown targets, so the sender's promise resolves immediately instead of timing out. (`da38f62`)
- **Delivery status from routing.** `routeMessage()` returns a boolean — authoritative on the hub, optimistic on clients. (`a29fefc`)
- **Unique name enforcement.** Hub deduplicates names (`builder` → `builder-2`). Renames check for collisions. No-op renames short-circuit. (`84d2b68`, `1207647`)
- **Unregistered client guard.** Hub ignores all non-`register` messages from clients that haven't completed registration. (`679f25f`)
- **Session names as defaults.** Terminals use the Pi session name as their default link identity when available. (`2fd67c7`)
