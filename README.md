# pi-link

A WebSocket-based inter-terminal communication system that creates a local network between multiple Pi coding agent terminals. Enables terminals to discover each other, exchange messages, and orchestrate work across agents — all automatically on `localhost`.

> Self-contained TypeScript in a single `index.ts` file. Start Pi with `--link` to enable.

---

## Table of Contents

- [Why?](#why)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Walkthrough](#walkthrough)
- [Configuration](#configuration)
- [LLM Tools](#llm-tools)
- [Slash Commands](#slash-commands)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)
- [Limitations & Design Decisions](#limitations--design-decisions)
- [Dependencies](#dependencies)
- [Internals](#internals)

---

## Why?

A single Pi terminal is powerful. Multiple terminals working together unlock new patterns:

- **Research + Build** — one terminal investigates APIs, docs, or logs while another writes code based on the findings.
- **Fan-out** — split a large task across agents (e.g., "terminal A handles the backend, terminal B handles the frontend") and collect results.
- **Orchestrator / Worker** — designate one terminal as a coordinator that delegates subtasks to others via `link_prompt` and assembles the final output.
- **Review pipeline** — one terminal writes code, another reviews it, back and forth until both are satisfied.

---

## Prerequisites

- [Pi coding agent](https://github.com/nicholasgasior/pi-coding-agent) installed and working
- Node.js (LTS recommended)

---

## Quick Start

### Install

```bash
pi install npm:pi-link
```

### Uninstall

```bash
pi uninstall npm:pi-link
```

### Usage

Link is **off by default**. Start Pi with the `--link` flag to auto-connect on startup:

```
Terminal 1                            Terminal 2
----------                            ----------
$ pi --link                           $ pi --link
✓ Link hub on :9900 as "t-a1b2"      ✓ Joined link as "t-c3d4" (2 online)
```

Already in a session without `--link`? You can connect mid-session with `/link-connect`.

Use `/link` in any terminal to check status, or let the LLM tools handle cross-terminal coordination.

---

## Walkthrough

Here's a concrete example of two terminals collaborating. Open two separate `pi --link` sessions.

**Terminal 1** — rename and check status:

```
> /link-name builder
✓ Renamed to "builder"

> /link
⚡ Link: "builder" (hub) · 2 terminals online: builder, researcher
```

**Terminal 2** — rename it too:

```
> /link-name researcher
✓ Reconnecting as "researcher" (hub may assign a different name if taken)...
```

**Now ask Terminal 1's LLM to delegate work:**

In Terminal 1, type a normal prompt:

```
> Use link_prompt to ask "researcher" to summarize the contents of README.md in this directory
```

The LLM in Terminal 1 calls `link_prompt` → Terminal 2's LLM receives the prompt, reads the file, and sends back a summary → Terminal 1's LLM presents the result to you.

**Or broadcast a message to all terminals:**

```
> /link-broadcast starting the deployment pipeline
✓ Broadcast sent
```

Every other terminal sees:

```
⚡ [builder] starting the deployment pipeline
```

---

## Configuration

Link is **off by default**. Without `--link`, the extension is completely silent — no status bar, no connections, no warnings.

| Method              | When                                | Auto-reconnect? |
| ------------------- | ----------------------------------- | --- |
| `pi --link`         | Auto-connect on startup             | Yes |
| `/link-connect`     | Opt-in mid-session (no flag needed) | Yes |
| `/link-disconnect`  | Opt-out mid-session                 | Suppressed until `/link-connect` |

`/link-connect` enables full participation in Pi Link regardless of whether `--link` was passed. `/link-disconnect` always wins — even over `--link` — until you explicitly `/link-connect` again.

Once connected, terminals discover each other on `127.0.0.1:9900`. See [Limitations](#limitations--design-decisions) for the hardcoded port.

---

## LLM Tools

The extension registers three tools that the LLM can invoke during agent runs.

### Which tool should I use?

| Tool           | Behavior                                             | Returns                                  |
| -------------- | ---------------------------------------------------- | ---------------------------------------- |
| `link_send`    | Send a message; optionally trigger the remote LLM    | Send/delivery status only                |
| `link_prompt`  | Run a prompt on a remote terminal and wait for reply | The remote terminal's assistant response |
| `link_list`    | List currently connected terminals                   | Terminal directory with roles            |

**If you need the other terminal's answer back, use `link_prompt`.** Use `link_send` to notify or steer without waiting.

### `link_send`

Send a fire-and-forget chat message to a specific terminal or broadcast to all.

| Parameter     | Type      | Description                                          |
| ------------- | --------- | ---------------------------------------------------- |
| `to`          | `string`  | Target terminal name, or `"*"` for broadcast         |
| `message`     | `string`  | Message content                                      |
| `triggerTurn` | `boolean` | If `true`, the receiver's LLM responds automatically |

When `triggerTurn` is enabled, the message is delivered via `pi.sendMessage` with `deliverAs: "steer"`, causing the remote agent to kick off an LLM turn. Note: `triggerTurn` does **not** cause the response to come back to the caller — use `link_prompt` for that.

> **Broadcast note:** Sending to `"*"` delivers to **all other terminals** — the sender is excluded.

Pre-validates the target name against the local terminal list before sending, catching typos early. On the hub, delivery confirmation is authoritative. On clients, delivery is optimistic — the message is sent to the hub for routing.

### `link_prompt`

Send a prompt to a remote terminal and **wait** for the LLM's response (synchronous RPC pattern).

| Parameter | Type     | Description          |
| --------- | -------- | -------------------- |
| `to`      | `string` | Target terminal name |
| `prompt`  | `string` | Prompt text to send  |

- The remote terminal processes the prompt via `pi.sendUserMessage()` — as if a user typed it.
- Returns the remote terminal's actual assistant reply text as the tool result.
- **2-minute timeout**; supports abort signals.
- **Early failure detection** — if the message can't be delivered (e.g., target not found), the tool resolves immediately with an error instead of waiting for the timeout.
- Targets **one terminal at a time** (no broadcast mode).
- Only **one remote prompt** can execute at a time per target terminal. Concurrent requests are rejected with `"Terminal is busy"`.

### `link_list`

Lists all connected terminals with role info and self-identification. Takes no parameters.

**Example output:**

```
Connected terminals:
  • pi-1 (you)
  • pi-2
  • pi-3
```

---

## Slash Commands

| Command                  | Purpose                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `/link`                  | Show link status (name, role, online count)                                                               |
| `/link-name [name]`      | Rename this terminal. With no argument, adopts the current Pi session name if available. Collision-safe.  |
| `/link-broadcast <msg>`  | Broadcast a chat message to all other terminals                                                           |
| `/link-connect`          | Connect to Pi Link (works anytime, with or without `--link`)                                              |
| `/link-disconnect`       | Disconnect from Pi Link and suppress auto-reconnect (overrides `--link`)                                  |

### Examples

```
> /link
⚡ Link: "builder" (hub) · 3 online: builder, worker-1, worker-2

> /link-name orchestrator
✓ Renamed to "orchestrator"

> /link-name
✓ Renamed to "my-session"          (adopts Pi session name)

> /link-broadcast starting the build pipeline
✓ Broadcast sent

> /link-disconnect
✓ Disconnected from Pi Link

> /link-connect
✓ Joined Pi Link as "orchestrator" (3 online)    ... or ...
✓ Pi Link hub started on :9900 as "orchestrator" ... if no hub exists
```

See [Configuration](#configuration) for details on `--link`, `/link-connect`, and `/link-disconnect` behavior.

---

## Architecture

### Hub-Spoke Topology

The network topology is **hub-spoke (star)**:

```
                       +-----------+
                       |    Hub    |
                       |   :9900   |
                       +-----+-----+
                             |
              +--------------+--------------+
              |              |              |
          +---+---+      +---+---+      +---+---+
          | pi-2  |      | pi-3  |      | pi-4  |
          |client |      |client |      |client |
          +-------+      +-------+      +-------+
```

- The **first terminal** to start becomes the **hub** — it runs a `WebSocketServer` on `127.0.0.1:9900`.
- **Subsequent terminals** connect as **clients** via plain WebSocket.
- All messages route **through the hub**; clients never talk directly to each other.

### Auto-Discovery Protocol

The discovery sequence runs on startup (with `--link`) or when `/link-connect` is used. See [Configuration](#configuration) for details.

The sequence is a simple fallback:

1. Attempt to connect as a **client** to `127.0.0.1:9900`.
2. If connection fails → become the **hub** (start a WebSocket server on that port).
3. If both fail (rare race condition) → retry after a randomized 2–5 second backoff.

### Hub Promotion

When the hub disconnects, clients detect the WebSocket close event, enter `"disconnected"` state, and call `scheduleReconnect()`. The **first terminal to retry** becomes the new hub via the same initialize-or-fallback flow.

There is **no explicit leader election** — promotion is race-based.

---

## Troubleshooting

### Port 9900 is already in use

If another process occupies port 9900, the terminal can't become the hub. It will attempt to connect as a client instead (which also fails if there's no real hub), then retry after 2–5 seconds. Free the port or modify `DEFAULT_PORT` in `index.ts` — see [Limitations](#limitations--design-decisions).

### "Terminal is busy" rejections

Each terminal can only execute **one remote prompt at a time**. If a `link_prompt` arrives while the agent is already running (either from a local user or another remote prompt), it's immediately rejected with `"Terminal is busy"`. There is no queuing. Solutions:

- Wait for the target terminal to finish its current task.
- Spread prompts across multiple worker terminals.
- Have the sender retry after a delay.

### Terminals don't see each other

- Verify both terminals are on the same machine (the link only works on `127.0.0.1`).
- Run `/link` in each terminal to check status.
- Ensure port 9900 isn't blocked or occupied by a non-link process.

### Hub promotion loses state

When the hub goes down and a client promotes itself, terminal names and in-flight prompts from the old hub session are lost. All surviving clients reconnect and re-register. This is by design — see [Limitations](#limitations--design-decisions).

---

## Limitations & Design Decisions

| #   | Decision                                  | Rationale / Impact                                                                                                                                            |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **No authentication**                     | Any localhost process can connect to port 9900. Acceptable for local dev; don't expose the port externally.                                                   |
| 2   | **Hardcoded port (9900)**                 | Not configurable without editing `DEFAULT_PORT` in `index.ts`. Could conflict with other services on the same port.                                           |
| 3   | **Race-based hub promotion**              | Non-deterministic. Terminal state (names, in-flight prompts) is lost during promotion. Simple but imperfect.                                                  |
| 4   | **Single remote prompt per terminal**     | No queuing — immediate rejection if the target is busy. Keeps the model simple and avoids unbounded backlogs.                                                 |
| 5   | **No message persistence**                | Purely ephemeral WebSocket frames. Messages are lost if the recipient is offline.                                                                             |
| 6   | **Client rename triggers full reconnect** | Changing a client's name requires a new `register` message, so the client disconnects and reconnects. Hub renames are handled in-place with collision checks. |
| 7   | **Single-machine / localhost-only**       | Link only binds to `127.0.0.1`; terminals on different machines cannot join.                                                                                  |
| 8   | **Opt-in startup**                        | Link is off by default. Use `pi --link` or `/link-connect` to participate. See [Configuration](#configuration).                                               |

---

## Dependencies

### Runtime (installed by `pi install`)

| Package | Version | Purpose                             |
| ------- | ------- | ----------------------------------- |
| `ws`    | ^8.20.0 | WebSocket library (server + client) |

### Development

| Package     | Version | Purpose                     |
| ----------- | ------- | --------------------------- |
| `@types/ws` | ^8.18.1 | TypeScript type definitions |

### Provided by Pi (no install needed)

| Package                         | Purpose                                          |
| ------------------------------- | ------------------------------------------------ |
| `@mariozechner/pi-coding-agent` | Pi SDK types (ExtensionAPI, ExtensionContext)     |
| `@mariozechner/pi-tui`          | TUI Text widget for custom message rendering     |
| `@sinclair/typebox`             | JSON Schema type definitions for tool parameters |

### `package.json`

```json
{
  "name": "pi-link",
  "private": true,
  "dependencies": {
    "ws": "^8.20.0"
  },
  "devDependencies": {
    "@types/ws": "^8.18.1"
  },
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

The `pi.extensions` field tells Pi which files to load as extensions. Here it points to `./index.ts`, which Pi compiles and registers on startup.

---

## Internals

> This section covers implementation details for contributors and developers who want to understand or modify the extension's internals.

### Protocol

The wire protocol consists of **8 message types**, all serialized as JSON over WebSocket frames:

| Type              | Direction     | Purpose                                               |
| ----------------- | ------------- | ----------------------------------------------------- |
| `register`        | Client → Hub  | First message after connecting; requests a name       |
| `welcome`         | Hub → Client  | Confirms assigned name (deduplicated) + terminal list |
| `terminal_joined` | Hub → All     | Broadcast when a terminal joins                       |
| `terminal_left`   | Hub → All     | Broadcast when a terminal disconnects                 |
| `chat`            | Any → Any/All | Fire-and-forget message; optionally triggers LLM turn |
| `prompt_request`  | Any → Any     | Request a remote terminal to execute a prompt         |
| `prompt_response` | Any → Any     | Response carrying the remote prompt result            |
| `error`           | Hub → Client  | Error notification                                    |

### Message Flow Examples

**Joining the link:**

```
Client                         Hub
  |                             |
  | register {name:"builder"}   |
  |---------------------------->|
  |                             |
  | welcome {name:"builder",    |
  | terminals:["pi-1"]}         |
  |<----------------------------|
  |                             |
```

Hub then broadcasts `terminal_joined` to the other connected terminals.

**Sending a chat message:**

```
Client A            Hub              Client B
  |                  |                  |
  | chat {to:pi-2}   |                  |
  |----------------->|                  |
  |                  | chat {from:A}    |
  |                  |----------------->|
  |                  |                  |
```

**Remote prompt (synchronous RPC):**

```
Client A            Hub              Client B
  |                  |                  |
  | prompt_request   |                  |
  |----------------->|                  |
  |                  | prompt_request   |
  |                  |----------------->|
  |                  |   (LLM runs)     |
  |                  |<-----------------|
  | prompt_response  |                  |
  |<-----------------|                  |
```

### Name Uniqueness

The hub enforces unique terminal names via a `uniqueName()` function. If `"builder"` is already taken, the next terminal requesting that name is assigned `"builder-2"`, then `"builder-3"`, and so on.

Default names are random 4-character hex IDs: `t-a1b2`, `t-c3d4`, etc.

**Rename guards:**

- If you're already using the requested name, `/link-name` returns early (`"Already using..."`).
- On the hub, renaming checks if the name is taken by another connected client before accepting the change.
- On a client, the rename triggers a reconnect; the hub enforces uniqueness during re-registration and may assign a different name if taken.

**Unregistered client guard:** The hub ignores all non-`register` messages from clients that haven't completed registration, preventing protocol violations from malformed or out-of-order messages.

### State Management

| State Field              | Type                                    | Purpose                                               |
| ------------------------ | --------------------------------------- | ----------------------------------------------------- |
| `role`                   | `"hub" \| "client" \| "disconnected"`   | Current network role                                  |
| `isAgentBusy`            | `boolean`                               | Prevents accepting remote prompts during agent runs   |
| `manuallyDisconnected`   | `boolean`                               | Set by `/link-disconnect`; suppresses auto-reconnect  |
| `pendingRemotePrompt`    | `object \| null`                        | Tracks the single in-flight remote prompt execution   |
| `pendingPromptResponses` | `Map`                                   | Outstanding prompt RPCs awaiting responses            |

### Message Routing & Error Handling

`routeMessage()` returns a `boolean` indicating delivery status:

- **Hub** — delivery is authoritative. If the target terminal isn't connected, the hub sends a protocol-level error back to the sender. For `prompt_request` messages to unknown targets, the hub sends a `prompt_response` with an error field so the sender's pending promise resolves immediately rather than timing out.
- **Client** — delivery is optimistic (`true` means "sent to hub"). The hub handles routing and errors via the protocol.

### Connection Lifecycle

Internally, teardown is split into two functions:

- **`disconnect()`** — closes sockets, clears connection state, resolves pending promises. Used by `/link-disconnect` and called internally by `cleanup()`.
- **`cleanup()`** — calls `disconnect()` then marks the extension as disposed. Used on `session_shutdown`.

The `manuallyDisconnected` flag distinguishes user-initiated disconnects (`/link-disconnect`) from connection loss. When set, `scheduleReconnect()` is suppressed — the terminal stays offline until `/link-connect` is explicitly called.

### Agent Lifecycle Integration

The extension hooks into Pi's agent lifecycle events:

- **`agent_start`** → Sets `isAgentBusy = true`, blocking incoming remote prompts.
- **`agent_end`** → Checks if a remote prompt was running. If so, extracts the last assistant response from `event.messages` and sends back a `prompt_response`.
- **`session_shutdown`** → Full cleanup via `cleanup()`: closes all sockets, resolves pending promises, and disposes the extension.

### Rendering

Incoming link chat messages render with a styled `⚡ [sender]` prefix using the theme's accent color. The link status text in Pi's footer uses `theme.fg("dim", ...)` to match Pi's standard footer styling.
