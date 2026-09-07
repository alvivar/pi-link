/**
 * Pi Link — WebSocket-based inter-terminal communication
 *
 * Connects multiple Pi terminals over a local WebSocket link.
 * Opt-in via --link flag, --link-name flag, pi-link CLI, or /link-connect command.
 * First terminal to connect becomes the hub; others join as clients.
 * Hub loss triggers automatic promotion of a surviving client.
 *
 * Tools: link_send, link_list, link_compact
 * Commands: /link, /link-name, /link-connect, /link-disconnect
 */

import {
  VERSION as PI_VERSION,
  keyHint,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Text, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as crypto from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import * as os from "node:os";

import { WebSocket, WebSocketServer } from "ws";

// ─── Constants ───────────────────────────────────────────────────────────────

// Pi 0.84.2 is the floor: `agent_settled` and `ctx.isIdle()` are the whole basis of
// the settled lifecycle and the remote-compaction guard below, and there is one code
// path for them. Package installation does not check the host version, so an older
// Pi installs pi-link successfully and must be refused at load.
const MIN_PI_VERSION = [0, 84, 2];

const DEFAULT_PORT = 9900;
const COMPACT_TIMEOUT_MS = 180_000;
const RECONNECT_DELAY_MS = 2000;
// Bounds the HTTP Upgrade only. Without it `ws` waits forever, so a listener that
// accepts the socket and never answers leaves the terminal offline with no retry.
const CONNECT_HANDSHAKE_TIMEOUT_MS = 5_000;
const FLUSH_DELAY_MS = 200;
const BATCH_MAX_ITEMS = 20;
const BATCH_MAX_CHARS = 16_000;
// Visual rows of an incoming message kept while Pi's global expansion is off.
const PREVIEW_ROWS = 6;

// ─── Protocol ────────────────────────────────────────────────────────────────

interface RegisterMsg {
  type: "register";
  name: string;
  cwd?: string;
  context?: ContextSnapshot;
}
interface WelcomeMsg {
  type: "welcome";
  name: string;
  terminals: string[];
  statuses?: Record<string, LinkStatus>;
  cwds?: Record<string, string>;
  contexts?: Record<string, ContextSnapshot>;
}
interface TerminalJoinedMsg {
  type: "terminal_joined";
  name: string;
  terminals: string[];
  cwd?: string;
  context?: ContextSnapshot;
}
interface TerminalLeftMsg {
  type: "terminal_left";
  name: string;
  terminals: string[];
}
interface ChatMsg {
  type: "chat";
  from: string;
  to: string;
  content: string;
}
interface StatusUpdateMsg {
  type: "status_update";
  name: string;
  status: LinkStatus;
  // Per-terminal LLM context. Absent = old terminal (ignore); null = clear
  // stored value; object = store. Only status_update carries the null-clear.
  context?: ContextSnapshot | null;
}
interface ErrorMsg {
  type: "error";
  message: string;
}
interface CompactRequestMsg {
  type: "compact_request";
  id: string;
  from: string;
  to: string;
  instructions?: string;
}
interface CompactResponseMsg {
  type: "compact_response";
  id: string;
  from: string;
  to: string;
  ok: boolean;
  reason?: string; // "busy" | "not_found" | "unsupported" | error text; absent on success
}

type LinkStatus =
  | { kind: "idle"; since: number }
  | { kind: "thinking"; since: number }
  | { kind: "compacting"; since: number }
  | { kind: "tool"; toolName: string; since: number };

type ContextSnapshot = { tokens: number | null; contextWindow: number };

type LinkMessage =
  | RegisterMsg
  | WelcomeMsg
  | TerminalJoinedMsg
  | TerminalLeftMsg
  | ChatMsg
  | StatusUpdateMsg
  | ErrorMsg
  | CompactRequestMsg
  | CompactResponseMsg;

/**
 * True when Pi is at or above MIN_PI_VERSION. A fixed floor needs an ordered compare
 * of three numbers, not a semver dependency — but it does need SemVer's shape, so the
 * core rejects leading zeros, an optional prerelease is captured because it lowers
 * precedence, and optional build metadata is matched and then ignored because it
 * carries none. A prerelease of the floor itself precedes it, so `0.84.2-beta.1` is
 * below `0.84.2` while `0.85.0-beta.1` is above it on its core alone. Each suffix is
 * a dot-separated series of nonempty identifiers, so `0.84.2+.` and `0.85.0-alpha..1`
 * are malformed. Anything unparsable, or with a component too large to compare
 * exactly, is refused rather than guessed at.
 */
function piVersionSupported(version: string): boolean {
  const parsed =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version.trim(),
    );
  if (!parsed) return false;
  // A numeric prerelease identifier may not carry a leading zero. `0rc` may, being
  // alphanumeric, and so may a build identifier, which never affects precedence.
  const prerelease = parsed[4];
  if (prerelease?.split(".").some((id) => /^0\d+$/.test(id))) return false;
  for (let i = 0; i < 3; i++) {
    const part = Number(parsed[i + 1]);
    if (!Number.isSafeInteger(part)) return false;
    if (part !== MIN_PI_VERSION[i]) return part > MIN_PI_VERSION[i];
  }
  return prerelease === undefined; // exactly the floor: only the release qualifies
}

/**
 * The first PREVIEW_ROWS rows of `content`, plus a hint when rows were dropped.
 *
 * The rows come from rendering `content` at the real width, not from splitting the
 * raw string on newlines: one long logical line wraps into many visual rows, and
 * the same message yields different rows in a narrow window. Rendering is Text's
 * job here, cached by (text, width), so the preview stays a slice of the identical
 * output the expanded view shows.
 */
