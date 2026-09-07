# Changelog

All notable changes to pi-link are documented here.

This changelog is based on the git history from `2026-03-21` (initial commit) through the present. Versions correspond to npm publishes.

---

## 0.4.1 — 2026-09-07

### Added

- **Received link messages now sit in Pi's own message panel.** A delivery is drawn in the same background panel Pi gives extension messages, indented by your configured output padding, so link traffic lines up with the rest of the transcript instead of standing outside it.

- **A long delivery is collapsed to a preview.** It shows the first six content rows as they wrap at the available content width inside the panel, then `... (N more lines, ctrl+o to expand)`; a message that already fits shows whole, with no hint. The six counts content rows only — the panel's padding and the hint itself sit outside it, so the panel has no fixed height. Expanding is Pi's existing global toggle, `Ctrl+O` unless you have rebound `app.tools.expand`, and the hint names your actual binding when one is assigned. It expands every custom message at once, including ones restored from an earlier session; pi-link adds no toggle of its own. When the expansion shortcut is unbound, incoming and outgoing previews show `bind app.tools.expand to expand`. Only the display changes — the full text is still what reaches the model, what was delivered, and what the session file keeps.

### Changed

- **Outgoing `link_send` and `link_compact` calls now follow Pi's global expansion toggle.** Collapsed, the message — or the compaction instructions — has runs of whitespace collapsed to single spaces and keeps the first 60 characters of that result; on a narrow terminal that preview may still wrap onto more than one row. Expanded, the uncollapsed text is shown with its line breaks and spacing as rendered by Pi. Indentation of the surrounding call is unchanged, and the tool's own result line still reports send or compaction status — never the other terminal's reply.

---

## 0.4.0 — 2026-09-04

### Added

- **The hub answers `GET /status` on the port it already owns.** A read-only JSON snapshot of who is connected right now, served over plain HTTP on `127.0.0.1:9900` alongside the WebSocket surface — no authentication, the same trust boundary as the link itself. The hub is listed first, then clients sorted by name. `status` and `sinceSeconds` are one optional pair, present together or absent together: absent means the hub has registered that terminal but not yet heard from it, which is unknown rather than idle. `context` is always present, `null` when there is no snapshot. Every other method and path answers 404. Reading the endpoint registers nothing, broadcasts nothing and changes no hub state, so watching the link no longer disturbs it — previously the only way to see live membership from outside Pi was to open a WebSocket and register, which announced a phantom terminal to the whole fleet.

- **`pi-link --status [--json]` reads that endpoint from the shell.** A table by default; `--json` writes the hub's response body verbatim for scripting. Three exit codes, with the two failures deliberately distinct so automation can tell an outage from a version mismatch without parsing anything: `0` on a valid payload, `2` with `No link hub running on :<port>.` when nothing answers, and `1` with `Link hub does not support /status — update pi-link and restart terminals.` when something answers that is not a hub speaking this contract. Every timeout is exit `2`, including a listener that returns headers and then stalls. A 0.3.0 hub answers plain HTTP with `426 Upgrade Required`, so an out-of-date fleet lands on exit `1` deterministically instead of looking like a dead link. `--status` and `--json` belong to the wrapper only until a session name appears; after one they forward to pi untouched, like any other passthrough flag.

### Changed

- **The hub owns the HTTP server its WebSocket server rides on.** Serving `/status` means handing `ws` a server instead of letting it build one, and `ws` never closes a server it was handed. That server is therefore closed at every teardown site — a cancelled connection attempt, a `/link-disconnect` from an established hub, and a listener that arrives after its attempt was cancelled. A missed close would leave a process squatting `:9900` with no hub behind it, and no other terminal on the machine could become the hub. Election is unchanged: `ws` forwards `listening` and `error` from the provided server, so port-in-use still falls back to the client role exactly as before.

### Compatibility

- **Two things in the `/status` payload may grow, and consumers must tolerate both.** Unknown *fields* may be added, so ignore what you do not recognize rather than rejecting the response. Unknown *`status` values* may appear too — the vocabulary is not frozen, and it has grown before, gaining `compacting` in 0.3.0 — so treat any non-empty string as possible. `pi-link --status` renders an unrecognized status as-is instead of refusing the payload.

