# pi-link

Run several Pi agents side by side and let them work as a team. Open two terminals with `pi --link`; they find each other on your machine, and each one can hand the other work, ask it questions, or wait for it to report back — all from a normal prompt.

One Pi is powerful. Several, talking to each other, unlock patterns a single terminal cannot:

- **Research + Build** — one terminal digs through APIs, docs or logs while another writes the code.
- **Parallel work** — split a large task ("you take the backend, you take the frontend") and collect the results.
- **Orchestrator / Workers** — one terminal delegates, tracks who reported back, and assembles the whole.
- **Review pipeline** — one writes, another reviews, back and forth until both are satisfied.

Questions, ideas? There's a [pi-link thread](https://discord.com/channels/1456806362351669492/1485515696719921183) in the official Pi Discord.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Walkthrough](#walkthrough)
- [LLM Tools](#llm-tools)
- [Slash Commands](#slash-commands)
- [CLI: `pi-link`](#cli-pi-link)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Limitations & Design Decisions](#limitations--design-decisions)
- [Dependencies](#dependencies)
- [Internals](#internals)

---

## Prerequisites

- [Pi coding agent](https://github.com/badlogic/pi-mono), version **0.84.2 or later** (for pi-link 0.3+), stable releases only, reported as `x.y.z` without a prerelease or build suffix. On Pi 0.74–0.84.1, pin `pi-link@0.2.x`; on Pi ≤0.73, pin `pi-link@0.1.14`.
- Node.js (LTS recommended)

Pi's package installation does not check the host version, so `pi install` succeeds on an older Pi. pi-link then refuses to initialize instead of half-running: it throws before registering anything, and Pi reports it under **[Extension issues]** with the required minimum and the version it detected.

---

## Quick Start

### Install

The minimum install — enables every in-Pi feature (`/link`, `link_send`, `/link-connect`, `--link` flag, auto-resume, and all LLM tools):

```bash
pi install npm:pi-link
```

That's it. For most users this is all you need.

#### Optional: shell launcher

If you also want the `pi-link <name>` shell command to start named sessions from a terminal prompt (e.g. `pi-link builder` in one window, `pi-link reviewer` in another), install the CLI globally as well:

```bash
npm i -g pi-link
```

Or install both in one line:

```bash
pi install npm:pi-link && npm i -g pi-link
```

Pi installs packages into its own npm root (`~/.pi/agent/npm/`), which is not on `PATH`; `npm i -g pi-link` is what puts the `pi-link` command there.

The shell launcher is convenience-only — you can always reach the same functionality from inside Pi via `/link-connect` and `/link-name <name>`.

### Uninstall

```bash
pi uninstall npm:pi-link      # Remove Pi extension
npm uninstall -g pi-link      # Remove CLI launcher (if you installed it)
```

### Usage

Link is **off by default**. Three ways to start:

```bash
pi --link                    # try it now, random name like t-a3f9
pi --link-name builder       # with a name of your choice
pi-link builder              # same, plus resume that session by name later (needs the shell launcher)
```

Already in a session? Use `/link-connect`. Use `/link` any time to check status, or let the LLM tools handle cross-terminal coordination. See [Session Resume](#session-resume) for `pi-link <name>` details.

---

## Walkthrough

Here's a concrete example of two terminals collaborating. Open two terminals, each with its name already set:

```bash
pi --link-name builder       # Terminal 1
pi --link-name researcher    # Terminal 2
```

The first one to start becomes the hub; the second joins it. **In Terminal 1**, both names are now visible:

```
> /link
⚡ Link: builder (hub) · 2 online
  builder: idle (5s) · 45K/272K (17%)
    cwd: ~/my-project
  researcher: idle (12s) · 80K/272K (29%)
    cwd: ~/my-project
```

Already inside a session? Name it from the prompt instead — `/link-connect` if it is not on the link yet, then:

```
> /link-name researcher
✓ Reconnecting, requesting "researcher" (hub may assign a different name if taken)...
```

A client reconnects under its new name, so give it a moment before checking `/link`. Either way the name is saved with the session and comes back on resume.

**Now ask Terminal 1's LLM to delegate work:**

In Terminal 1, type a normal prompt:

```
> Use link_send to ask "researcher" to summarize README.md, then report DONE with the summary back to builder
```

Terminal 1 calls `link_send` and returns immediately. The message enters Terminal 2's reasoning — steered into its current run if it is working, or starting a turn if it is idle. Terminal 2 completes the assignment, then sends a conventional `DONE` callback. That callback enters Terminal 1 the same way, where the result can be presented or used for follow-up work.

### Once it works: groups

With two projects open, you may not want their terminals to see each other. Put a group after `@` in the name — `pi --link-name builder@frontend`, or `/link-name builder@frontend` from inside — and that terminal lists, messages and compacts only names ending in the same `@frontend`; a plain `builder` elsewhere no longer appears. The hub still serves everyone, and `pi-link --status` shows all groups. Full rule under [Configuration](#configuration).

---

## LLM Tools

Three tools: `link_send` to talk to another terminal, `link_list` to see who is there, and `link_compact` to trim another terminal's context. pi-link also ships a **pi-link-tools** skill describing how they behave.

### Which tool should I use?

| Tool           | Behavior                                                | Returns                                                 |
| -------------- | ------------------------------------------------------- | ------------------------------------------------------- |
| `link_send`    | Send a message to one other terminal                    | Reports whether sending started, not whether it arrived |
| `link_list`    | List currently connected terminals                      | Terminal list with roles, status, cwd, and context      |
| `link_compact` | Ask another terminal to compact and wait for its result | Compacted, declined, or failed                          |

### `link_send`

Send a message to one other terminal. The sender returns immediately.

| Parameter | Type     | Description          |
| --------- | -------- | -------------------- |
| `to`      | `string` | Target terminal name |
| `message` | `string` | Message content      |

When a message reaches the target terminal, it enters the receiver's inbox. Messages arriving close together are usually delivered as one batch, in arrival order, each batch one `[Link: N message(s) received]` block, with every message under a `From "name":` header. The batching window, the size caps that can split a batch and what can hold one back are in [Inbox](#inbox).

The receiver's state is read when that batch is delivered, not when it is sent. If the receiver is still running then, the batch is steered into that run at Pi's next safe boundary — current tool calls finish first, before the next LLM call. Otherwise it starts a turn. There is no way to send without entering the receiver's reasoning.

Each send has exactly one recipient; there is no fan-out.

Targets are pre-validated against the terminals in your group, so a definite typo, an offline name and a name outside your group all fail the same way. Sending to yourself is rejected. For a client, a successful send means the message was handed to its connection to the hub. It does not confirm that the hub routed it or that the receiver saw it — see [Message Routing](#message-routing--error-handling). A reply, when one comes, is an ordinary later `link_send` from the other side; nothing correlates it to your message or produces it automatically.

### `link_list`

Lists the connected terminals in your [group](#configuration), with role info, status, working directory, context usage, and self-identification. Takes no parameters. Your own status and context are read when you run `link_list`; for other terminals, you see their most recently reported values, which may be slightly behind.

Each terminal reports its current working directory on connect. `link_list` shows the full absolute path.

Each terminal also reports its LLM context usage, rendered as `45K/272K (17%)` — tokens used over the context window, with percent. Briefly after compaction it shows as `?/272K` until the next measured context value is available.

Each terminal's status is derived automatically from Pi lifecycle events - agents can't set it manually. Four states:

| Status            | Meaning                                                                            |
| ----------------- | ---------------------------------------------------------------------------------- |
| `idle (2m)`       | Waiting for user input                                                             |
| `thinking (3s)`   | Work Pi has not settled yet — the LLM call, plus any automatic retry or compaction |
| `tool:bash (12s)` | The first still-active call, not a list                                            |
| `compacting (8s)` | Manual compaction gate raised; messages held                                       |

Pi can run tools in parallel, so `tool:<name>` names the first still-active call Pi reported — one call that really is still running, not a list of every concurrent one — and it advances only when that call ends, staying `tool:<name>` until the last one does.

Only a manual compaction shows `compacting`; while it does, messages to that terminal are held — see [Inbox](#inbox).

Durations are computed at render time from a `since` timestamp - no timer traffic over the wire. Terminals that just joined with no status data yet render as blank, not fake idle.

Working directories use full absolute paths in tool output. In the TUI (`/link`), paths are shortened to `~/...` when possible to keep the display compact.

**Example output:**

```
Connected terminals:
  • builder (you)  idle (12s)  · 45K/272K (17%)
    cwd: /home/me/my-project
  • researcher  thinking (3s)  · ?/272K
    cwd: /home/me/my-project
  • reviewer  idle (1m)  · 90K/272K (33%)
    cwd: /home/me/my-project
```

### `link_compact`

Ask another terminal to compact its context window and wait up to 300 seconds for a result. The target may compact successfully, decline, or return an error. After a successful result, the next call can dispatch work to the freshly trimmed worker.

| Parameter      | Type     | Description                                            |
| -------------- | -------- | ------------------------------------------------------ |
| `to`           | `string` | Target terminal name                                   |
| `instructions` | `string` | Optional custom compaction instructions for the target |

- **Success** result: `Compacted "<name>"`.
- **Busy decline** — the target accepts only when Pi reports its session idle **and** no manual compaction holds its delivery gate, so an active run, an automatic retry, an automatic compaction and a queued continuation all decline immediately with `reason: "busy"` without interrupting the work in progress.
- **The other declines** — a runtime offering no compaction capability declines with `reason: "unsupported"` and is never asked to compact; a session under the runtime's threshold declines with `Compact on "<target>" not done: Nothing to compact (session too small)`; a target that has done nothing since its last compaction declines with `Compact on "<target>" not done: Already compacted`.
- **Self-target rejection** — calling `link_compact` on yourself returns a `self_target` error (`Cannot compact yourself.`).
- **Flat 300-second timeout** — the timeout bounds the caller's wait only; nothing aborts the target, so a timed-out call may mean the compaction is still running.
- Any terminal can request compaction on another **in its group**.

The mechanics behind these outcomes — what an accepted request runs, the delivery gate it raises, what releases that gate after a cancellation, and what aborting the caller does — are in [Remote compaction](#remote-compaction).

---

## Slash Commands

| Command             | Purpose                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `/link`             | Show link status (name, role, online count, agent status, context usage, and cwd per terminal)                           |
| `/link-name [name]` | Rename and save as this session's preferred link name. With no argument, adopts the Pi session name. Restored on resume. A name with `@` also sets your group. |
| `/link-connect`     | Connect to Pi Link (works anytime, with or without `--link`)                                                             |
| `/link-disconnect`  | Disconnect from Pi Link and suppress auto-reconnect (overrides `--link`)                                                 |

### Examples

```
> /link
⚡ Link: builder (hub) · 3 online
  builder: idle (12s) · 45K/272K (17%)
    cwd: ~/my-project
  worker-1: thinking (3s) · ?/272K
    cwd: ~/my-project
  worker-2: tool:bash (5s) · 180K/272K (66%)
    cwd: ~/other-project

> /link-name orchestrator
✓ Renamed to "orchestrator"

> /link-name
✓ Renamed to "my-session"

> /link-disconnect
✓ Disconnected from link

> /link-connect
✓ Joined link as "orchestrator" (3 online)
```

With no argument, `/link-name` adopts the Pi session name. `/link-connect` joins an existing hub if one is running; otherwise it starts the hub.

**Name persistence:** `/link-name` saves your preferred name to the session. Resume later and it's restored automatically. If the name is taken, the hub assigns a variant (e.g., `"builder-2"`), but your preferred name stays saved for the next reconnect. See [Name Uniqueness & Persistence](#name-uniqueness--persistence) for details.

See [Configuration](#configuration) for details on `--link`, `/link-connect`, and `/link-disconnect` behavior.

---

## CLI: `pi-link`

`pi-link` is the optional shell launcher installed with `npm i -g pi-link`. It resolves sessions by name, lists them, and asks the running hub who is connected.

### Session Resume

Pi's `--session` flag requires a file path, not a display name. `pi-link` bridges this — it resolves a session by name and launches Pi directly:

```bash
pi-link worker-1                # resume or create session "worker-1"
pi-link worker-1 --model sonnet # with extra Pi flags
```

How it works: `pi-link worker-1` scans Pi's session directory, finds the session named "worker-1", and spawns `pi --session <path> --link`. Session-dir resolution matches Pi's lookup order: `PI_CODING_AGENT_SESSION_DIR` env > `<cwd>/.pi/settings.json` `sessionDir` > `<agentDir>/settings.json` `sessionDir` > default `<agentDir>/sessions/`. `<agentDir>` follows `PI_CODING_AGENT_DIR` and defaults to `~/.pi/agent/`.

Lookup is **scoped to the current cwd by default**; pass `--global` (`-g`) to consider sessions in any cwd. A scoped lookup stops reading a session file as soon as its header names another cwd, so it never learns the names of sessions belonging to other directories, and its cost tracks this cwd's own history rather than the history of unrelated projects.

- **One match in scope** → resumes that session
- **No match in scope** → creates a new session in the current cwd, and advises `--global` without claiming a session exists elsewhere.
- **Multiple matches in scope** → prints candidates to stderr, exits 1
- **Conflicting flags** (`--session`, `--continue`, `--resume`, `--fork`, etc.) → rejected with an error

### Discovering sessions

`pi-link --list` shows pi-link sessions in the current cwd; `pi-link --list --global` (or `-g`) lists them across all directories. Sorted by last activity — starting a session with the same name it already has does not bump recency; only real activity (messages, tool calls, edits, name changes) does.

```
$ pi-link --list
NAME             MODIFIED  MESSAGES  ID
builder          2m ago    4632      6332faab
researcher       5m ago    1493      20d43841

Resume: pi-link <name>
```

With `--global`:

```
$ pi-link --list --global
NAME             CWD                   MODIFIED  MESSAGES  ID
builder          ~/my-project          2m ago    4632      6332faab
researcher       ~/other-project       5m ago    1493      20d43841

Resume: pi-link <name>
```

`--global` adds a `CWD` column with `~` substituted for `$HOME`. Output is plain when piped (`NO_COLOR` honored).

`pi-link <name>` and `pi-link --resolve <name>` follow the same scoping: local cwd by default, `--global` (or `-g`) widens. A local miss never silently jumps cwds: it says the name was not found here and suggests `--global`. Because a local scan skips sessions from other cwds without reading them, that suggestion is advice rather than a report that a match exists elsewhere - run it with `--global` to find out.

For scripting, `pi-link --resolve <name>` prints just the session path (machine-readable, no other output). Exit codes: `0` on single match, `1` if ambiguous (multiple matches printed to stderr), `2` if not found.

### `--status`: who is connected right now

`--list` and `--status` answer different questions. `--list` reads session files on disk and answers *which sessions exist in history on this machine* — a session that died days ago still appears. `--status` asks the running hub and answers *who is connected to the link at this instant* — it is held in the hub's memory, so it needs a live hub and reports nothing about sessions that are merely saved.

```
$ pi-link --status
NAME        STATUS               CONTEXT          CWD
builder     idle (7m)            92K/272K (34%)   ~/my-project
researcher  tool:link_send (3s)  ?/272K           ~/my-project
reviewer    compacting (12s)     1.3M/2.0M (63%)  ~/other-project
worker-1    ?                    ?                ?
```

The hub is listed first, then clients sorted by name. A `?` means the hub could not report that field — for `worker-1` above, it has registered but has not yet sent its first status update. **`?` means unknown, not idle.** Reading it as idle is the mistake this command exists to prevent.

The word for what this proves is **connected**, not alive: it shows terminals registered with the hub that answered. A terminal whose process is wedged still holds its connection, so `--status` never claims a terminal is healthy — only that it is on the link.

Querying is read-only. It does not register a terminal, does not appear in anyone's `link_list`, and broadcasts nothing to the fleet.

#### Scripting

`--status --json` writes the hub's response body to stdout unchanged once it passes the same checks the table uses, and the endpoint is plain HTTP, so `curl` works too:

```bash
pi-link --status --json
curl 127.0.0.1:9900/status
```

Two of the terminals above, as the hub reports them:

```json
{
  "hub": "builder",
  "port": 9900,
  "terminals": [
    {
      "name": "builder",
      "role": "hub",
      "status": "idle",
      "sinceSeconds": 420,
      "cwd": "/home/me/my-project",
      "context": { "tokens": 92000, "window": 272000 }
    },
    {
      "name": "worker-1",
      "role": "client",
      "context": null
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `hub` | Name of the hub that answered; always equal to `terminals[0].name` |
| `port` | Port the hub is bound to |
| `terminals` | Hub first, then clients sorted by name — never empty |
| `terminals[].name` | Terminal name as the hub knows it |
| `terminals[].role` | `hub` for the first entry, `client` for the rest |
| `terminals[].status` | `idle`, `thinking`, `compacting`, or `tool:<name>` |
| `terminals[].sinceSeconds` | Whole seconds in that status, rounded — relative, so no clock agreement is needed |
| `terminals[].cwd` | Working directory; **omitted** when the hub does not know it |
| `terminals[].context` | **Always present**: `null` when there is no snapshot, otherwise `{ tokens, window }` |

**`status` and `sinceSeconds` are one optional pair — both present or both absent.** They are absent for a terminal the hub has registered but not yet heard from. Absence means unknown; do not substitute a default.

**`context` uses `null`, not omission.** The field is always there; `null` means no snapshot exists, and `{ "tokens": null, "window": 272000 }` means a snapshot exists but the token count is mid-refresh (rendered `?/272K`).

Two things may grow, and consumers must tolerate both:

- **Unknown fields.** Documented fields are frozen; new ones may be added, so ignore what you do not recognize rather than rejecting the payload.
- **Unknown `status` values.** The vocabulary is not frozen — it has grown before, gaining `compacting` in 0.3.0. Treat any non-empty string as possible; the CLI renders an unrecognized value as-is instead of refusing the response.

Everything above is what the hub sends. The CLI validates only the fields its table prints — `terminals` as an array of objects with a string `name`, an optional string `cwd`, `context` as `null` or `{ tokens, window }`, and `status`/`sinceSeconds` together or absent. A body failing that exits 1 with the unsupported message instead of a stack trace, **in both modes**. A zero exit certifies nothing beyond printability — not hub-first order, not `terminals[0].name === hub`, not a numeric `port`, not even that a hub answered; verify what you depend on yourself. Once the body passes, `--json` writes it as received, unreformatted.

#### Exit codes

| Code | Meaning | Message |
| --- | --- | --- |
| `0` | Something answered with a printable payload | — |
| `2` | No hub answered | `No link hub running on :9900.` |
| `1` | Usage error, or an answer the table cannot print | `Link hub does not support /status — update pi-link and restart terminals.` |

The two failure messages are deliberately distinct, so a script can tell *no usable answer* from *an answer this CLI cannot read* without parsing anything else. Exit `2` covers both nothing listening and a listener that accepts the request but does not answer within two seconds — every timeout is exit `2`. Exit `1` covers a listener that responds with something the table cannot read — for example a pi-link 0.3.0 hub, which answers plain HTTP with `426 Upgrade Required`, so an out-of-date fleet lands here deterministically rather than looking like an outage.

Exit `2` means no hub answered **at that instant**. When a hub exits, a surviving client promotes itself to replace it, which takes roughly 2–5 seconds — poll again before concluding the fleet is down.

#### Notes

`PI_LINK_PORT` changes only where the CLI looks; the extension always binds the hub to `9900`. The value is not validated — an unusable one simply fails the request and is reported back to you in the exit-`2` message.

The endpoint is bound to `127.0.0.1` with no authentication, the same trust boundary as the WebSocket surface it shares a port with: any process on this machine can already connect to the link.

Finally, `--status` and `--json` belong to the wrapper only until a session name appears. After one, they are pi's: `pi-link mybot --status` forwards `--status` to pi untouched, exactly like any other passthrough flag.

---

## Configuration

Link is **off by default**. Without `--link`, `--link-name`, or `pi-link`, a fresh session is completely silent — no status bar, no connections, no warnings.

**Naming concepts**

- **link name** — identity used on the network (visible in `link_list`, `/link`, and messages).
- **group** — the text after the first `@` in a link name, compared exactly. `archon@pi-link` is in `pi-link`, `a@g@h` is in `g@h`, and a name without `@` (or ending in one, like `a@`) belongs to the single implicit group of plain names. Comparison is **case-sensitive**: `a@Team` and `a@team` are different groups. `link_list`, `link_send`, `link_compact`, `/link` and the footer see only your own group; the hub still routes for every group, and `pi-link --status` shows all of them. Renaming with `/link-name` moves you.
- **Pi session name** — identity Pi gives the session itself; lives in the session JSONL's latest `session_info` entry.
- **saved link name** — the link name persisted to the session, restored on resume. Set by `/link-name`, `pi-link <name>`, or `pi --link-name <name>`.
- **`--link-name` flag vs `/link-name` command** — same concept (the link name) at different times (startup vs mid-session).

| What you want                        | Use                     |
| ------------------------------------ | ----------------------- |
| Resume/create a named session        | `pi-link <name>`        |
| Stable link identity, normal Pi flow | `pi --link-name <name>` |
| Quick try, random name               | `pi --link`             |
| Already in a session                 | `/link-connect`         |
| Disconnect mid-session               | `/link-disconnect`      |

`pi-link <name>` resumes/creates a session AND sets your link identity in one step. `pi --link-name <name>` sets only the link identity, leaving Pi's normal session selection (latest in cwd, or fresh) untouched.

**Name normalization:** Link names are normalized — leading/trailing whitespace removed and internal whitespace runs collapsed to a single space. `/link-name "build   lead"` saves and shows as `build lead`.

**Name precedence:** `pi --link-name` > `pi-link <name>` > saved `/link-name` > Pi session name > random `t-xxxx`. _(The `pi-link` wrapper itself does not accept `--link-name`; pick one or the other.)_

`/link-connect` and `/link-disconnect` save their intent to the session — resume later and the connection state is restored without needing the flag. Explicit user intent takes precedence over `--link`.

---

## Troubleshooting

### Port 9900 is already in use

If another process occupies port 9900, the terminal can't become the hub. It tries to connect as a client first, and that attempt fails within 5 seconds even against a listener that accepts the connection and never speaks WebSocket - so the terminal falls back to trying the hub role and then retries after 2-5 seconds, rather than sitting offline indefinitely. Free the port or modify `DEFAULT_PORT` in `index.ts` - see [Limitations](#limitations--design-decisions).

### `link_compact` reports a busy target

A `link_compact` request does not interrupt work the target is still doing, so it declines while that terminal is unsettled — see [`link_compact`](#link_compact) for the full list of what counts. Try again once `/link` or `link_list` reports the target idle, keeping in mind that idle is what was true a moment ago, not a reservation: the target can start working again before your request lands. `link_send` is different — it enters or steers the target's reasoning instead of declining just because it is busy.

### I sent a message but got no reply

A successful send is not a confirmation. On a client it means the message was handed to the hub connection, not that the target received it or acted on it — and replies are ordinary messages the other agent chooses to send, so nothing produces one automatically. Run `/link`, or ask your model to call `link_list`, and check the target: confirm the name is still exactly right, and note that a target in the `compacting` state holds messages that reach it until that state clears. Otherwise silence may mean the work is still running or that no reply was sent. If the target cancelled a `/compact`, pi-link cannot see that, so its messages may stay held until its next run or up to five minutes — see [Remote compaction](#remote-compaction).

### `pi-link --status` reports no hub, or an unsupported one

The two messages mean different things. `No link hub running on :9900.` (exit `2`) means nothing answered — either the link is genuinely down, or you caught it during the 2–5 second window while a client promotes itself to hub, so poll again before believing it. `Link hub does not support /status — update pi-link and restart terminals.` (exit `1`) means something answered but the response did not pass the CLI's checks — for example, a pi-link 0.3.0 hub, which predates the endpoint. Updating is not enough on its own: the running terminals keep the old hub alive until they restart. See [`--status`: who is connected right now](#--status-who-is-connected-right-now).

### Terminals don't see each other

- Compare the part after `@`, exactly as spelled: `archon@pi-link` and `builder` are in different [groups](#configuration), and so are `a@Team` and `a@team`; they are invisible to each other by design. `pi-link --status` shows every group and settles it.
- Verify both terminals are on the same machine (the link only works on `127.0.0.1`).
- Run `/link` in each terminal to check status.
- Ensure port 9900 isn't blocked or occupied by a non-link process.

### Hub promotion loses state

When the hub exits, a surviving client promotes itself in roughly 2–5 seconds; messages in flight during that gap can be lost, and a terminal that reconnects as a client after running as a hub-assigned variant like `builder-2` may come back under its preferred name, or vice versa. This is by design — see [Hub Promotion](#hub-promotion) for how promotion works and [Limitations](#limitations--design-decisions) for the decision behind it.

---

## Limitations & Design Decisions

| #   | Decision                                  | Rationale / Impact                                                                                                                                               |
| --- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **No authentication**                     | Any localhost process can connect to port 9900. Acceptable for local dev; don't expose the port externally.                                                      |
| 2   | **Hardcoded port (9900)**                 | Not configurable without editing `DEFAULT_PORT` in `index.ts`. Could conflict with other services on the same port.                                              |
| 3   | **Race-based hub promotion**              | Non-deterministic. Reconnect order can change which terminal holds a hub-assigned suffix; in-flight messages can be lost. Simple but imperfect.                  |
| 4   | **No offline backlog**                    | A definitely absent target is rejected and nothing is stored, so a terminal that reconnects receives no messages it missed while offline.                        |
| 5   | **Client rename triggers full reconnect** | Changing a client's name requires a new `register` message, so the client disconnects and reconnects. Hub renames are handled in-place.                          |
| 6   | **Single-machine / localhost-only**       | Link only binds to `127.0.0.1`; terminals on different machines cannot join.                                                                                     |
| 7   | **Callbacks are conventional**            | Async results arrive as uncorrelated messages, not protocol responses: no request identifier, and a callback exists only because the receiver chose to send one. |
| 8   | **Groups isolate attention, not access**  | No auth: any process may pick any group, and `pi-link --status` shows all of them; isolation needs one version everywhere, so upgrade and restart together.      |

---

## Dependencies

At runtime pi-link needs one package, `ws` (^8.20.0), the WebSocket server and client; `pi install` brings it in. Development adds `@types/ws` (^8.18.1) for its type definitions. Everything else comes from Pi itself and needs no install: `@earendil-works/pi-coding-agent` for the SDK types (`ExtensionAPI`, `ExtensionContext`) and `VERSION`, `@earendil-works/pi-tui` for the Text widget used in custom message rendering, and `typebox` for the tool parameter schemas.

> See [Prerequisites](#prerequisites) for supported Pi versions.

---

## Internals

> This section covers implementation details for contributors and developers who want to understand or modify the extension's internals.

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

- The **first terminal** to start becomes the **hub** - it runs a `WebSocketServer` on `127.0.0.1:9900`.
- **Subsequent terminals** connect as **clients** via plain WebSocket.
- All messages route **through the hub**; clients never talk directly to each other.

### Auto-Discovery Protocol

The discovery sequence runs on startup (with `--link` or `pi-link`) or when `/link-connect` is used. See [Configuration](#configuration) for details.

The sequence is a simple fallback:

1. Attempt to connect as a **client** to `127.0.0.1:9900`. The WebSocket opening handshake is bounded at **5 seconds**; a listener that accepts the connection but never completes the upgrade fails the attempt instead of holding it open.
2. If connection fails → become the **hub** (start a WebSocket server on that port).
3. If both fail (rare race condition) → retry after a randomized 2-5 second backoff.

Only **one attempt runs at a time**, across both steps. Startup, a retry and `/link-connect` arriving while an attempt is in flight all join that attempt rather than opening a second connection, so a terminal cannot register twice or leave a second socket behind.

### Hub Promotion

When the hub disconnects, clients detect the WebSocket close event, enter `"disconnected"` state, and call `scheduleReconnect()`. The **first terminal to retry** becomes the new hub via the same initialize-or-fallback flow.

There is **no explicit leader election** - promotion is race-based.

The old hub transfers no shared roster or routing state to its successor: every terminal drops the snapshots it held for the network that went away - names, statuses, working directories and context - while its own local state, the inbox included, survives. Clients wait the same randomized 2-5 second backoff before retrying, so promotion usually lands in that window rather than within a guaranteed bound, and messages in flight while no hub is listening can be lost. Survivors that rejoin the winner as clients re-register with their saved preferred name rather than their prior runtime name (see [Name Uniqueness & Persistence](#name-uniqueness--persistence)), so a terminal that was `builder-2` may come back as `builder`, or take the suffix this time. The winner does not re-register at all: it starts the hub keeping the identity it was already running under, unless a `/link-name` rename was in flight when the old hub vanished, which it then adopts.

### Protocol

The wire protocol consists of the following message types, all serialized as JSON over WebSocket frames. Cwd and context fields are optional.

| Type               | Direction       | Purpose                                                                                             |
| ------------------ | --------------- | --------------------------------------------------------------------------------------------------- |
| `register`         | Client → Hub    | First message after connecting; requests a name, optionally reports cwd and context                 |
| `welcome`          | Hub → Client    | Confirms assigned name, terminal list + status/cwd/context snapshots                                |
| `terminal_joined`  | Hub → All       | Broadcast when a terminal joins; may include cwd and context                                        |
| `terminal_left`    | Hub → All       | Broadcast when a terminal disconnects                                                               |
| `chat`             | Any → Any       | Message delivered to the receiver's model: steered into a running agent, or starting a turn if idle |
| `compact_request`  | Any → Any       | Request a remote terminal to compact its context; awaits a response                                 |
| `compact_response` | Any → Any       | Completion/failure response for a compact_request                                                   |
| `status_update`    | Any → Hub → All | Terminal broadcasts agent status change; carries updated context                                    |
| `error`            | Hub → Client    | Error notification                                                                                  |

### Message Flow Examples

**Joining the link:**

```
Client                         Hub
  |                             |
  | register {name:"builder",   |
  |           cwd:"C:\\Users\\..."} |
  |---------------------------->|
  |                             |
  | welcome {name, terminals,   |
  | statuses, cwds}             |
  |<----------------------------|
  |                             |
```

Hub then broadcasts `terminal_joined` to the other connected terminals. The `welcome` message includes status, cwd, and context snapshots for all connected terminals (fields omitted above for brevity). `terminal_joined` also includes the new terminal's optional cwd and context.

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

### Name Uniqueness & Persistence

The hub enforces unique terminal names via a `uniqueName()` function. If `"builder"` is already taken, the next terminal requesting that name is assigned `"builder-2"`, then `"builder-3"`, and so on.

Default names are random 4-character hex IDs: `t-a1b2`, `t-c3d4`, etc.

**Groups (`local@group`):** see [Configuration](#configuration) for the rule a user needs. Internally, the hub serves every group over one set of connections; for the targeted traffic it handles, `routeMessage()` treats a target in another group as not found. Collisions suffix the local part only, so a deduped name never changes group: `builder` becomes `builder-2`, `archon@pi-link` becomes `archon-2@pi-link`.

**Persistence:** `/link-name` saves the preferred name to the session via `pi.appendEntry("link-name", { name })`. On session resume, the saved name is restored and requested from the hub. Startup naming (`pi-link <name>`, `pi --link-name <name>`) persists the same way - hub-assigned variants like `"builder-2"` are not saved. On reconnect, the terminal always requests the preferred name, not the last runtime name.

**Rename guards:**

- If you're already using the requested name, `/link-name` returns early (`"Already using..."`).
- On the hub, renaming checks if the name is taken by another connected client before accepting the change.
- On a client, the rename triggers a reconnect; the hub enforces uniqueness during re-registration and may assign a different name if taken.

**Unregistered client guard:** The hub ignores all non-`register` messages from clients that haven't completed registration, preventing protocol violations from malformed or out-of-order messages.

### State Management

| State Field               | Type                                  | Purpose                                                                                                                     |
| ------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `role`                    | `"hub" \| "client" \| "disconnected"` | Current network role                                                                                                        |
| `connectionAttempt`       | `record \| null`                      | The one establishment attempt in flight: its shared promise plus any pending socket/server. Object identity marks the owner |
| `agentRunning`            | `boolean`                             | Between `agent_start` and `agent_settled` — not `agent_end`; drives status only                                             |
| `compactRunning`          | `boolean`                             | Whether a remote request holds this terminal's delivery gate                                                                |
| `localCompacting`         | `boolean`                             | Whether a `manual`-reason compaction has raised the delivery gate                                                           |
| `activeTools`             | `Map`                                 | `toolCallId` → `toolName` for calls still running; the first drives status                                                  |
| `stateSince`              | `number`                              | Timestamp of last status change (used for duration display)                                                                 |
| `currentCwd`              | `string`                              | Current working directory reported to peers on connect                                                                      |
| `inbox`                   | `array`                               | Queued incoming messages awaiting delivery                                                                                  |
| `flushTimer`              | `Timer \| null`                       | Pending inbox flush; armed by the first queued message and not moved afterwards                                             |
| `compactDeadline`         | `Timer \| undefined`                  | Backstop releasing the inbox if a compaction reports no ending                                                              |
| `pendingCompactResponses` | `Map`                                 | Outstanding compact requests awaiting bounded responses                                                                     |
| `disposed`                | `boolean`                             | Set on shutdown; guards WebSocket callbacks against stale context                                                           |
| `startupConnectTimer`     | `Timer \| null`                       | Deferred startup connect so Pi's startup cycle completes first                                                              |
| `manuallyDisconnected`    | `boolean`                             | Set by `/link-disconnect`; suppresses auto-reconnect                                                                        |

### Message Routing & Error Handling

`routeMessage()` returns a `boolean` indicating delivery status:

- **Hub** - delivery is authoritative. If a chat target is not connected, the hub sends a protocol-level error back to a client sender; a local hub sender already receives the failed delivery result. A `compact_request` to an unknown target gets a synthesized `compact_response` (`ok: false`, `reason: "not_found"`), so the bounded compact call fails fast.
- **Client** - delivery is optimistic (`true` means "sent to hub"). The hub handles routing and errors via the protocol.

### Connection Lifecycle

Internally, teardown is split into two functions:

- **`disconnect()`** - closes sockets, clears connection state, resolves pending promises. Used by `/link-disconnect` and called internally by `cleanup()`.
- **`cleanup()`** - calls `disconnect()`, sets `disposed = true`, clears `ctx`. Used on `session_shutdown`.

Three helpers protect WebSocket callbacks from stale extension context:

- **`getUi()`** - safely accesses `ctx.ui`, returns `null` if the context is invalidated.
- **`notify()`** - wraps `getUi()?.notify()` for safe notification delivery.
- **`isRuntimeLive()`** - returns `false` if `disposed` or context is stale; checked before processing any incoming WebSocket message.

Startup connect is deferred via `scheduleStartupConnect()` (`setTimeout(0)`) so Pi's startup cycle completes and the extension context is fully valid before WebSocket work begins.

`disconnect()` also cancels the connection attempt in flight: it invalidates the attempt first, then closes whatever it had pending - a dialing socket or a binding server - so nothing can finish establishing after the user asked to disconnect. The startup and retry timers are cancelled on the same path, so `/link-disconnect` before the deferred startup connect opens nothing at all. Because ownership is tracked per attempt, a callback from a superseded or cancelled transport is inert: only the established socket (`ws`) may deliver messages or tear down client state, and only the established server (`wss`) may accept clients.

The `manuallyDisconnected` flag distinguishes user-initiated disconnects (`/link-disconnect`) from connection loss. When set, `scheduleReconnect()` is suppressed - the terminal stays offline until `/link-connect` is explicitly called.

### Agent Lifecycle Integration

The extension hooks into Pi's agent lifecycle events:

- **`agent_start`** → Sets `agentRunning = true`, which drives status. Clears the local compaction gate (`localCompacting`, never a remote request's `compactRunning`) - safe only under the current deployment, not by Pi alone: Pi refuses to start an ordinary prompt during a manual compaction, and pi-link holds back the one delivery path that refusal does not cover, so nothing can start a run mid-compaction. Another extension starting a turn during one would void that. Status normally becomes `thinking`.
- **`agent_end`** → Drops any tool calls still recorded, so an unmatched one falls back to `thinking` instead of staying pinned. It deliberately does **not** end the run: Pi may still retry, compact automatically, or drain a queued continuation, so the status stays `thinking`.
- **`agent_settled`** → The authoritative end of a run: Pi emits it once no retry, compaction or queued continuation is left. Status becomes `idle` — unless the event's context reports Pi busy again, which means another extension started a new run during settlement, and that newer run keeps reporting `thinking`.
- **`tool_execution_start`** → Records that call. It is displayed unless an earlier call is still running.
- **`tool_execution_end`** → Drops that one call. The display stays `tool:<name>` while other calls remain, moves to the next call when the displayed one ends, and returns to `thinking` after the last one while the agent run continues.
- **`session_before_compact`** → For a manual compaction, raises the gate that holds inbox delivery. Automatic (threshold/overflow) compaction is left alone: it runs inside the agent run, where Pi already queues and drains steered messages itself.
- **`session_compact`** → Clears the local compaction gate and force-pushes a `status_update` so peers see the new (post-compaction) context usage immediately.
- **`session_shutdown`** → Full cleanup via `cleanup()`: closes all sockets, resolves pending promises, and disposes the extension.

The five agent and tool handlers — `agent_start`, `agent_end`, `agent_settled` (when Pi still reports the session idle), `tool_execution_start` and `tool_execution_end` — each recompute the status and hand it to `pushStatus()`, which publishes only when the display identity changed since the last publish: a second concurrent tool starting behind the one already shown is silent, and so is a mutation that leaves a raised compaction gate on display. The session handlers keep the separate paths described in their own bullets, and `session_shutdown` cleans up rather than pushing. `disconnect()` is the only thing that clears the stored baseline, and `pushStatus()` returns immediately while the terminal is disconnected, so handler events in that interval restore nothing; once connected again, either a client's forced `welcome` push or the first of those ordinary handler events restores it. `session_compact` always pushes, whether the identity changed or not — including while a remote request's gate still holds the displayed identity.

Status updates are push-based: each terminal broadcasts changes to the hub, which fans them out. New joiners receive a status snapshot for all terminals in the `welcome` message. Context updates reuse the same status path, including a forced post-compaction update.

### Inbox

An arriving `chat` message goes into a local inbox rather than calling `pi.sendMessage()` immediately, so that arrivals close together can be coalesced into a single delivery.

The flush pipeline:

1. **Fixed window** - `scheduleFlush(FLUSH_DELAY_MS)` arms a timer only when none is pending, so the first queued message sets the deadline (about 200ms) and later arrivals join that window without moving it. The window is not sliding: sustained arrivals closer together than the delay cannot postpone delivery.
2. **Compaction gate** - `flushInbox()` returns without rescheduling while the compaction gate is raised.
3. **Batch** - up to 20 messages or ~16 000 chars per delivery (soft cap - the first item is always included even if oversized).
4. **Deliver** - one `pi.sendMessage()` call with a `[Link: N message(s) received]` block. Pi reads the receiver's state at this point — not at send time — to decide whether the batch steers a running agent or starts a turn.
5. **Drain** - if the inbox still has items, reschedule.

Delivery is held while a `manual`-reason compaction holds this terminal's gate, because a message delivered mid-compaction would be reasoned about against context that is being rebuilt. Two flags gate it: `compactRunning` for a compaction serving a remote `link_compact`, and `localCompacting`, set from `session_before_compact`; a remote request raises `compactRunning` first and adds `localCompacting` only if its compaction reaches that hook, since Pi reports its own reason as `manual` either way. Automatic (threshold/overflow) compaction is deliberately **not** gated: it runs inside the agent run, where Pi already queues steered messages and drains them afterwards. Because a gated flush does not reschedule, the release path is load-bearing: `releaseInbox()` runs after either flag clears and schedules a flush only when neither gate remains, and `compactDeadline` is the backstop for a `localCompacting` left raised, since failure emits no lifecycle ending event that clears it.

| Constant             | Value   | Purpose                                          |
| -------------------- | ------- | ------------------------------------------------ |
| `FLUSH_DELAY_MS`     | 200     | Batching window, from the first queued message   |
| `BATCH_MAX_ITEMS`    | 20      | Max messages per batch                           |
| `BATCH_MAX_CHARS`    | 16 000  | Soft cap on batch text size (~4K tokens)         |
| `COMPACT_TIMEOUT_MS` | 300 000 | Remote-compact wait, reused as the gate backstop |

### Remote compaction

A `compact_request` that passes the capability and idle checks is served by calling `ctx.compact()` — the same operation as `/compact`. The caller is answered when the runtime reports a result through `onComplete`/`onError`. Each call targets one terminal, independent calls can run concurrently, and link participants are cooperating peers: nothing here is privileged.

Serving a request raises the inbox gates in order, and not always both. `compactRunning` is set synchronously before `ctx.compact()` is called; `localCompacting` rises only if execution reaches the manual `session_before_compact` hook, so a runtime that refuses early — nothing to compact, already compacted, or another preparation failure — returns through `onError` without the local gate ever going up. When the compaction does succeed, `session_compact` clears the local gate first, and the later `finish()` clears `compactRunning` and calls `releaseInbox()`, which is what drains the inbox.

What a failure hides is the ending, not the failure itself. A remote compaction reports its error through `onError`, which runs `finish()` and answers the caller, so `compactRunning` always comes back down. But `session_compact` is a success-only ending and pi-link does not listen to Pi's `session_compact_failed`, so a `localCompacting` already raised by the hook stays up until the target's next agent run (`agent_start`), a later successful compaction, or the `compactDeadline` backstop 300 seconds after that gate rose. A human `/compact` has no result callback at all, so those three are its only release paths.

Those 300 seconds are two independent timers, not one synchronized deadline: the caller's bounded wait uses `COMPACT_TIMEOUT_MS` to stop waiting, and the local gate backstop reuses the same constant only to avoid inventing a second one. Aborting the caller before the request goes out leaves the target untouched; aborting after it goes out stops the caller from waiting and nothing else — the target's compaction, once started, runs to its own end.

### Rendering

Delivered link batches render with a styled `⚡ [link]` prefix using the theme's accent color; sender attribution lives in the `From "name":` blocks inside the message body, not in the prefix. The link status text in Pi's footer uses `theme.fg("dim", ...)` to match Pi's standard footer styling.

Deliveries sit in the same background panel Pi draws around extension messages by default, indented by your configured output padding, so link messages line up with the rest of the transcript instead of standing outside it.

A long delivery is previewed rather than printed whole. Collapsed, it shows the first six rows as they wrap at the current window width, followed by `... (N more lines, ctrl+o to expand)`; a message that already fits in six rows shows in full with no hint. Expanding is Pi's own global toggle — `Ctrl+O` unless you have rebound `app.tools.expand`, and the hint always names your actual binding — so it expands every custom message at once, including messages restored from an earlier session. If you have unbound `app.tools.expand` entirely there is no key to name, so both hints read `bind app.tools.expand to expand` instead. Only the display changes: the full text is what reaches the model, what `link_send` delivered, and what the session file keeps.

The same toggle also expands outgoing calls: `link_send` and `link_compact` collapse the message or instructions into a one-line preview — runs of whitespace become single spaces — and keep its first 60 characters, which a narrow terminal may still wrap onto more than one row. Expanding reveals the uncollapsed text with its line breaks and spacing as rendered by Pi. Expanding a call says nothing about delivery — the tool's own result line reports that.
