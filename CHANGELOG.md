# Changelog

All notable changes to pi-link are documented here.

This changelog is based on the git history from `2026-03-21` (initial commit as `pi-mesh`) through `2026-03-30` (current). Versions correspond to npm publishes.

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