function messagePreview(
  content: Text,
  dim: (text: string) => string,
): Component {
  const hint = new Text("", 0, 0);
  return {
    render(width: number): string[] {
      const rows = content.render(width);
      if (rows.length <= PREVIEW_ROWS) return rows;
      // Rebuilt every render so a rebound key is never shown stale; it is one short
      // line, and Text still caches the content rows, which are the expensive part.
      hint.setText(
        dim(`... (${rows.length - PREVIEW_ROWS} more lines, `) +
          keyHint("app.tools.expand", "to expand") +
          dim(")"),
      );
      // The budget covers content only, so the hint may wrap rather than be cut off.
      return [...rows.slice(0, PREVIEW_ROWS), ...hint.render(width)];
    },
    invalidate(): void {
      content.invalidate();
      hint.invalidate();
    },
  };
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // First statement, so an unsupported host leaves behind no flag, event, tool,
  // command, timer or socket to half-run with. Pi reports a factory that throws as an
  // extension load error naming this message, and keeps running without pi-link.
  if (!piVersionSupported(PI_VERSION)) {
    throw new Error(
      `pi-link requires Pi >=${MIN_PI_VERSION.join(".")} (detected ${PI_VERSION || "unknown"}); ` +
        `upgrade Pi, or pin pi-link 0.2.x for Pi 0.74–0.84.1.`,
    );
  }

  pi.registerFlag("link", {
    description: "Connect to link on startup",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("link-name", {
    description:
      "Set the pi-link terminal name on startup (link identity only; does not affect session)",
    type: "string",
  });

  // ── State ────────────────────────────────────────────────────────────────

  let role: "hub" | "client" | "disconnected" = "disconnected";
  let terminalName = `t-${crypto.randomUUID().slice(0, 4)}`;
  let preferredName: string | null = null;
  // True between a client `/link-name` close and the next welcome/promotion.
  // Lets `startHub` adopt the requested name if it wins promotion before welcome.
  let pendingClientRename = false;
  let connectedTerminals: string[] = [];
  let ctx: ExtensionContext | undefined;
  let disposed = false;
  let manuallyDisconnected = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let startupConnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Status tracking (local truth)
  let agentRunning = false; // agent_start until agent_settled, not until agent_end
  let compactRunning = false; // true while compacting for a remote request
  let localCompacting = false; // true while compacting for a human /compact
  let compactDeadline: ReturnType<typeof setTimeout> | undefined;
  let wasCompactionGated = false; // gate state syncCompactionStatus() last acted on
  // toolCallId → toolName. Pi runs tools in parallel by default and both tool
  // events carry the call id, so one slot per call is the only way an end can clear
  // the call it belongs to. Insertion-ordered, which is what picks the display.
  const activeTools = new Map<string, string>();
  let stateSince = Date.now();
  let lastPushedStatus: string | null = null; // identity of the last published status
  const terminalStatuses = new Map<string, LinkStatus>(); // other terminals
  const terminalContexts = new Map<string, ContextSnapshot>(); // other terminals' context
  let currentCwd = "";
  const terminalCwds = new Map<string, string>(); // other terminals' cwds

  // Hub state
  let wss: WebSocketServer | null = null;
  // The hub owns the HTTP server the WS server rides on, because `wss.close()`
  // never closes a server it was handed. Nulled wherever `wss` is.
  let hubHttpServer: HttpServer | null = null;
  const hubClients = new Map<WebSocket, string>(); // ws → terminal name
  const hubTerminalStatuses = new Map<string, LinkStatus>(); // hub-authoritative
  const hubTerminalContexts = new Map<string, ContextSnapshot>(); // hub-authoritative
  const hubTerminalCwds = new Map<string, string>(); // hub-authoritative (excludes self)

  // Client state
  let ws: WebSocket | null = null;

  // Establishment. One attempt owns every pending transport across the whole
  // client-then-hub sequence, because a transport can emit callbacks from
  // construction onward while `ws`/`wss` are still empty. The record itself is the
  // generation token: a callback that captured it can tell whether it is still the
  // current owner by identity alone, and cancellation has handles to close.
  type ConnectionAttempt = {
    promise: Promise<void>;
    socket: WebSocket | null; // dialing, not yet `ws`
    server: WebSocketServer | null; // binding, not yet `wss`
    httpServer: HttpServer | null; // binding, not yet `hubHttpServer`
  };
  let connectionAttempt: ConnectionAttempt | null = null;

  // Pending compact responses (sender waiting for remote compaction to finish)
  const pendingCompactResponses = new Map<
    string,
    {
      resolve: (result: {
        content: { type: "text"; text: string }[];
        details: Record<string, unknown>;
      }) => void;
      targetName: string;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  // Inbox: fixed-window batching; every batch is delivered to the receiver's model
  const inbox: { from: string; content: string }[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Helpers ──────────────────────────────────────────────────────────────

  function getUi() {
    if (!ctx) return null;
    try {
      return ctx.ui;
    } catch {
      return null;
    }
  }

  function isRuntimeLive() {
    return !disposed && getUi() !== null;
  }

  function notify(message: string, level: "info" | "warning" | "error") {
    getUi()?.notify(message, level);
  }

  function updateStatus() {
    const ui = getUi();
    if (!ui) return;
    const theme = ui.theme;
    const count = connectedTerminals.length;
    const info =
      role === "disconnected"
        ? "link: offline"
        : `link: ${terminalName} (${role}) · ${count} terminal${count !== 1 ? "s" : ""}`;
    ui.setStatus("link", theme.fg("dim", info));
  }

  function deriveStatus(): LinkStatus {
    // Highest precedence, so that reporting "compacting" and deferring delivery are
    // the same condition rather than two that can disagree. In reachable states it
    // competes only with "idle" — a compaction runs with no tool and no agent run —
    // but where it could overlap, the gate is the more actionable fact: work sent
    // here waits, and link_compact declines.
    if (compactionGated()) return { kind: "compacting", since: stateSince };
    const tool = displayedTool();
    if (tool) return { kind: "tool", toolName: tool, since: stateSince };
    if (agentRunning) return { kind: "thinking", since: stateSince };
    return { kind: "idle", since: stateSince };
  }

  /**
   * The tool a peer is shown while several run at once: the first still active, by
   * start order. A later start never displaces it, so parallel work does not churn
   * the status; when it ends the next one takes over.
   */
  function displayedTool(): string | null {
    for (const name of activeTools.values()) return name;
    return null;
  }

  /**
   * The single definition of "the same status": what a peer sees, as one comparable
   * value. Both users of that question go through here — pushStatus() dedupes on it,
   * and every handler compares it before and after mutating to decide whether
   * stateSince moves. One function, so the clock and the wire cannot come to
   * disagree about what changed; restarting the clock on a change nobody can see
   * would publish nothing now and make the next push carry a duration nobody
   * observed. Two calls of the same tool handing over are one status by this rule.
   *
   * The two forms cannot collide: every non-tool kind is a fixed literal from the
   * LinkStatus union with no colon in it, and the tool form is always prefixed, so
   * no toolName can spell a kind.
   */
  function statusIdentity(s: LinkStatus): string {
    return s.kind === "tool" ? `tool:${s.toolName}` : s.kind;
  }

  function captureContext(): ContextSnapshot | undefined {
    if (!ctx) return undefined;
    if (typeof ctx.getContextUsage !== "function") return undefined; // older Pi
    const usage = ctx.getContextUsage();
    if (!usage) return undefined;
    if (usage.contextWindow <= 0) return undefined; // no real context to report
    return { tokens: usage.tokens, contextWindow: usage.contextWindow };
  }

  function pushStatus(force = false) {
    if (role === "disconnected") return;
    const status = deriveStatus();
    const identity = statusIdentity(status);
    if (!force && identity === lastPushedStatus) return;
    lastPushedStatus = identity;
    const context = captureContext(); // only when we actually push
    const msg: StatusUpdateMsg = {
      type: "status_update",
      name: terminalName,
      status,
      context: context ?? null, // explicit null tells peers to clear
    };
    if (role === "hub") {
      hubBroadcast(msg, terminalName);
    } else if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  // Canonicalize a link/session name: trim + collapse internal whitespace.
  // Returns undefined for nullish/blank so callers can fall through precedence.
  function normalizeName(name: string | undefined | null): string | undefined {
    const n = name?.trim().replace(/\s+/g, " ");
    return n ? n : undefined;
  }

  // Latest custom session entry of a given type (last-write-wins), or undefined.
  function latestCustomData(
    customType: string,
  ): Record<string, unknown> | undefined {
    if (!ctx) return undefined;
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i] as {
        type: string;
        customType?: string;
        data?: Record<string, unknown>;
      };
      if (e.type === "custom" && e.customType === customType) return e.data;
    }
    return undefined;
  }

  function formatDuration(since: number): string {
    const sec = Math.floor((Date.now() - since) / 1000);
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m`;
    return `${Math.floor(sec / 3600)}h`;
  }

  function formatStatus(s: LinkStatus): string {
    const dur = formatDuration(s.since);
    if (s.kind === "tool") return `tool:${s.toolName} (${dur})`;
    return `${s.kind} (${dur})`;
  }

  function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${Math.round(n / 1000)}K`;
    return `${n}`;
  }

  function formatContext(c: ContextSnapshot | null | undefined): string {
    if (!c || c.contextWindow <= 0) return ""; // guard against bad wire data
    const window = formatTokens(c.contextWindow);
    if (c.tokens === null) return `?/${window}`;
    const percent = Math.round((c.tokens / c.contextWindow) * 100);
    return `${formatTokens(c.tokens)}/${window} (${percent}%)`;
  }

  function getStatusFor(name: string): LinkStatus | null {
    if (name === terminalName) return deriveStatus();
    const map = role === "hub" ? hubTerminalStatuses : terminalStatuses;
    return map.get(name) ?? null;
  }

  function getCwdFor(name: string): string | null {
    if (name === terminalName) return currentCwd || null;
    if (role === "hub") return hubTerminalCwds.get(name) ?? null;
    return terminalCwds.get(name) ?? null;
  }

  function getContextFor(name: string): ContextSnapshot | null {
    if (name === terminalName) return captureContext() ?? null;
    if (role === "hub") return hubTerminalContexts.get(name) ?? null;
    return terminalContexts.get(name) ?? null;
  }

  function shortenPath(cwd: string): string {
    const home = os.homedir().replace(/\\/g, "/");
    const normalized = cwd.replace(/\\/g, "/");
    if (normalized === home) return "~";
    if (normalized.startsWith(home + "/"))
      return "~" + normalized.slice(home.length);
    return normalized;
  }

  // ── Startup connect ──────────────────────────────────────────────────────

  function scheduleStartupConnect() {
    if (startupConnectTimer) clearTimeout(startupConnectTimer);
    startupConnectTimer = setTimeout(() => {
      startupConnectTimer = null;
      if (!disposed && ctx) void initialize();
    }, 0);
  }

  // ── Inbox: batched delivery ──────────────────────────────────────────────

  // The first queued message opens the window and later arrivals join it, so the
  // deadline belongs to the message that started it. Rearming here instead would
  // make the window trailing-edge, and a stream whose gaps stay under the delay
  // could postpone delivery for as long as it kept arriving.
  function scheduleFlush(delay: number) {
    if (flushTimer) return;
    flushTimer = setTimeout(flushInbox, delay);
  }

  function flushInbox() {
    flushTimer = null;
    if (inbox.length === 0) return;
    if (!ctx) return;

    // Compacting: hold everything and return WITHOUT rescheduling. setCompacting()
    // drains on release, so polling a compaction that may run to the 180s ceiling
    // would be ~900 wakeups for no information.
    if (compactionGated()) return;

    // Select batch: up to BATCH_MAX_ITEMS, ~BATCH_MAX_CHARS total (soft cap —
    // first item always included even if oversized, others deferred to next flush)
    const batch: string[] = [];
    let totalChars = 0;
    for (let i = 0; i < inbox.length && batch.length < BATCH_MAX_ITEMS; i++) {
      const item = inbox[i];
      const text = `From "${item.from}":\n${item.content}`;
      if (batch.length > 0 && totalChars + text.length > BATCH_MAX_CHARS) break;
      batch.push(text);
      totalChars += text.length;
    }

    pi.sendMessage(
      {
        customType: "link",
        content: `[Link: ${batch.length} message(s) received]\n\n${batch.join("\n\n")}`,
        display: true,
        details: { batched: true, count: batch.length },
      },
      { triggerTurn: true },
    );
    inbox.splice(0, batch.length);

    // Items held back by the batch caps go out in the next window
    if (inbox.length > 0) {
      scheduleFlush(FLUSH_DELAY_MS);
    }
  }

  /**
   * True exactly while delivery is deferred. Also what the terminal reports as its
   * status, so availability and delivery cannot disagree.
   *
   * The two flags are not duplication. compactRunning is set synchronously by the
   * compact_request handler before it calls ctx.compact(), covering the window
   * before session_before_compact arrives; localCompacting covers a human /compact,
   * which pi-link never initiates.
   *
   * Both are load-bearing because Pi will not save us here: AgentSession.prompt()
   * refuses to run during compaction, but sendCustomMessage reaches _runAgentPrompt
   * directly and is not covered by that guard.
   */
  function compactionGated() {
    return localCompacting || compactRunning;
  }

  /**
   * Record a compaction gate transition. Call after any change to either flag.
   *
   * wasCompactionGated tracks the gate itself, deliberately NOT lastPushedStatus: the
   * two diverge exactly while disconnected, when pushStatus() returns before
   * recording anything, and a gate that opened and closed unseen would then leave
   * stateSince stranded at the moment compaction began. Entering and leaving are one
   * transition each, so the two flag moves of a remote compaction report once.
   *
   * The local record is updated whether or not publication is possible; pushStatus()
   * decides that separately.
   */
  function syncCompactionStatus() {
    const gated = compactionGated();
    if (gated === wasCompactionGated) return;
    wasCompactionGated = gated;
    stateSince = Date.now(); // the duration shown is of the compaction, not what preceded it
    pushStatus();
  }

  /**
   * Drain the inbox once NO gate remains. Call after clearing either flag.
   *
   * Both gates must be checked together, because a remote compact sets both:
   * ctx.compact() reaches Pi's compact(), which reports reason "manual", so
   * session_before_compact sets localCompacting on top of compactRunning. Pi emits
   * session_compact strictly before it resolves and fires onComplete, so releasing
   * on either flag alone can arm a flush that finds the other flag still standing,
   * returns without rescheduling, and strands the inbox with no release left.
   */
  function releaseInbox() {
    if (!localCompacting && !compactRunning && inbox.length > 0) {
      scheduleFlush(FLUSH_DELAY_MS);
    }
  }

  /**
   * Gate and release inbox delivery around a local manual compaction.
   *
   * The deadline is the only backstop. A failed manual compaction emits
   * `compaction_end` to session listeners only, never to extensions, and Pi
   * clears its compaction controller without aborting it — so success is the sole
   * positive ending an extension can observe. The timer handle must be explicit
   * and cleared on every transition: a bare setTimeout outlives its own
   * compaction and would release a *later* compaction's flag.
   *
   * COMPACT_TIMEOUT_MS is reused only to avoid a new constant. It shares a value
   * with the remote-request wait by coincidence, not by meaning.
   */
  function setCompacting(on: boolean) {
    localCompacting = on;
    clearTimeout(compactDeadline);
    compactDeadline = on
      ? setTimeout(() => setCompacting(false), COMPACT_TIMEOUT_MS)
      : undefined;
    // Release drains; it never polls. Nothing else wakes a waiting inbox.
    if (!on) releaseInbox();
    syncCompactionStatus();
  }

  // ── Connection intent ──────────────────────────────────────────────────

  function shouldConnect(): boolean {
    const data = latestCustomData("link-active") as
      | { active?: boolean }
      | undefined;
    if (data?.active !== undefined) return data.active;
    return pi.getFlag("link") === true;
  }

  // ── Pending compact helpers ──────────────────────────────────────────────

  function cleanupPendingCompact(requestId: string) {
    const pending = pendingCompactResponses.get(requestId);
    if (!pending) return null;
    clearTimeout(pending.timeout);
    pendingCompactResponses.delete(requestId);
    return pending;
  }

  function allTerminalNames(): Set<string> {
    const names = new Set<string>();
    names.add(terminalName); // hub's own name
    for (const name of hubClients.values()) names.add(name);
    return names;
  }

  function uniqueName(requested: string): string {
    const existing = allTerminalNames();
    if (!existing.has(requested)) return requested;
    let i = 2;
    while (existing.has(`${requested}-${i}`)) i++;
    return `${requested}-${i}`;
  }

  function terminalList(): string[] {
    return Array.from(allTerminalNames()).sort();
  }

  /**
   * Hub: the `GET /status` snapshot. Pure reads — it mutates nothing and sends
   * nothing, so observing the link cannot disturb it.
   *
   * Hub entry first, then clients sorted by name, so pollers see a stable order.
   * `status`/`sinceSeconds` and `cwd` are omitted rather than invented when the
   * hub has not heard them yet: a client is in `hubClients` from `register`, but
   * its first `status_update` arrives a round trip later, and reporting a fresh
   * peer as "idle" would be exactly the false inventory this endpoint exists to
   * remove.
   */
  function buildStatusPayload() {
    const now = Date.now();

    const describe = (name: string, entryRole: "hub" | "client") => {
      const status = getStatusFor(name);
      const cwd = getCwdFor(name);
      const context = getContextFor(name);
      return {
        name,
        role: entryRole,
        ...(status
          ? {
              status: statusIdentity(status),
              sinceSeconds: Math.round((now - status.since) / 1000),
            }
          : {}),
        ...(cwd ? { cwd } : {}),
        context: context
          ? { tokens: context.tokens, window: context.contextWindow }
          : null,
      };
    };

    return {
      hub: terminalName,
      port: DEFAULT_PORT,
      terminals: [
        describe(terminalName, "hub"),
        ...Array.from(hubClients.values())
          .sort()
          .map((name) => describe(name, "client")),
      ],
    };
  }

  function safeParse(data: string): LinkMessage | null {
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  // ── Routing ──────────────────────────────────────────────────────────────

  /** Hub: broadcast a message to every terminal except `excludeName`. */
  function hubBroadcast(msg: LinkMessage, excludeName?: string) {
    const json = JSON.stringify(msg);
    for (const [clientWs, name] of hubClients) {
      if (name !== excludeName) clientWs.send(json);
    }
    // Also deliver to the hub itself (unless excluded)
    if (excludeName !== terminalName) handleIncoming(msg);
  }

  /** Hub: find a client WebSocket by name. */
  function hubClientByName(name: string): WebSocket | undefined {
    for (const [clientWs, n] of hubClients) {
      if (n === name) return clientWs;
    }
    return undefined;
  }

  /**
   * Route a message to its destination. Works in both hub and client roles.
   * Returns true if the message was delivered (or sent to the hub for routing).
   * For the hub, this is authoritative. For clients, it's optimistic (hub may
   * still reject via protocol-level error responses).
   */
  function routeMessage(
    msg: ChatMsg | CompactRequestMsg | CompactResponseMsg,
  ): boolean {
    if (role === "hub") {
      if (msg.to === terminalName) {
        handleIncoming(msg);
        return true;
      }
      const targetWs = hubClientByName(msg.to);
      if (targetWs) {
        targetWs.send(JSON.stringify(msg));
        return true;
      }
      // Target not found — send error back to sender
      const errText = `Terminal "${msg.to}" not found`;
      const errorMsg: LinkMessage =
        msg.type === "compact_request"
          ? {
              type: "compact_response",
              id: msg.id,
              from: terminalName,
              to: msg.from,
              ok: false,
              reason: "not_found",
            }
          : { type: "error", message: errText };

      if (msg.from === terminalName) {
        // For compact_request, deliver the error response locally so the
        // matching pending map resolves. For chat, skip — the tool result
        // (via return false) is sufficient; no extra UI toast.
        if (errorMsg.type === "compact_response") handleIncoming(errorMsg);
      } else {
        hubClientByName(msg.from)?.send(JSON.stringify(errorMsg));
      }
      return false;
    }
    if (role === "client" && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true; // optimistic — hub will handle errors via protocol
    }
    return false;
  }

  // ── Incoming message handler (runs on every terminal) ────────────────────

  function handleIncoming(msg: LinkMessage) {
    switch (msg.type) {
      // ── Client receives after registering ──
      case "welcome":
        terminalName = msg.name;
        pendingClientRename = false;
        connectedTerminals = msg.terminals;
        terminalStatuses.clear();
        terminalCwds.clear();
        terminalContexts.clear();
        if (msg.statuses) {
          for (const [name, status] of Object.entries(msg.statuses)) {
            terminalStatuses.set(name, status);
          }
        }
        if (msg.cwds) {
          for (const [name, cwd] of Object.entries(msg.cwds)) {
            terminalCwds.set(name, cwd);
          }
        }
        if (msg.contexts) {
          for (const [name, c] of Object.entries(msg.contexts)) {
            terminalContexts.set(name, c);
          }
        }
        updateStatus();
        notify(
          `Joined link as "${terminalName}" (${connectedTerminals.length} online)`,
          "info",
        );
        pushStatus(true);
        break;

      // ── Membership updates ──
      case "terminal_joined":
        connectedTerminals = msg.terminals;
        if (role !== "hub" && msg.cwd) terminalCwds.set(msg.name, msg.cwd);
        if (role !== "hub" && msg.context)
          terminalContexts.set(msg.name, msg.context);
        updateStatus();
        notify(`"${msg.name}" joined the link`, "info");
        break;

      case "terminal_left":
        connectedTerminals = msg.terminals;
        terminalStatuses.delete(msg.name);
        if (role !== "hub") {
          terminalCwds.delete(msg.name);
          terminalContexts.delete(msg.name);
        }
        // Fail any pending compact request to the departed terminal
        for (const [id, pending] of pendingCompactResponses) {
          if (pending.targetName === msg.name) {
            const p = cleanupPendingCompact(id);
            if (p) {
              p.resolve(
                textResult(`Terminal "${msg.name}" disconnected`, {
                  to: msg.name,
                  error: "disconnected",
                }),
              );
            }
          }
        }
        updateStatus();
        notify(`"${msg.name}" left the link`, "info");
        break;

      // ── Status update from another terminal ──
      case "status_update":
        terminalStatuses.set(msg.name, msg.status);
        if (msg.context) terminalContexts.set(msg.name, msg.context);
        else if (msg.context === null) terminalContexts.delete(msg.name);
        break;

      // ── Chat message ──
      case "chat":
        inbox.push({ from: msg.from, content: msg.content });
        scheduleFlush(FLUSH_DELAY_MS);
        break;

      // ── Another terminal asks us to compact our context ──
      case "compact_request": {
        const { id, from } = msg;
        const respond = (ok: boolean, reason?: string) =>
          routeMessage({
            type: "compact_response",
            id,
            from: terminalName,
            to: from,
            ok,
            reason,
          });
        // Answered before the busy question, and not through finish(): no capability
        // and no context are refusals of a request we never took on, so nothing here
        // owns the gate to clear or the inbox to release.
        if (!ctx || !ctx.compact) {
          respond(false, "unsupported");
          break;
        }
        // Pi's idle state is the authority on whether this terminal is working.
        // agentRunning is not: Pi may still retry, run an automatic compaction, or
        // drain a queued continuation inside a run whose agent_end already fired, and
        // compact() would abort that work and compact the same branch a second time.
        // compactionGated() adds what Pi's idle flag cannot cover — a manual
        // compaction is not an agent run — and keeps declining while either gate
        // stands, so we never touch a compaction we did not start.
        if (!ctx.isIdle() || compactionGated()) {
          respond(false, "busy");
          break;
        }
        let finished = false;
        const finish = (ok: boolean, reason?: string) => {
          if (finished) return;
          finished = true;
          compactRunning = false;
          releaseInbox(); // last gate may clear here, after session_compact already fired
          // Only reverts status if localCompacting is also clear. A failure after
          // session_before_compact leaves it standing, so the terminal truthfully
          // keeps reporting compacting until the deadline or agent_start.
          syncCompactionStatus();
          respond(ok, reason);
        };
        compactRunning = true;
        syncCompactionStatus();
        notify(`"${from}" requested compact`, "info");
        // compact() aborts the current turn first, so the idle guard above
        // keeps us from interrupting active work. The runtime guarantees
        // exactly one of onComplete/onError fires, so compactRunning can't
        // get stuck and the sender won't hang.
        try {
          ctx.compact({
            customInstructions: msg.instructions,
            onComplete: () => finish(true),
            onError: (e) =>
              finish(false, e instanceof Error ? e.message : String(e)),
          });
        } catch (e) {
          finish(false, e instanceof Error ? e.message : String(e));
        }
        break;
      }

      // ── Response to a compact we requested ──
      case "compact_response": {
        const pending = cleanupPendingCompact(msg.id);
        if (pending) {
          // Use the requested target, not msg.from: a hub-synthesized
          // not_found response comes from the hub, not the worker.
          const target = pending.targetName;
          if (msg.ok) {
            pending.resolve(
              textResult(`Compacted "${target}"`, { to: target }),
            );
          } else {
            const reason = msg.reason ?? "failed";
            pending.resolve(
              textResult(`Compact on "${target}" not done: ${reason}`, {
                to: target,
                error: reason,
              }),
            );
          }
        }
        break;
      }

      case "error":
        notify(`Link: ${msg.message}`, "error");
        break;
    }
  }

  // ── Hub: handle a new client WebSocket ───────────────────────────────────

  function hubHandleClient(clientWs: WebSocket) {
    let clientName = "";

    clientWs.on("message", (raw) => {
      if (!isRuntimeLive()) return;
      const msg = safeParse(raw.toString());
      if (!msg) return;

      // First message must be register
      if (msg.type === "register") {
        if (clientName) return; // already registered — ignore duplicate
        clientName = uniqueName(msg.name);
        hubClients.set(clientWs, clientName);
        if (msg.cwd) hubTerminalCwds.set(clientName, msg.cwd);
        if (msg.context) hubTerminalContexts.set(clientName, msg.context);
        const list = terminalList();
        connectedTerminals = list;
        updateStatus();

        // Confirm to the new client (include status + cwd snapshots)
        const statuses: Record<string, LinkStatus> = {};
        statuses[terminalName] = deriveStatus(); // hub's own status
        for (const [name, status] of hubTerminalStatuses) {
          if (name !== clientName) statuses[name] = status;
        }
        const cwds: Record<string, string> = {};
        if (currentCwd) cwds[terminalName] = currentCwd; // hub's own cwd
        for (const [name, cwd] of hubTerminalCwds) {
          if (name !== clientName) cwds[name] = cwd;
        }
        const contexts: Record<string, ContextSnapshot> = {};
        const hubContext = captureContext();
        if (hubContext) contexts[terminalName] = hubContext; // hub's own context
        for (const [name, c] of hubTerminalContexts) {
          if (name !== clientName) contexts[name] = c;
        }
        clientWs.send(
          JSON.stringify({
            type: "welcome",
            name: clientName,
            terminals: list,
            statuses,
            cwds,
            contexts,
          } satisfies WelcomeMsg),
        );

        // Notify everyone else (include joiner's cwd + context)
        const joined: TerminalJoinedMsg = {
          type: "terminal_joined",
          name: clientName,
          terminals: list,
          cwd: msg.cwd,
          context: msg.context,
        };
        hubBroadcast(joined, clientName);
        return;
      }

      // Ignore messages from unregistered clients
      if (!clientName) return;

      // Status update — store and fan out to other clients only (not back to hub)
      if (msg.type === "status_update") {
        hubTerminalStatuses.set(clientName, msg.status);
        if (msg.context) hubTerminalContexts.set(clientName, msg.context);
        else if (msg.context === null) hubTerminalContexts.delete(clientName);
        const normalized: StatusUpdateMsg = {
          type: "status_update",
          name: clientName,
          status: msg.status,
          context: msg.context, // undefined omitted by JSON; null forwarded to clear
        };
        const json = JSON.stringify(normalized);
        for (const [otherWs, name] of hubClients) {
          if (name !== clientName) otherWs.send(json);
        }
        return;
      }

      // Route chat and compact messages.
      // Normalize `from` to the hub's authoritative socket→name mapping,
      // mirroring the status_update path above. Don't trust the client.
      if (
        msg.type === "chat" ||
        msg.type === "compact_request" ||
        msg.type === "compact_response"
      ) {
        routeMessage({ ...msg, from: clientName });
      }
    });

    clientWs.on("close", () => {
      if (disposed) return;
      const name = hubClients.get(clientWs);
      if (!name) return; // already removed (e.g. via disconnect) — ignore stale event
      hubClients.delete(clientWs);
      hubTerminalStatuses.delete(name);
      hubTerminalContexts.delete(name);
      hubTerminalCwds.delete(name);
      const list = terminalList();
      connectedTerminals = list;
      updateStatus();
      const left: TerminalLeftMsg = {
        type: "terminal_left",
        name,
        terminals: list,
      };
      hubBroadcast(left, name);
    });

    clientWs.on("error", () => {
      clientWs.close();
    });
  }

  // ── Start as hub ─────────────────────────────────────────────────────────

  function startHub(attempt: ConnectionAttempt): Promise<boolean> {
    return new Promise((resolve) => {
      // Owning the HTTP server is what makes `GET /status` possible: a port-bound
      // `WebSocketServer` builds its own and answers every plain request with 426.
      // `ws` forwards this server's `listening` and `error`, so the election below
      // is unchanged.
      const httpServer = createServer((req, res) => {
        if (req.method === "GET" && req.url === "/status") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(buildStatusPayload()));
          return;
        }
        res.writeHead(404);
        res.end();
      });
      attempt.httpServer = httpServer;

      const server = new WebSocketServer({ server: httpServer });
      attempt.server = server;

      // The phase settles once. `error` and a pre-listen `close` both report the
      // same failure, and closing a cancelled server reports it a third time.
      let settled = false;
      const settle = (established: boolean) => {
        if (settled) return;
        settled = true;
        if (attempt.server === server) attempt.server = null;
        if (attempt.httpServer === httpServer) attempt.httpServer = null;
        resolve(established);
      };

      server.on("listening", () => {
        if (!attemptIsCurrent(attempt)) {
          server.close();
          httpServer.close();
          settle(false);
          return;
        }
        wss = server;
        hubHttpServer = httpServer;
        // If a client `/link-name` was in flight when the previous hub vanished,
        // this terminal is now establishing hub identity, so honor that pending
        // request. Otherwise keep the last hub-assigned identity — don't replay
        // a stale `preferredName` that may already have been deduped.
        if (pendingClientRename && preferredName) terminalName = preferredName;
        pendingClientRename = false;
        role = "hub";
        connectedTerminals = [terminalName];
        updateStatus();
        notify(
          `Link hub started on :${DEFAULT_PORT} as "${terminalName}"`,
          "info",
        );
        settle(true);
      });

      server.on("connection", (clientWs) => {
        // Only the established hub may adopt a client. A cancelled listener can
        // still receive one while it unwinds, and teardown clears both of these.
        if (wss !== server || role !== "hub") {
          clientWs.close();
          return;
        }
        hubHandleClient(clientWs);
      });

      server.on("error", () => {
        // Port in use → someone else is the hub
        settle(false);
      });

      server.on("close", () => {
        // Reached when a pending server is cancelled; a no-op once established.
        settle(false);
      });

      // Last, so no forwarded event can arrive before its handler exists.
      httpServer.listen(DEFAULT_PORT, "127.0.0.1");
    });
  }

  // ── Connect as client ────────────────────────────────────────────────────

  function connectAsClient(attempt: ConnectionAttempt): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${DEFAULT_PORT}`, {
        handshakeTimeout: CONNECT_HANDSHAKE_TIMEOUT_MS,
      });
      attempt.socket = socket;

      // The phase settles once. A failed dial arrives as `error` then `close`, and
      // ws reports a handshake timeout the same way, so both must be idempotent.
      let settled = false;
      const settle = (established: boolean) => {
        if (settled) return;
        settled = true;
        if (attempt.socket === socket) attempt.socket = null;
        resolve(established);
      };

      socket.on("open", () => {
        if (!attemptIsCurrent(attempt)) {
          socket.close();
          settle(false);
          return;
        }
        // Pending becomes established in one step, so no other code can observe a
        // socket that is neither.
        ws = socket;
        role = "client";
        // Register with preferred name if available, otherwise current name
        socket.send(
          JSON.stringify({
            type: "register",
            name: preferredName ?? terminalName,
            cwd: currentCwd || undefined,
            context: captureContext(),
          } satisfies RegisterMsg),
        );
        settle(true);
      });

      socket.on("message", (raw) => {
        // Only the established socket speaks for this terminal; a cancelled or
        // superseded one is inert.
        if (ws !== socket || !isRuntimeLive()) return;
        const msg = safeParse(raw.toString());
        if (msg) handleIncoming(msg);
      });

      socket.on("close", () => {
        settle(false); // pre-open failure; a no-op once established
        if (ws !== socket) return; // a stale socket owns none of the state below
        ws = null;
        if (disposed) return;
        role = "disconnected";
        connectedTerminals = [];
        updateStatus();

        if (!manuallyDisconnected) {
          notify("Disconnected from link hub", "warning");
          scheduleReconnect();
        }
      });

      socket.on("error", () => {
        settle(false);
        socket.close();
      });
    });
  }

  // ── Initialize (auto-discover) ──────────────────────────────────────────

  /** True while `attempt` still owns establishment and the terminal still wants it. */
  function attemptIsCurrent(attempt: ConnectionAttempt): boolean {
    return connectionAttempt === attempt && !disposed && !manuallyDisconnected;
  }

  /**
   * Single-flight: startup, reconnect and `/link-connect` all join the one attempt
   * in flight instead of dialing again, because `role` stays "disconnected" for as
   * long as establishment takes and is therefore no guard at all.
   */
  function initialize(): Promise<void> {
    if (disposed || manuallyDisconnected) return Promise.resolve();
    if (connectionAttempt) return connectionAttempt.promise;
    // The record is the generation token, so it has to exist before the first
    // transport does; `promise` is replaced on the next line.
    const attempt: ConnectionAttempt = {
      promise: Promise.resolve(),
      socket: null,
      server: null,
      httpServer: null,
    };
    connectionAttempt = attempt;
    attempt.promise = runAttempt(attempt);
    return attempt.promise;
  }

  async function runAttempt(attempt: ConnectionAttempt) {
    try {
      // Try connecting to an existing hub
      if (await connectAsClient(attempt)) return;
      if (!attemptIsCurrent(attempt)) return;

      // No hub found — become the hub
      if (await startHub(attempt)) return;
      if (!attemptIsCurrent(attempt)) return;

      // Port busy but couldn't connect (rare race). Retry after delay.
      scheduleReconnect();
    } finally {
      // Only while still the owner: an attempt cancelled mid-flight must not clear
      // the slot a newer one has already taken.
      if (connectionAttempt === attempt) connectionAttempt = null;
    }
  }

  /**
   * Drop the attempt in flight. Invalidating it first means any callback arriving
   * while its transports unwind is already stale; closing the pending handles is
   * what makes those callbacks arrive at all, so the attempt settles instead of
   * being abandoned. Also clears both connect timers, so a disconnect before the
   * startup callback constructs nothing.
   */
  function cancelConnectionAttempt() {
    if (startupConnectTimer) {
      clearTimeout(startupConnectTimer);
      startupConnectTimer = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const attempt = connectionAttempt;
    if (!attempt) return;
    connectionAttempt = null;
    // Read every handle first: closing the WS server can settle the attempt, and
    // settling clears these fields. Closing the HTTP server is not optional — it
    // holds the port, so a skipped close squats :9900 for the whole machine.
    const { socket, server, httpServer } = attempt;
    socket?.close();
    server?.close();
    httpServer?.close();
  }

  function scheduleReconnect() {
    if (disposed || manuallyDisconnected || reconnectTimer) return;
    const delay = RECONNECT_DELAY_MS + Math.random() * 3000;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (role === "disconnected" && !disposed && !manuallyDisconnected)
        void initialize();
    }, delay);
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────

  function disconnect() {
    // Cancel establishment first, so nothing in flight can commit state behind us.
    // This also clears the reconnect and startup timers.
    cancelConnectionAttempt();

    // Clear link-owned remote compaction state; a local /compact survives disconnect.
    compactRunning = false;
    // Runs before role is cleared, so peers still get a final status; more to the
    // point, the local gate record stays honest for the reconnect.
    syncCompactionStatus();
    for (const id of [...pendingCompactResponses.keys()]) {
      const pending = cleanupPendingCompact(id);
      if (pending) {
        pending.resolve(
          textResult("Link disconnected", { error: "disconnected" }),
        );
      }
    }

    // Close client connection
    if (ws) {
      ws.close();
      ws = null;
    }

    // Close hub server
    if (wss) {
      for (const clientWs of hubClients.keys()) clientWs.close();
      hubClients.clear();
      wss.close();
      wss = null;
      hubHttpServer?.close();
      hubHttpServer = null;
    }

    role = "disconnected";
    connectedTerminals = [];
    terminalStatuses.clear();
    hubTerminalStatuses.clear();
    terminalContexts.clear();
    hubTerminalContexts.clear();
    terminalCwds.clear();
    hubTerminalCwds.clear();
    lastPushedStatus = null;
    updateStatus();

    // Inbox survives disconnect; flush unless a local /compact still gates it.
    if (!flushTimer) releaseInbox();
  }

  function cleanup() {
    disposed = true;
    // disconnect() cancels the attempt in flight, including the startup timer.
    disconnect();
    ctx = undefined;
    // Full teardown: clear inbox and both timers. The compaction deadline runs to
    // 180s, so it would otherwise outlive the extension and fire after teardown.
    inbox.length = 0;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    setCompacting(false);
  }

  // ── Lifecycle events ─────────────────────────────────────────────────────

  pi.on("session_start", async (_event, _ctx) => {
    ctx = _ctx;
    currentCwd = _ctx.cwd;

    // Resolve terminal name. Precedence:
    //   --link-name flag  >  PI_LINK_NAME env  >  saved link-name  >  session name  >  random
    //
    // --link-name is the public CLI surface (link identity only, never touches session name).
    // PI_LINK_NAME is the internal handoff from the `pi-link` wrapper, which DOES
    // seed session name when absent (the wrapper's combined-mode contract).
    // PI_LINK_NAME is consumed once and removed from process.env so spawned children don't inherit it.
    const cliRaw = pi.getFlag("link-name");
    let cliFlagName: string | undefined;
    if (typeof cliRaw === "string") {
      cliFlagName = normalizeName(cliRaw);
      if (!cliFlagName) {
        console.error("Error: --link-name requires a non-empty value.");
        process.exit(1);
      }
    }

    const envRaw = process.env.PI_LINK_NAME;
    delete process.env.PI_LINK_NAME;
    const envFlagName = normalizeName(envRaw);

    const flagName = cliFlagName ?? envFlagName;
    const fromEnv = !cliFlagName && !!envFlagName;

    if (flagName) {
      preferredName = flagName;
      terminalName = flagName;

      // Skip append if the saved name already matches; persistence is needed
      // only for first-time set or actual change. Reduces session-file growth
      // on repeated startups (common in automation).
      const latest = latestCustomData("link-name") as
        | { name?: unknown }
        | undefined;
      const latestSaved =
        typeof latest?.name === "string" ? latest.name : undefined;
      if (normalizeName(latestSaved) !== flagName) {
        pi.appendEntry("link-name", { name: flagName });
      }

      // Critical: only the env path (wrapper combined mode) seeds session name.
      // Public --link-name is link-only.
      if (fromEnv && !pi.getSessionName()) pi.setSessionName(flagName);
    } else {
      const saved = latestCustomData("link-name") as
        | { name?: unknown }
        | undefined;
      const savedName = normalizeName(
        typeof saved?.name === "string" ? saved.name : undefined,
      );
      if (savedName) {
        preferredName = savedName;
        terminalName = preferredName;
      } else {
        const sessionName = normalizeName(pi.getSessionName());
        if (sessionName) terminalName = sessionName;
      }
    }

    if (flagName || shouldConnect()) scheduleStartupConnect();
  });

  pi.on("session_shutdown", async () => {
    cleanup();
  });

  pi.on("agent_start", async () => {
    const before = statusIdentity(deriveStatus());
    agentRunning = true;
    // Safe only under the current deployment, not by Pi's guarantees:
    // AgentSession.prompt() refuses to run during compaction, and the only caller
    // of pi.sendMessage here — flushInbox() — is itself gated, so nothing can start
    // a run mid-compaction. Another extension calling pi.sendMessage with
    // triggerTurn: true would void that: its message starts a run during a
    // compaction, agent_start clears this flag, and delivery reopens into a
    // compaction that is still rebuilding context.
    setCompacting(false);
    activeTools.clear(); // defensive: a run cannot begin owing tools from the last one
    if (statusIdentity(deriveStatus()) !== before) stateSince = Date.now();
    pushStatus();
  });

  pi.on("session_before_compact", async (event) => {
    // Manual only. Automatic (threshold/overflow) compaction runs inside the agent
    // run, so a delivered message takes Pi's steering arm and _runAutoCompaction
    // returns hasQueuedMessages() to drain it afterwards. Gating it would replace a
    // working Pi path with our own.
    //
    // There is deliberately no abort listener: event.signal firing is not an ending.
    // Pi passes that signal into the summarizer and its compaction controller lives
    // until the catch/finally, so releasing on abort would re-open delivery while the
    // aborted compaction is still unwinding. A cancelled compaction is released by
    // the user's next run (agent_start) or by the deadline.
    //
    // Accepted gap: compact() aborts, authorises and prepares *before* emitting this
    // event, so a flush in that window can still start a turn against context about
    // to be rebuilt. The message itself survives — it is persisted and restored — so
    // only the turn is wasted. No heuristics to guess at the window. This is a
    // manual-compaction limit only; remote compaction is already gated by
    // compactRunning, set before ctx.compact() is ever called.
    if (event.reason === "manual") setCompacting(true);
  });

  pi.on("session_compact", async () => {
    setCompacting(false); // compaction succeeded
    // Tokens just dropped sharply — force a push so peers see the new context.
    pushStatus(true);
  });

  pi.on("tool_execution_start", async (event) => {
    const before = statusIdentity(deriveStatus());
    activeTools.set(event.toolCallId, event.toolName);
    if (statusIdentity(deriveStatus()) !== before) stateSince = Date.now();
    pushStatus();
  });

  pi.on("tool_execution_end", async (event) => {
    const before = statusIdentity(deriveStatus());
    activeTools.delete(event.toolCallId); // this call only; others may still run
    if (statusIdentity(deriveStatus()) !== before) stateSince = Date.now();
    pushStatus();
  });

  pi.on("agent_end", async () => {
    const before = statusIdentity(deriveStatus());
    // agentRunning deliberately survives this event. Pi may still auto-retry, run an
    // automatic compaction, or drain a queued continuation, all inside the same run;
    // reporting idle here would advertise a terminal that is still working.
    activeTools.clear(); // defensive: an unmatched end would otherwise pin the status
    if (statusIdentity(deriveStatus()) !== before) stateSince = Date.now();
    pushStatus();
  });

  pi.on("agent_settled", async (_event, settledCtx) => {
    // The authoritative end of a run: Pi emits this once no retry, compaction or
    // queued continuation is left. It can still be followed immediately by a new run
    // another extension started during settlement, whose agent_start already set the
    // flag we would be clearing — so ask Pi instead of assuming, and leave a newer
    // run reporting thinking.
    if (!settledCtx.isIdle()) return;
    const before = statusIdentity(deriveStatus());
    agentRunning = false;
    if (statusIdentity(deriveStatus()) !== before) stateSince = Date.now();
    pushStatus();
  });

  // ── Tool helpers ──────────────────────────────────────────────────────────

  function textResult(text: string, details: Record<string, unknown> = {}) {
    return { content: [{ type: "text" as const, text }], details };
  }

  function notConnectedResult() {
    return textResult("Not connected to link", { error: "not_connected" });
  }

  // Collapsed one-line preview for the two outgoing tools. Whitespace is normalized so a
  // multiline message stays on the tool's single preview line, then clipped to 60
  // characters. The hint appears only when characters are actually hidden: expanding shows
  // the original text, so collapsing whitespace alone is not something to advertise.
  // Styling is applied per segment, like messagePreview above: keyHint ends with a
  // foreground reset, so punctuation appended after it would render undimmed.
  function truncatePreview(text: string, dim: (text: string) => string) {
    const preview = text.replace(/\s+/g, " ");
    return preview.length > 60
      ? dim(preview.slice(0, 60) + "... (") +
          keyHint("app.tools.expand", "to expand") +
          dim(")")
      : dim(preview);
  }

  // Shared "target not found" result for the send/compact tools.
  // Returns null when the target is present, so callers can `if (miss) return miss;`.
  function targetNotFound(to: string) {
    return connectedTerminals.includes(to)
      ? null
      : textResult(
          `Terminal "${to}" not found. Connected: ${connectedTerminals.join(", ")}`,
          { to, error: "not_found" },
        );
  }

  // Shared ✓/✗ result renderer for link_send and link_compact.
  function renderIconResult(
    result: { content: { type: string; text?: string }[]; details?: unknown },
    theme: { fg(role: string, text: string): string },
  ) {
    const txt = result.content[0];
    const details = result.details as Record<string, unknown> | undefined;
    const icon = details?.error
      ? theme.fg("error", "✗ ")
      : theme.fg("success", "✓ ");
    return new Text(icon + (txt?.type === "text" ? txt.text : ""), 0, 0);
  }

  // ── Tools ────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "link_send",
    label: "Link Send",
    description: [
      "Send a message to one other Pi terminal on the link.",
      "The message always acts: it steers a busy receiver at its next safe boundary, or starts a turn on an idle one.",
    ].join(" "),
    promptSnippet:
      "Send a message to another Pi terminal on the local link network",
    parameters: Type.Object({
      to: Type.String({ description: "Target terminal name" }),
      message: Type.String({ description: "Message content" }),
    }),

    async execute(_toolCallId, params) {
      if (role === "disconnected") return notConnectedResult();

      // Pre-validate target exists locally (best-effort, catches typos and definitely-absent names)
      if (params.to === terminalName) {
        return textResult("Cannot send to yourself", {
          to: params.to,
          error: "self_target",
        });
      }
      const miss = targetNotFound(params.to);
      if (miss) return miss;

      const delivered = routeMessage({
        type: "chat",
        from: terminalName,
        to: params.to,
        content: params.message,
      });

      const target = `"${params.to}"`;
      if (!delivered) {
        return textResult(`Failed to send to ${target}`, {
          to: params.to,
          error: "not_delivered",
        });
      }
      // Hub delivery is authoritative; client delivery is optimistic (hub routes)
      const verb = role === "hub" ? "Sent to" : "Sent to hub for delivery to";
      return textResult(`${verb} ${target}`, { to: params.to });
    },

    renderCall(args, theme, context) {
      const dim = (text: string) => theme.fg("dim", text);
      const preview =
        typeof args.message === "string"
          ? context.expanded
            ? dim(args.message)
            : truncatePreview(args.message, dim)
          : dim("...");
      const text =
        theme.fg("toolTitle", theme.bold("link_send ")) +
        theme.fg("accent", args.to) +
        "\n  " +
        preview;
      return new Text(text, 0, 0);
    },

    renderResult: (result, _options, theme) => renderIconResult(result, theme),
  });

  pi.registerTool({
    name: "link_compact",
    label: "Link Compact",
    description: [
      "Ask another Pi terminal to compact its context window and wait until it finishes.",
      "Returns once the target has compacted, so you can immediately send it new work.",
      "A target declines unless Pi reports its session idle and no manual compaction holds its gate, so an active run, retry, automatic compaction, queued continuation or reported `compacting` all decline.",
    ].join(" "),
    promptSnippet: "Ask another Pi terminal to compact its context window",
    parameters: Type.Object({
      to: Type.String({ description: "Target terminal name" }),
      instructions: Type.Optional(
        Type.String({
          description: "Optional custom compaction instructions for the target",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) {
        return textResult("Compact request aborted", {
          to: params.to,
          error: "aborted",
        });
      }

      if (role === "disconnected") return notConnectedResult();

      if (params.to === terminalName) {
        return textResult("Cannot compact yourself - use /compact.", {
          to: params.to,
          error: "self_target",
        });
      }

      const miss = targetNotFound(params.to);
      if (miss) return miss;

      const requestId = crypto.randomUUID();

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          const pending = cleanupPendingCompact(requestId);
          if (pending) {
            pending.resolve(
              textResult(
                `Compact request to "${params.to}" timed out after ${COMPACT_TIMEOUT_MS / 1000}s; the target may still be compacting.`,
                { to: params.to, error: "timeout" },
              ),
            );
          }
        }, COMPACT_TIMEOUT_MS);

        pendingCompactResponses.set(requestId, {
          resolve,
          targetName: params.to,
          timeout,
        });

        signal?.addEventListener(
          "abort",
          () => {
            const pending = cleanupPendingCompact(requestId);
            if (pending) {
              pending.resolve(
                textResult("Compact request aborted", {
                  to: params.to,
                  error: "aborted",
                }),
              );
            }
          },
          { once: true },
        );

        const delivered = routeMessage({
          type: "compact_request",
          id: requestId,
          from: terminalName,
          to: params.to,
          instructions: params.instructions,
        });

        if (!delivered) {
          const pending = cleanupPendingCompact(requestId);
          if (pending) {
            pending.resolve(
              textResult(`Failed to request compact on "${params.to}"`, {
                to: params.to,
                error: "not_delivered",
              }),
            );
          }
        }
      });
    },

    renderCall(args, theme, context) {
      let text = theme.fg("toolTitle", theme.bold("link_compact "));
      text += theme.fg("accent", String(args.to));
      const dim = (t: string) => theme.fg("dim", t);
      if (typeof args.instructions === "string")
        text +=
          "\n  " +
          (context.expanded
            ? dim(args.instructions)
            : truncatePreview(args.instructions, dim));
      return new Text(text, 0, 0);
    },

    renderResult: (result, _options, theme) => renderIconResult(result, theme),
  });

  pi.registerTool({
    name: "link_list",
    label: "Link List",
    description: "List all Pi terminals currently connected to the link.",
    promptSnippet: "List connected Pi terminals on the link",
    parameters: Type.Object({}),

    async execute() {
      if (role === "disconnected") return notConnectedResult();

      const statuses: Record<string, string> = {};
      const cwds: Record<string, string> = {};
      const contexts: Record<string, ContextSnapshot> = {};
      const list = connectedTerminals
        .map((name) => {
          const status = getStatusFor(name);
          const statusStr = status ? formatStatus(status) : "";
          if (statusStr) statuses[name] = statusStr;
          const cwd = getCwdFor(name);
          if (cwd) cwds[name] = cwd;
          const context = getContextFor(name);
          if (context) contexts[name] = context;
          const ctxStr = formatContext(context);
          const marker = name === terminalName ? " (you)" : "";
          let line = `  \u2022 ${name}${marker}${statusStr ? "  " + statusStr : ""}`;
          if (ctxStr) line += `  \u00b7 ${ctxStr}`;
          if (cwd) line += `\n    cwd: ${cwd}`;
          return line;
        })
        .join("\n");

      return textResult(`Connected terminals:\n${list}`, {
        terminals: connectedTerminals,
        statuses,
        cwds,
        contexts,
        self: terminalName,
        role,
      });
    },

    renderResult(result, _options, theme) {
      const details = result.details as
        | {
            terminals?: string[];
            statuses?: Record<string, string>;
            cwds?: Record<string, string>;
            contexts?: Record<string, ContextSnapshot>;
            self?: string;
            role?: string;
          }
        | undefined;
      if (!details?.terminals) {
        const txt = result.content[0];
        return new Text(txt?.type === "text" ? txt.text : "", 0, 0);
      }

      let text = theme.fg("toolTitle", theme.bold("link "));
      text += theme.fg("muted", `(${details.role}) `);
      text += theme.fg("accent", `${details.terminals.length} terminal(s)`);
      for (const name of details.terminals) {
        const isSelf = name === details.self;
        const status = details.statuses?.[name] ?? "";
        const cwd = details.cwds?.[name];
        const ctxStr = formatContext(details.contexts?.[name]);
        const nameStr = isSelf ? `\u2022 ${name} (you)` : `\u2022 ${name}`;
        text +=
          "\n  " +
          (isSelf ? theme.fg("accent", nameStr) : theme.fg("text", nameStr)) +
          (status ? "  " + theme.fg("dim", status) : "") +
          (ctxStr ? theme.fg("dim", "  \u00b7 " + ctxStr) : "");
        if (cwd) text += "\n    " + theme.fg("dim", `cwd: ${shortenPath(cwd)}`);
      }
      return new Text(text, 0, 0);
    },
  });

  // ── Commands ─────────────────────────────────────────────────────────────

  pi.registerCommand("link", {
    description: "Show link status",
    handler: async (_args, _ctx) => {
      if (role === "disconnected") {
        _ctx.ui.notify("Link: not connected", "warning");
        return;
      }
      const lines = connectedTerminals.map((name) => {
        const status = getStatusFor(name);
        const statusStr = status ? formatStatus(status) : "";
        const cwd = getCwdFor(name);
        const ctxStr = formatContext(getContextFor(name));
        const marker = name === terminalName ? " (you)" : "";
        let line = `${name}${marker}${statusStr ? ": " + statusStr : ""}`;
        if (ctxStr) line += ` \u00b7 ${ctxStr}`;
        if (cwd) line += `\n  cwd: ${shortenPath(cwd)}`;
        return line;
      });
      _ctx.ui.notify(
        `Link: ${terminalName} (${role}) · ${connectedTerminals.length} online\n${lines.join("\n")}`,
        "info",
      );
    },
  });

  pi.registerCommand("link-name", {
    description: "Change link name. No arg = use session name",
    handler: async (args, _ctx) => {
      let newName = normalizeName(args) ?? "";
      if (!newName) {
        // No argument: use session name if available
        const sessionName = normalizeName(pi.getSessionName());
        if (sessionName) {
          newName = sessionName;
        } else {
          _ctx.ui.notify(
            `Current name: "${terminalName}". No session name set. Usage: /link-name <name>`,
            "info",
          );
          return;
        }
      }

      if (newName === terminalName && newName === preferredName) {
        _ctx.ui.notify(`Already using "${newName}"`, "info");
        return;
      }

      function savePreference() {
        preferredName = newName;
        pi.appendEntry("link-name", { name: preferredName });
      }

      if (newName === terminalName) {
        savePreference();
        _ctx.ui.notify(`Saved "${newName}" as preferred link name`, "info");
        return;
      }

      // If we're the hub, check uniqueness before persisting
      if (role === "hub") {
        // Check if name is taken by another terminal
        const takenByOther = Array.from(hubClients.values()).includes(newName);
        if (takenByOther) {
          _ctx.ui.notify(
            `Name "${newName}" is already taken by another terminal`,
            "warning",
          );
          return;
        }
        const old = terminalName;
        terminalName = newName;
        const list = terminalList();
        connectedTerminals = list;
        updateStatus();
        // Notify clients only — hub already updated local state
        hubBroadcast(
          { type: "terminal_left", name: old, terminals: list },
          terminalName,
        );
        hubBroadcast(
          {
            type: "terminal_joined",
            name: newName,
            terminals: list,
            cwd: currentCwd,
            context: captureContext(),
          },
          terminalName,
        );
        pushStatus(true);
        savePreference();
        _ctx.ui.notify(`Renamed to "${newName}"`, "info");
      } else if (role === "client") {
        // Don't update terminalName here — welcome will assign authoritatively
        // after reconnect. Hub may dedupe newName to newName-2 if taken.
        savePreference();
        pendingClientRename = true;
        ws?.close();
        _ctx.ui.notify(
          `Reconnecting, requesting "${newName}" (hub may assign a different name if taken)...`,
          "info",
        );
      } else {
        savePreference();
        terminalName = newName;
        _ctx.ui.notify(`Name set to "${newName}" (not connected)`, "info");
      }
    },
  });

  pi.registerCommand("link-disconnect", {
    description: "Disconnect from the link",
    handler: async (_args, _ctx) => {
      pi.appendEntry("link-active", { active: false });
      manuallyDisconnected = true;
      if (role === "disconnected") {
        // Nothing is established, but a startup or reconnect attempt may still be
        // dialing or binding; persisted intent has to win over it too.
        cancelConnectionAttempt();
        _ctx.ui.notify("Link disconnected", "info");
        return;
      }
      disconnect();
      _ctx.ui.notify("Disconnected from link", "info");
    },
  });

  pi.registerCommand("link-connect", {
    description: "Connect to the link",
    handler: async (_args, _ctx) => {
      if (role !== "disconnected") {
        _ctx.ui.notify(
          `Already connected as "${terminalName}" (${role})`,
          "info",
        );
        return;
      }
      pi.appendEntry("link-active", { active: true });
      manuallyDisconnected = false;
      await initialize();
    },
  });

  // ── Message renderer ─────────────────────────────────────────────────────

  pi.registerMessageRenderer("link", (message, options, theme) => {
    const from =
      (message.details as Record<string, unknown> | undefined)?.from ?? "link";
    const text =
      theme.fg("accent", `⚡ [${from}] `) +
      theme.fg("text", String(message.content));
    const content = new Text(text, 0, 0);
    // The same panel Pi draws around extension messages by default: returning our own
    // component bypasses the host's box, so a link message would otherwise sit unframed
    // among framed ones. `outputPad` is the user's configured output padding.
    const box = new Box(options.outputPad, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(
      options.expanded
        ? content
        : messagePreview(content, (s) => theme.fg("muted", s)),
    );
    return box;
  });
}