- **Upgrading is not enough on its own: restart the terminals.** A running terminal keeps the hub it started with, so a 0.3.0 hub keeps answering `426` until the terminal hosting it restarts. Until then `pi-link --status` reports that the hub does not support `/status`, which is accurate — the fix is a restart, not a reinstall.

- **`PI_LINK_PORT` changes only where the CLI looks.** The extension always binds the hub to `9900`. The variable exists so tests can run a stub hub on a free port, and it is not validated: an unusable value simply fails the request and is reported back in the exit-`2` message.

---

## 0.3.0 — 2026-08-28

### Added

- **A terminal now reports `compacting` while its link delivery gate is raised.** It previously reported `idle`, so `link_list` and `/link` showed it as free at the one moment it was least available: messages sent to it wait in its inbox and `link_compact` declines. One local predicate decides both the `compacting` status a terminal derives and whether its inbox delivery is held, and it takes precedence over every other status a terminal derives for itself. It means the gate is raised, not that a compaction is provably still running — a cancelled manual compaction leaves it raised until the next successful compaction, the terminal's next agent start, or a 180-second deadline. Automatic threshold and overflow compaction are not gated by pi-link and never report `compacting`; they run inside an agent run Pi has not settled yet, so a terminal running one reports `thinking`.

### Breaking

- **`link_prompt` is removed.** The blocking prompt-and-wait tool is gone end to end: the tool, the `prompt_request` / `prompt_response` wire messages, the pending-response state, and its timeouts. `link_send` is not a replacement for it — sending is asynchronous and un-correlated. A send reports only its immediate send attempt, not what the target did with it. On a client, success means the message was handed to the hub connection; it does not confirm hub routing or receiver delivery. Nothing ties a later reply back to the call that prompted it. A worker that would have answered a prompt sends its answer with a later `link_send`, which is how callback-style coordination now works. Anything that needs a strict child operation with a join — one call that blocks until its own result comes back — needs orchestration owned by the host application.

- **`link_send` no longer takes a `triggerTurn` parameter.** Delivery behavior is the receiver's alone: a running receiver is steered at its next safe boundary, an idle one starts a turn. Which of the two happens is decided when the debounced batch is actually delivered, not when the message was sent, so it is not something a sender could have chosen correctly anyway. The tool takes `to` and `message` and nothing else.

- **Broadcast is removed.** `link_send` no longer treats `to: "*"` as a broadcast target, the hub no longer has wildcard routing, and `/link-broadcast` is gone. Each send routes to exactly one named recipient. Removing it from the tool alone would have left the feature reachable from the wire, so both went.

- **pi-link 0.3 requires Pi 0.84.2 or later.** The status lifecycle and the remote-compaction guard are built on Pi's `agent_settled` event and `ctx.isIdle()`, with one code path and no compatibility fallback. Pi's package installation does not check the host version, so `pi install` succeeds on an older Pi; pi-link then refuses to initialize rather than half-run. It throws before registering a single flag, event, tool or command and before opening any socket, and Pi reports the refusal with the required minimum and the detected version. Malformed versions and prereleases below the floor are refused the same way. On Pi 0.74–0.84.1 pin `pi-link@0.2.x`; on Pi 0.73 or earlier, `pi-link@0.1.14`.

- **Upgrade and restart every linked terminal together.** These removals changed the wire messages, and the link protocol carries no version of its own — nothing detects a mismatch or warns about one. One asymmetry has been observed directly: a new sender delivering to a 0.2.0 receiver can arrive as bare text, losing the `[Link: … message(s) received]` header and the `From "name":` line, with nothing reporting a fault. Restarting matters as much as upgrading, since a terminal keeps running the build it started with.

### Changed

