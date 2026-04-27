---
name: pi-link-coordination
description: Guidance for coordinating work across Pi terminals using pi-link. Use when delegating tasks, choosing between link_prompt and link_send, planning async vs sync work, batching parallel jobs, or avoiding busy/conflict patterns.
---

# Pi-Link Coordination

How to coordinate work across Pi terminals via pi-link.

---

## Tool Selection Rule

- Need the answer back now? → `link_prompt`
- Need autonomous work done? → `link_send(triggerTurn: true)`
- Need to notify only? → `link_send(triggerTurn: false)`

---

## The Golden Rule

> After `link_send(triggerTurn: true)` to terminal X, do not `link_prompt` X until X sends a completion callback.

Pick one mode per terminal per task. Mixing sync and async on the same terminal is the most common coordination failure.

---

## The Tools

### `link_list`

Returns connected terminals with names, live status (`idle`, `thinking`, `tool:<name>`), and working directory (cwd). Use before delegating when availability or path context is uncertain. Your own entry is marked `(you)` — use this to discover your link name when replying to broadcast tasks.

Only currently connected terminals are visible. If a target is missing, it is offline; messages to offline terminals are not queued.

### `link_prompt`

Synchronous RPC. Send a prompt, wait for the response.

- Fails immediately if target is missing, self, disconnects, or busy (local work or another remote prompt)
- 90s inactivity timeout, 30min hard ceiling
- Remote agent doesn't share your context — prompts must be self-contained
- Include: goal, scope, constraints, output format, done condition

### `link_send`

Fire-and-forget. Send to one terminal or `to: "*"` to broadcast (excludes sender).

Set `triggerTurn: true` to queue async work on the receiver. Delivery happens at turn boundaries: pending messages are batched and surface together when the receiver next becomes idle. The sender does **not** get the response back.

Batched callback shape: `[Link: N message(s) received]` then one or more `From "name":` / `content` blocks.

**Callback contract for `triggerTurn: true`:** ask the receiver to reply via `link_send` with:

- `DONE` / `BLOCKED`
- Output paths / artifacts created
- Short result summary or next question

Keep callbacks concise. Put long details in files and return the paths.

---

## Operating Constraints

- **One remote prompt at a time per target.** Concurrent requests rejected as busy.
- **No shared context.** Every remote prompt must be self-contained.
- **Messages are ephemeral.** Offline terminals lose messages.
- **Localhost only.** Same machine.
- **Cwd is a hint, not proof.** Same cwd ≠ same workspace/branch/access. Use explicit paths; absolute when cwds differ or shared-root assumptions are unclear.
- **Naming:** `role@domain` (e.g., `builder@pi-link`). Only talk to your own domain unless told otherwise.

---

## Coordination Modes

### Sync ask — `link_prompt`

For answers, review, analysis you need back now. One terminal at a time. Keep scope focused to avoid timeout.

### Async delegate — `link_send(triggerTurn: true)`

For autonomous work. Require the callback contract (DONE/BLOCKED + paths + short summary). Do your own work in parallel. Expect the callback at a turn boundary, possibly batched with others. Don't `link_prompt` the target until the callback arrives.

### Parallel batch — async to multiple terminals

Distribute independent tasks. Worker callbacks may return together in one batched turn when you become idle. Use explicit paths (absolute if cwds differ), require short callbacks + artifact paths, wait for all callbacks, then synthesize. Don't prompt any dispatched terminal until its callback arrives.

---

## Anti-Patterns

**❌ Mixing async and sync on the same terminal**
Dispatched with `link_send(triggerTurn: true)` then sent a `link_prompt` → rejected as busy. See Golden Rule.

**❌ Using `link_send` when you need the response now**
No direct response comes back to the sender. Use `link_prompt` when you need the answer in the same turn.

**❌ Vague prompts**
"Fix the bug" is useless. Include file, line, root cause, expected fix.

**❌ No completion callback on async work**
Always require DONE/BLOCKED + artifact paths + short summary.

**❌ Circular delegation**
A → B → C → A = deadlock. Maintain clear hierarchy.

**❌ Skipping `link_list` before retrying a busy target**
Check status before re-sending.

**❌ Long async callbacks**
Long callbacks crowd a whole batched turn. Ask workers to write detailed output to files and return paths + short summaries.

---

## Quick Reference

| I need to...                     | Tool                            | Mode            |
| -------------------------------- | ------------------------------- | --------------- |
| See who's available              | `link_list`                     | —               |
| Get an answer from another agent | `link_prompt`                   | Synchronous     |
| Delegate autonomous work         | `link_send(triggerTurn: true)`  | Asynchronous    |
| Notify without activating        | `link_send(triggerTurn: false)` | Fire-and-forget |
| Broadcast to all                 | `link_send(to: "*")`            | Broadcast       |