- **`link_compact` now describes the guard it actually applies.** A target accepts only when Pi reports its session idle and no manual compaction holds its gate; everything else declines as `busy`, and a runtime with no compaction capability still declines as `unsupported`. The 180-second timeout bounds the caller's wait only: once the request has been dispatched, a caller timeout or abort ends that wait and nothing else, and the target may still be compacting. A call aborted before it dispatches returns without having asked for anything. The tool no longer tells the caller to retry or to re-check; it reports what happened and leaves the next move to the caller.

- **The bundled `pi-link-coordination` skill now focuses on how the tools behave.** It explains when messages start or steer turns, how status, callbacks and remote compaction behave, and what terminal names, working directories and mixed versions mean. Advice for the removed `link_prompt`, sender-selected delivery, broadcast and workflow/retry conventions is gone.

### Fixed

- **Once Pi announces a manual compaction, link messages wait instead of starting a turn against context being rebuilt.** Pi refuses an ordinary prompt during a manual compaction, but pi-link's delivery path is not an ordinary prompt and that refusal does not cover it. While the gate is raised the inbox holds messages, and the gate releases them when Pi reports the compaction succeeded, on the terminal's next agent start, or on a deadline if neither arrives. Coverage begins at the announcement: a human `/compact` aborts and prepares before Pi announces it, so a delivery landing in that short window is still possible. The message itself is never lost. Automatic compaction is deliberately left alone, since Pi queues and drains steered messages itself.

- **A scoped session lookup no longer reads every session on the machine.** `pi-link <name>`, `--resolve` and `--list` fully parsed every session file in every directory before filtering by cwd, so the wait grew with total history rather than with the project: on a corpus of 591 sessions (about 863 MiB) a local lookup took roughly 3.6-3.9 seconds, of which 88-100% was spent reading sessions belonging to other directories. A scoped scan now stops at the first complete session header and abandons the file when its immutable cwd names another directory, which brings the same corpus to well under a second. Sessions in scope are still read in full, so the latest `link-name` still wins and `--list` counts are unchanged, and `--global` keeps its existing full-scan behavior. One consequence: a local miss can no longer count same-name sessions in other cwds, because their names live past the point the scan stops. Instead of `(N matches in other cwds ...)` it now advises `Use --global to search other cwds.` without claiming that anything is there.

- **A steady stream of link messages can no longer postpone its own delivery.** The inbox timer was rearmed by every arrival, so traffic whose gaps stayed under the 200-millisecond batching window kept pushing the deadline back and the batch could wait indefinitely - which is not what the window was documented to do. The window is now fixed: the first queued message sets the deadline and later arrivals do not move it, so a sustained stream is delivered window by window. Batch size and character caps, arrival order, sender labels, the overflow drain and the compaction hold are unchanged.

- **Connecting is owned by one cancellable attempt, so nothing establishes behind the user's back.** A terminal stays `disconnected` for as long as a dial or a bind takes, which made that state useless as a guard: a second `/link-connect`, a retry timer or a startup connect could open another socket and register the same terminal twice, a socket that opened after `/link-disconnect` still joined the link, a superseded socket's close could tear down the connection that replaced it, and a server that finished binding after a disconnect still became the hub. One private attempt now owns every pending transport across the client-then-hub sequence; callers arriving while it runs join it instead of starting their own; disconnect and shutdown invalidate it and physically close what it had pending; and only the established socket or server may deliver messages, accept clients or clear connection state. The opening handshake is also bounded at 5 seconds, so a listener that accepts the connection and never upgrades no longer leaves the terminal offline forever with no retry - it fails the attempt and the fallback continues. Delivery, routing, naming and the 2-5 second retry are unchanged.

- **A remote compact request can no longer land on a terminal Pi is still working.** Pi's own idle state now authorizes the request instead of pi-link's view of the agent run. `agent_end` arrives while Pi may still auto-retry, run an automatic compaction, or drain a queued continuation inside the same run, and a request accepted in that window called `ctx.compact()` concurrently with work already in progress — which aborts it and compacts the same branch twice. Requests arriving then are declined as `busy`. The narrower window before Pi announces a *local manual* compaction remains open, and remains upstream debt: Pi aborts, authorizes and prepares before it tells extensions anything, and a compaction of its own is not reentrancy-safe.

- **A terminal reports `thinking` until Pi says the run is settled, not until the visible turn ends.** It previously went `idle` at `agent_end`, advertising itself as free while an automatic retry, an automatic compaction or a queued continuation was still running, and `link_list` showed that to every peer. Idle is now published on Pi's `agent_settled`, and only when that event's context still reports the session idle — so a run another extension starts during settlement keeps reporting `thinking` instead of being overwritten. A tool call left unmatched when the turn ends still falls back to `thinking` rather than staying pinned. Message delivery is unchanged: automatic compaction stays ungated and Pi keeps owning the steering and draining of link messages.

- **Status stays truthful while several tools run at once.** Active calls are tracked per call, so `tool:<name>` names the first still-active call Pi reported, advances only when that displayed call ends, and stays a tool status until the last call ends. Previously one call finishing could drop the reported status back to `thinking` while others were still running. Two calls with the same tool name hand over without resetting the reported duration. Nothing changed on the wire or in how status is displayed.

---

## 0.2.0 — 2026-07-17

### Added

- **`pi-link --version` prints the installed package version.** It writes the bare semver to stdout and exits successfully, so users can identify the installed build during testing.

### Breaking

- **Removed the deprecated `pi-link list` and `pi-link resolve <name>` command forms.** They now error with migration guidance; use `pi-link --list` and `pi-link --resolve <name>` instead. The canonical flag forms are unchanged.

### Changed

- **The wrapper no longer reserves legacy `--all` / `-a` flags.** Before a session name, they receive the normal unknown-argument error; after a session name, they pass through to Pi unchanged. Use `--global` / `-g` for pi-link's cross-directory session lookup.

### Fixed

- **Malformed saved link names no longer crash startup.** A non-string `link-name` session entry is ignored and naming falls through to the session name or random default; well-formed name precedence is unchanged.

---

## 0.1.17 — 2026-07-01

### Changed

- **`link_send` now rejects self-targets.** Sending to your own link name returns an immediate `self_target` error instead of delivering the message back to yourself, matching the existing `link_prompt` and `link_compact` behavior.

### Fixed

- **Disconnected link tool calls are now marked as errors.** `notConnectedResult()` tags `error: "not_connected"`, so callers and renderers treat a disconnected call as a failure instead of a success-looking result.
- **Hub ignores duplicate `register` messages.** A second `register` on an already-registered client socket is now dropped instead of re-running the join flow (which could reassign the name and emit a spurious re-join).
- **`link_prompt` and `link_compact` honor an already-aborted signal.** Both tools now check `signal.aborted` at the top of `execute` and return an `error: "aborted"` result immediately, rather than starting work that was cancelled before it began.

### Internal

- Removed the unused `ExtensionContext` parameter from `shouldConnect()`.
- Clarified the keepalive comment: it presumes `sendUserMessage()` starts a run, with the sender's 30-minute hard ceiling as the backstop if it ever doesn't.

---

## 0.1.16 — 2026-06-09

### Added

- **`link_compact` tool — ask another terminal to compact its context window and wait until it finishes.** A fourth LLM tool alongside `link_send`, `link_prompt`, and `link_list`. The call blocks until the target reports compaction complete, so an orchestrator can immediately dispatch follow-up work to a freshly trimmed worker without sleeping or polling. Busy targets (mid-turn or already compacting) decline instead of being interrupted; self-targets are rejected with a pointer to `/compact`; unknown targets resolve immediately as `not_found`; the call times out after 180 seconds. Compact several workers at once via parallel tool calls. Adds `compact_request` / `compact_response` wire messages, both hub-forwarded with an authoritative `from`.

### Changed

- **`/link-name` now collapses internal whitespace.** Leading and trailing whitespace is stripped, and runs of internal whitespace collapse to a single space. `/link-name "build   lead"` saves and shows as `build lead`. Startup names (`--link-name`), saved-name load, saved-name comparison, and the `/link-name` command all normalize identically via a shared `normalizeName()` helper — so a saved name with stray spaces compares equal to its trimmed/collapsed form and won't trigger a redundant append on resume.

### Fixed

- **Hub no longer broadcasts spurious `terminal_left` for already-removed clients.** The hub's WebSocket close handler now looks up the client in live hub state instead of a closure variable captured at register time. If the socket has no live entry — a duplicate or post-removal close event (e.g. a close firing after the error handler's own `close()`) — it's ignored. Previously this could produce phantom "X left" notifications and drift `connectedTerminals` between hub and clients.

### Internal

- **Behavior-identical refactors.** Shared helpers (`targetNotFound`, `renderIconResult`, `latestCustomData`) extracted to remove duplication across tool execute/render paths and session-entry scans. `pushStatus()` skips the `captureContext()` call on no-op pushes. `CompactResponseMsg.reason` comment updated to include `"unsupported"`. No user-visible behavior change.

---

## 0.1.15 — 2026-05-18

Stable release for the 0.1.15 cycle, promoted after beta soak.

### Install note for Pi 0.75+

Pi 0.75 installs Pi packages under `~/.pi/agent/npm/`, so `pi install npm:pi-link` still enables the in-Pi extension features (`/link*`, tools, `--link`) but no longer puts the `pi-link` shell launcher on PATH.

If you use `pi-link <name>` from your shell, also install the launcher globally:

```sh
npm i -g pi-link
```

Users who only use pi-link inside Pi do not need this extra step. Background: [pi-mono#4587](https://github.com/earendil-works/pi-mono/issues/4587).

### Breaking

- **Pi 0.74+ is now required.** pi-link now uses the `@earendil-works/*` Pi package namespace. Users on Pi ≤0.73 should pin `pi-link@0.1.14`.

### Added

- **`--list` and `--resolve <name>` flag forms for the `pi-link` CLI wrapper.** Use instead of the `list` / `resolve` subcommands. `--resolve=<name>` joined form also accepted. This fixes the reserved-word collision that prevented sessions named `list` or `resolve`, and the silent-typo failure mode where `pi-link resolv foo` would create a session called `resolv` and pass `foo` as a prompt to Pi.

  ```
  pi-link --list [--global|-g]
  pi-link --resolve <name> [--global|-g]
  pi-link --resolve=<name>
  ```

### Changed

- **Removed Pi peer dependencies from `package.json`.** Pi provides its own extension APIs at load time; declaring them as npm peers caused unnecessary install warnings and duplicate package installs. `ws` remains the only runtime dependency.
- **`pi-link --resolve <missing-name>` now exits with code `2`** (was `0`). Single match still exits `0`; ambiguous still exits `1`; not found is now distinguishable from success in scripts. The legacy `pi-link resolve <missing-name>` form gets the same fix.
- **`pi-link <name> <extra-positional>` now errors** instead of silently passing the extra to Pi as a prompt. Catches typos like `pi-link resolv foo`. Tokens that follow a flag without `=` are still accepted as that flag's value (e.g. `pi-link worker --model opus` works). Use `--` to pass bare positionals through unchanged: `pi-link worker -- some-arg`.
- **`pi-link foo --help` now errors** with "cannot combine session name and --help" instead of silently passing `--help` to Pi. Run `pi --help` for Pi's own help.
- **Published tarball trimmed to 7 files.** Explicit `files` allowlist so internal planning artifacts and the test harness no longer ship to npm.

### Deprecated

- **`pi-link list` and `pi-link resolve` subcommands.** Use `--list` / `--resolve` instead. Subcommands still work for one release with a stderr deprecation warning, then will be removed.

### Migration from 0.1.14

Existing launcher aliases keep working for this release, but deprecated `list` / `resolve` subcommands now print a stderr warning.

One behavior change may affect scripts: `pi-link resolve <missing>` now exits `2` instead of `0`, so callers that trusted exit `0` to mean "found" should update their handling.

To silence the deprecation warning, switch to the flag form:

| Old                            | New                                                                |
| ------------------------------ | ------------------------------------------------------------------ |
| `pi-link list`                 | `pi-link --list`                                                   |
| `pi-link list -g`              | `pi-link --list -g`                                                |
| `pi-link resolve foo`          | `pi-link --resolve foo`                                            |
| `pi-link resolve foo -g`       | `pi-link --resolve foo -g`                                         |
| `pi-link resolve --global foo` | `pi-link --resolve foo --global` (order matters in canonical form) |

---

## 0.1.15-beta.0 — 2026-05-17 _(pulled — do not install)_

Initial 0.1.15 beta, superseded by `0.1.15`.

**Issue:** peer dependencies still pointed at the old `@mariozechner/*` namespace, causing npm to install deprecated Pi 0.73 packages on Pi 0.74+ systems.

**Resolution:** stable `0.1.15` uses the `@earendil-works/*` runtime imports and removes Pi npm peer dependencies.

---

## 0.1.14 — 2026-05-04

### Added

- **`--link-name <name>` flag for link-only startup naming.** Run `pi --link-name worker` to join the link as `worker` while leaving Pi's normal session selection/resume behavior untouched. This restores link-name startup naming in a cleaner form than the previous session-coupled implementation: it sets only the pi-link identity, with hub collision handling unchanged. Use `pi-link <name>` when you want the combined session-by-name + link-name workflow. Empty or whitespace-only `--link-name` values are rejected with a clear error. The `pi-link` wrapper itself does not accept `--link-name` — its rejection message now points to either `pi-link <name>` (combined) or `pi --link-name <name>` (direct, link-only).

### Changed

- **`link-name` session entries no longer accumulate on no-op restarts.** Both `pi-link <name>` and `pi --link-name <name>` skip the append when the saved name already matches. Sessions opened and exited without any persisted activity will no longer bump `pi-link list` recency from the same-name startup alone; recency still updates on messages, tool calls, edits, and real link-name changes.

---

## 0.1.13 — 2026-05-03

### Fixed

- **`pi-link resolve <name>` now rejects whitespace-only names.** Previously a name that normalized to empty (e.g. `pi-link resolve "   "`) fell through to session lookup and silently reported no match. The empty-name check that already covered `pi-link <name>` now also runs in `resolve`, printing usage and exiting non-zero.
- **README wording: session-dir lookup phrasing tightened** to say "matches Pi's lookup order" instead of "mirrors Pi's".

---

## 0.1.12 — 2026-05-03

### Changed

- **TypeBox import migrated from `@sinclair/typebox` to `typebox`.** Pi 0.69.0 migrated to typebox 1.x's bare-package name; `@sinclair/typebox` still resolves to the same module via Pi's legacy alias, so behavior is unchanged for our root `Type.*` imports. Aligns with Pi's preferred naming and avoids future churn if the alias is dropped. README's "Provided by Pi" table updated to match.

### Fixed

- **`pi-link list/resolve/<name>` now respect Pi's session-dir configuration.** The CLI hardcoded `~/.pi/agent/sessions` and ignored Pi's actual lookup chain, so users with a custom session location saw "no sessions" from `list`/`resolve` and — worse — `pi-link <name>` silently started a new session instead of resuming the existing one, fragmenting history into orphans across the real session dir. Resolution now matches Pi's lookup order (minus `--session-dir`, which the CLI rejects): `PI_CODING_AGENT_SESSION_DIR` → `<cwd>/.pi/settings.json` `sessionDir` → `<agentDir>/settings.json` `sessionDir` → default `<agentDir>/sessions/<encoded-cwd>`. `<agentDir>` follows `PI_CODING_AGENT_DIR`. Tilde expansion (`~`, `~/...`) matches Pi's `expandTildePath`. Custom layouts are scanned flat; default keeps the encoded-cwd subdirs. Malformed `settings.json` warns to stderr and falls through. Empty env vars and empty/non-string `sessionDir` values are treated as absent.
- **`pi-link <name>` now rejects Pi-managed flags even when passed as the first token.** Previously `pi-link --link-name foo` or `pi-link --session path` silently treated the flag as a session name. The validation that already covered later flags now also runs on the first token, with the same error messages.
- **`pi-link <name>` and `pi-link resolve <name>` now scope name lookup to the current cwd by default; `--global` / `-g` widens to any cwd.** Previously both commands scanned every session everywhere, so `pi-link work` from `~/projects/A` would silently resume `~/projects/B`'s `work` session if no local match existed — mixing one cwd's files into another cwd's session history. By default only current-cwd matches are considered; `--global` restores cross-cwd lookup, with duplicate exact names still failing with candidates. When `pi-link <name>` finds no local match but matches exist elsewhere, it warns and points at `--global` instead of silently jumping. `--global` may be passed before or after the name. `pi-link resolve` now also rejects extra positional arguments and unknown flags. **Breaking change**: `pi-link list --all` is renamed to `pi-link list --global` (`-a` → `-g`) for consistency across the three commands. As a transition aid, `--all` / `-a` are explicitly rejected with a pointer to the new flag name (mirroring the `--link-name was removed` treatment) so users with muscle memory get a clear hint instead of a generic "Unknown argument".
- **Hub now uses its authoritative socket→name mapping when forwarding chat/prompt messages.** Previously the hub forwarded `chat`, `prompt_request`, and `prompt_response` with whatever `from` the client claimed, while normalizing `status_update` against its socket→name mapping. The asymmetry meant a client with a stale or optimistic local `terminalName` could leak the wrong sender to other terminals — and under a rename-to-taken-name race, prompt responses could route back to the wrong terminal entirely. Hub now spread-normalizes `from` for all routed client messages, matching the existing `status_update` pattern.
- **`/link-name` no longer updates local `terminalName` before the hub confirms the rename.** Previously the client branch optimistically set `terminalName = newName` before reconnect, so during the close→reconnect→welcome window `/link` and `link_list` would report the requested name even if the hub later deduped it. Local identity now stays at the pre-rename value until `welcome` arrives. Notification wording updated from "Reconnecting as" to "Reconnecting, requesting" to reflect that the hub may assign a different name.
- **Hub promotion now preserves a pending client rename request.** Same-release follow-up to the previous bullet: with `terminalName` no longer updated optimistically, a client whose previous hub vanished mid-rename and who then wins hub promotion via `startHub` would otherwise have announced under the old local name. A `pendingClientRename` flag, set in `/link-name` and cleared on `welcome`, lets `startHub` adopt the requested name only when a rename was in flight. Hub-assigned deduped names from prior welcomes are otherwise preserved — no general `preferredName` replay.

---

## 0.1.11 — 2026-04-27

### Added

- **`pi-link list` command.** Lists pi-link sessions in the current cwd. Use `--all` (or `-a`) to list sessions across all directories — adds a CWD column with `~` substituted for `$HOME`. Shows name, last-modified time, message count, and short ID. Sessions are detected by presence of a `link-name` entry. ANSI styling (bold headers, dim secondary columns) in TTY; plain when piped (`NO_COLOR` honored).

---

## 0.1.10 — 2026-04-26

### Changed

- **`pi-link start <name>` simplified to `pi-link <name>`.** Resolves session by name and launches Pi directly. `pi-link resolve <name>` available for machine-readable path-only output. Rejects conflicting flags (`--session`, `--continue`, etc.).

- **`--link-name` flag replaced with `PI_LINK_NAME` env var.** The flag was a footgun — `pi --link-name worker-1` created duplicate sessions on every run. Now `pi-link <name>` passes the name via env var internally. Users should use `pi-link <name>` or `/link-name` mid-session.

### Fixed

- **Stale extension context crash on startup.** WebSocket callbacks could fire after Pi invalidated the extension context (~1ms after `session_start` returns), causing unhandled exceptions that killed the process. Fixed with deferred startup connect, safe context helpers, and `disposed` guards on all WebSocket callback sites.

---

## 0.1.9 — 2026-04-23

### Added

- **`--link-name <name>` flag.** Connect to link with a chosen terminal name on startup. Implies `--link`. Persists the name and sets the Pi session name if currently unnamed. Session resume by name is handled separately by the `pi-link` CLI. Name precedence: `--link-name` > saved `/link-name` > session name > random `t-xxxx`.

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
