/**
 * Pi Link — WebSocket-based inter-terminal communication
 *
 * Connects multiple Pi terminals over a local WebSocket link.
 * Opt-in via --link flag or /link-connect command.
 * First terminal to connect becomes the hub; others join as clients.
 * Hub loss triggers automatic promotion of a surviving client.
 *
 * Tools: link_send, link_prompt, link_list
 * Commands: /link, /link-name, /link-broadcast, /link-connect, /link-disconnect
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import * as crypto from "node:crypto";
import * as os from "node:os";

import { WebSocket, WebSocketServer } from "ws";

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_PORT = 9900;
const PROMPT_INACTIVITY_MS = 90_000;
const PROMPT_HARD_CEILING_MS = 1_800_000;
const RECONNECT_DELAY_MS = 2000;
const KEEPALIVE_INTERVAL_MS = 30_000;

// ─── Protocol ────────────────────────────────────────────────────────────────

interface RegisterMsg {
  type: "register";
  name: string;
  cwd?: string;
}
interface WelcomeMsg {
  type: "welcome";
  name: string;
  terminals: string[];
  statuses?: Record<string, LinkStatus>;
  cwds?: Record<string, string>;
}
interface TerminalJoinedMsg {
  type: "terminal_joined";
  name: string;
  terminals: string[];
  cwd?: string;
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
  triggerTurn: boolean;
}
interface PromptRequestMsg {
  type: "prompt_request";
  id: string;
  from: string;
  to: string;
  prompt: string;
}
interface PromptResponseMsg {
  type: "prompt_response";
  id: string;
  from: string;
  to: string;
  response: string;
  error?: string;
}
interface StatusUpdateMsg {
  type: "status_update";
  name: string;
  status: LinkStatus;
}
interface ErrorMsg {
  type: "error";
  message: string;
}

type LinkStatus =
  | { kind: "idle"; since: number }
  | { kind: "thinking"; since: number }
  | { kind: "tool"; toolName: string; since: number };

type LinkMessage =
  | RegisterMsg
  | WelcomeMsg
  | TerminalJoinedMsg
  | TerminalLeftMsg
  | ChatMsg
  | PromptRequestMsg
  | PromptResponseMsg
  | StatusUpdateMsg
  | ErrorMsg;

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerFlag("link", {
    description: "Connect to link on startup",
    type: "boolean",
    default: false,
  });

  // ── State ────────────────────────────────────────────────────────────────

  let role: "hub" | "client" | "disconnected" = "disconnected";
  let terminalName = `t-${crypto.randomUUID().slice(0, 4)}`;
  let preferredName: string | null = null;
  let connectedTerminals: string[] = [];
  let ctx: ExtensionContext | undefined;
  let disposed = false;
  let manuallyDisconnected = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Status tracking (local truth)
  let agentRunning = false;
  let activeToolName: string | null = null;
  let stateSince = Date.now();
  let lastPushedKind: string | null = null;
  let lastPushedTool: string | null = null;
  const terminalStatuses = new Map<string, LinkStatus>(); // other terminals
  let currentCwd = "";
  const terminalCwds = new Map<string, string>(); // other terminals' cwds

  // Hub state
  let wss: WebSocketServer | null = null;
  const hubClients = new Map<WebSocket, string>(); // ws → terminal name
  const hubTerminalStatuses = new Map<string, LinkStatus>(); // hub-authoritative
  const hubTerminalCwds = new Map<string, string>(); // hub-authoritative (excludes self)

  // Client state
  let ws: WebSocket | null = null;

  // Pending prompt responses (sender waiting for remote answer)
  const pendingPromptResponses = new Map<
    string,
    {
      resolve: (result: {
        content: { type: "text"; text: string }[];
        details: Record<string, unknown>;
      }) => void;
      targetName: string;
      inactivityTimeout: ReturnType<typeof setTimeout>;
      ceilingTimeout: ReturnType<typeof setTimeout>;
    }
  >();

  // Pending remote prompt (this terminal is executing a prompt for someone else)
  let pendingRemotePrompt: { id: string; from: string } | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  // ── Helpers ──────────────────────────────────────────────────────────────

  function updateStatus() {
    if (!ctx) return;
    const theme = ctx.ui.theme;
    const count = connectedTerminals.length;
    const info =
      role === "disconnected"
        ? "link: offline"
        : `link: ${terminalName} (${role}) · ${count} terminal${count !== 1 ? "s" : ""}`;
    ctx.ui.setStatus("link", theme.fg("dim", info));
  }

  function deriveStatus(): LinkStatus {
    if (activeToolName)
      return { kind: "tool", toolName: activeToolName, since: stateSince };
    if (agentRunning) return { kind: "thinking", since: stateSince };
    return { kind: "idle", since: stateSince };
  }

  function pushStatus(force = false) {
    if (role === "disconnected") return;
    const status = deriveStatus();
    const newKind = status.kind;
    const newTool = status.kind === "tool" ? status.toolName : null;
    if (!force && newKind === lastPushedKind && newTool === lastPushedTool)
      return;
    lastPushedKind = newKind;
    lastPushedTool = newTool;
    const msg: StatusUpdateMsg = {
      type: "status_update",
      name: terminalName,
      status,
    };
    if (role === "hub") {
      hubBroadcast(msg, terminalName);
    } else if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
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

  function shortenPath(cwd: string): string {
    const home = os.homedir().replace(/\\/g, "/");
    const normalized = cwd.replace(/\\/g, "/");
    if (normalized === home) return "~";
    if (normalized.startsWith(home + "/"))
      return "~" + normalized.slice(home.length);
    return normalized;
  }

  // ── Connection intent ──────────────────────────────────────────────────

  function shouldConnect(_ctx: ExtensionContext): boolean {
    const saved = _ctx.sessionManager
      .getEntries()
      .filter(
        (e: { type: string; customType?: string }) =>
          e.type === "custom" && e.customType === "link-active",
      )
      .pop() as { data?: { active?: boolean } } | undefined;
    if (saved?.data?.active !== undefined) return saved.data.active;
    return pi.getFlag("link") === true;
  }

  // ── Pending prompt helpers ───────────────────────────────────────────────

  function cleanupPending(requestId: string) {
    const pending = pendingPromptResponses.get(requestId);
    if (!pending) return null;
    clearTimeout(pending.inactivityTimeout);
    clearTimeout(pending.ceilingTimeout);
    pendingPromptResponses.delete(requestId);
    return pending;
  }

  function makeInactivityTimeout(requestId: string, targetName: string) {
    return setTimeout(() => {
      const pending = cleanupPending(requestId);
      if (pending) {
        pending.resolve(
          textResult(
            `Prompt to "${targetName}" timed out (no activity for ${PROMPT_INACTIVITY_MS / 1000}s)`,
            { to: targetName, error: "timeout" },
          ),
        );
      }
    }, PROMPT_INACTIVITY_MS);
  }

  function resetInactivityFor(targetName: string) {
    for (const [id, pending] of pendingPromptResponses) {
      if (pending.targetName === targetName) {
        clearTimeout(pending.inactivityTimeout);
        pending.inactivityTimeout = makeInactivityTimeout(id, targetName);
      }
    }
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
    msg: ChatMsg | PromptRequestMsg | PromptResponseMsg,
  ): boolean {
    if (role === "hub") {
      if (msg.to === "*") {
        hubBroadcast(msg, msg.from);
        return true;
      }
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
        msg.type === "prompt_request"
          ? {
              type: "prompt_response",
              id: msg.id,
              from: terminalName,
              to: msg.from,
              response: "",
              error: errText,
            }
          : { type: "error", message: errText };

      if (msg.from === terminalName) {
        // For prompt_request, deliver the error response locally so
        // pendingPromptResponses resolves. For chat, skip — the tool
        // result (via return false) is sufficient; no extra UI toast.
        if (errorMsg.type === "prompt_response") handleIncoming(errorMsg);
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
        connectedTerminals = msg.terminals;
        terminalStatuses.clear();
        terminalCwds.clear();
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
        updateStatus();
        ctx?.ui.notify(
          `Joined link as "${terminalName}" (${connectedTerminals.length} online)`,
          "info",
        );
        pushStatus(true);
        break;

      // ── Membership updates ──
      case "terminal_joined":
        connectedTerminals = msg.terminals;
        if (role !== "hub" && msg.cwd) terminalCwds.set(msg.name, msg.cwd);
        updateStatus();
        ctx?.ui.notify(`"${msg.name}" joined the link`, "info");
        break;

      case "terminal_left":
        connectedTerminals = msg.terminals;
        terminalStatuses.delete(msg.name);
        if (role !== "hub") terminalCwds.delete(msg.name);
        // Fail any pending prompts to the departed terminal immediately
        for (const [id, pending] of pendingPromptResponses) {
          if (pending.targetName === msg.name) {
            const p = cleanupPending(id);
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
        ctx?.ui.notify(`"${msg.name}" left the link`, "info");
        break;

      // ── Status update from another terminal ──
      case "status_update":
        terminalStatuses.set(msg.name, msg.status);
        resetInactivityFor(msg.name);
        break;

      // ── Chat message ──
      case "chat":
        pi.sendMessage(
          {
            customType: "link",
            content: msg.content,
            display: true,
            details: { from: msg.from },
          },
          { triggerTurn: msg.triggerTurn, deliverAs: "steer" },
        );
        break;

      // ── Another terminal asks us to run a prompt ──
      case "prompt_request":
        if (agentRunning || pendingRemotePrompt) {
          routeMessage({
            type: "prompt_response",
            id: msg.id,
            from: terminalName,
            to: msg.from,
            response: "",
            error: "Terminal is busy",
          });
        } else {
          pendingRemotePrompt = { id: msg.id, from: msg.from };
          // Keepalive: periodic status push so sender knows we're alive
          if (keepaliveTimer) clearInterval(keepaliveTimer);
          keepaliveTimer = setInterval(
            () => pushStatus(true),
            KEEPALIVE_INTERVAL_MS,
          );
          ctx?.ui.notify(`Running remote prompt from "${msg.from}"`, "info");
          pi.sendUserMessage(
            `[Remote prompt from "${msg.from}"]\n\n${msg.prompt}`,
          );
        }
        break;

      // ── Response to a prompt we sent ──
      case "prompt_response": {
        const pending = cleanupPending(msg.id);
        if (pending) {
          if (msg.error) {
            pending.resolve(
              textResult(`Error from "${msg.from}": ${msg.error}`, {
                from: msg.from,
                error: msg.error,
              }),
            );
          } else {
            pending.resolve(textResult(msg.response, { from: msg.from }));
          }
        }
        break;
      }

      case "error":
        ctx?.ui.notify(`Link: ${msg.message}`, "error");
        break;
    }
  }

  // ── Hub: handle a new client WebSocket ───────────────────────────────────

  function hubHandleClient(clientWs: WebSocket) {
    let clientName = "";

    clientWs.on("message", (raw) => {
      const msg = safeParse(raw.toString());
      if (!msg) return;

      // First message must be register
      if (msg.type === "register") {
        clientName = uniqueName(msg.name);
        hubClients.set(clientWs, clientName);
        if (msg.cwd) hubTerminalCwds.set(clientName, msg.cwd);
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
        clientWs.send(
          JSON.stringify({
            type: "welcome",
            name: clientName,
            terminals: list,
            statuses,
            cwds,
          } satisfies WelcomeMsg),
        );

        // Notify everyone else (include joiner's cwd)
        const joined: TerminalJoinedMsg = {
          type: "terminal_joined",
          name: clientName,
          terminals: list,
          cwd: msg.cwd,
        };
        hubBroadcast(joined, clientName);
        return;
      }

      // Ignore messages from unregistered clients
      if (!clientName) return;

      // Status update — store and fan out to other clients only (not back to hub)
      if (msg.type === "status_update") {
        hubTerminalStatuses.set(clientName, msg.status);
        resetInactivityFor(clientName);
        const normalized: StatusUpdateMsg = {
          type: "status_update",
          name: clientName,
          status: msg.status,
        };
        const json = JSON.stringify(normalized);
        for (const [otherWs, name] of hubClients) {
          if (name !== clientName) otherWs.send(json);
        }
        return;
      }

      // Route chat / prompt messages
      if (
        msg.type === "chat" ||
        msg.type === "prompt_request" ||
        msg.type === "prompt_response"
      ) {
        routeMessage(msg);
      }
    });

    clientWs.on("close", () => {
      if (clientName) {
        hubClients.delete(clientWs);
        hubTerminalStatuses.delete(clientName);
        hubTerminalCwds.delete(clientName);
        const list = terminalList();
        connectedTerminals = list;
        updateStatus();
        const left: TerminalLeftMsg = {
          type: "terminal_left",
          name: clientName,
          terminals: list,
        };
        hubBroadcast(left, clientName);
      }
    });

    clientWs.on("error", () => {
      clientWs.close();
    });
  }

  // ── Start as hub ─────────────────────────────────────────────────────────

  function startHub(): Promise<boolean> {
    return new Promise((resolve) => {
      const server = new WebSocketServer({
        port: DEFAULT_PORT,
        host: "127.0.0.1",
      });

      server.on("listening", () => {
        wss = server;
        role = "hub";
        connectedTerminals = [terminalName];
        updateStatus();

        ctx?.ui.notify(
          `Link hub started on :${DEFAULT_PORT} as "${terminalName}"`,
          "info",
        );
        resolve(true);
      });

      server.on("connection", hubHandleClient);

      server.on("error", () => {
        // Port in use → someone else is the hub
        resolve(false);
      });
    });
  }

  // ── Connect as client ────────────────────────────────────────────────────

  function connectAsClient(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${DEFAULT_PORT}`);
      let resolved = false;

      socket.on("open", () => {
        ws = socket;
        role = "client";
        resolved = true;
        // Register with preferred name if available, otherwise current name
        socket.send(
          JSON.stringify({
            type: "register",
            name: preferredName ?? terminalName,
            cwd: currentCwd || undefined,
          } satisfies RegisterMsg),
        );
        resolve(true);
      });

      socket.on("message", (raw) => {
        const msg = safeParse(raw.toString());
        if (msg) handleIncoming(msg);
      });

      socket.on("close", () => {
        ws = null;
        if (role === "client") {
          role = "disconnected";
          connectedTerminals = [];
          updateStatus();

          if (!manuallyDisconnected) {
            ctx?.ui.notify("Disconnected from link hub", "warning");
            scheduleReconnect();
          }
        }
      });

      socket.on("error", () => {
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
        socket.close();
      });
    });
  }

  // ── Initialize (auto-discover) ──────────────────────────────────────────

  async function initialize() {
    if (disposed) return;

    // Try connecting to an existing hub
    if (await connectAsClient()) return;

    // No hub found — become the hub
    if (await startHub()) return;

    // Port busy but couldn't connect (rare race). Retry after delay.
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (disposed || manuallyDisconnected || reconnectTimer) return;
    const delay = RECONNECT_DELAY_MS + Math.random() * 3000;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (role === "disconnected" && !disposed && !manuallyDisconnected)
        initialize();
    }, delay);
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────

  function disconnect() {
    // Clear reconnect timer first to prevent races
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    // Clean up target-side remote prompt state
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    pendingRemotePrompt = null;

    // Clean up pending prompts
    for (const id of [...pendingPromptResponses.keys()]) {
      const pending = cleanupPending(id);
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
    }

    role = "disconnected";
    connectedTerminals = [];
    terminalStatuses.clear();
    hubTerminalStatuses.clear();
    terminalCwds.clear();
    hubTerminalCwds.clear();
    lastPushedKind = null;
    lastPushedTool = null;
    updateStatus();
  }

  function cleanup() {
    disposed = true;
    disconnect();
  }

  // ── Lifecycle events ─────────────────────────────────────────────────────

  pi.on("session_start", async (_event, _ctx) => {
    ctx = _ctx;
    currentCwd = _ctx.cwd;

    // Restore preferred link name from session
    const saved = _ctx.sessionManager
      .getEntries()
      .filter(
        (e: { type: string; customType?: string }) =>
          e.type === "custom" && e.customType === "link-name",
      )
      .pop() as { data?: { name?: string } } | undefined;
    if (saved?.data?.name) {
      preferredName = saved.data.name;
      terminalName = preferredName;
    }

    if (shouldConnect(_ctx)) await initialize();
  });

  pi.on("session_shutdown", async () => {
    cleanup();
  });

  pi.on("agent_start", async () => {
    agentRunning = true;
    activeToolName = null;
    stateSince = Date.now();
    pushStatus();
  });

  pi.on("tool_execution_start", async (event) => {
    activeToolName = event.toolName;
    stateSince = Date.now();
    pushStatus();
  });

  pi.on("tool_execution_end", async () => {
    activeToolName = null;
    if (agentRunning) stateSince = Date.now();
    pushStatus();
  });

  pi.on("agent_end", async (event) => {
    agentRunning = false;
    activeToolName = null;
    stateSince = Date.now();
    pushStatus();

    // If we were running a remote prompt, send the response back
    if (pendingRemotePrompt) {
      const { id, from } = pendingRemotePrompt;
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      pendingRemotePrompt = null;

      // Find the last assistant text in this run
      let responseText = "";
      for (let i = event.messages.length - 1; i >= 0; i--) {
        const msg = event.messages[i];
        if (msg.role === "assistant") {
          responseText = msg.content
            .filter((c: { type: string }) => c.type === "text")
            .map((c: { type: string; text?: string }) => c.text ?? "")
            .join("\n");
          break;
        }
      }

      routeMessage({
        type: "prompt_response",
        id,
        from: terminalName,
        to: from,
        response: responseText || "(no response)",
      });
    }
  });

  // ── Tool helpers ──────────────────────────────────────────────────────────

  function textResult(text: string, details: Record<string, unknown> = {}) {
    return { content: [{ type: "text" as const, text }], details };
  }

  function notConnectedResult() {
    return textResult("Not connected to link");
  }

  function truncatePreview(text: string, max = 60) {
    return text.length > max ? text.slice(0, max) + "..." : text;
  }

  // ── Tools ────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "link_send",
    label: "Link Send",
    description: [
      "Send a message to another Pi terminal on the link.",
      'Use to:"*" for broadcast. Set triggerTurn:true to make the receiving terminal\'s LLM respond.',
    ].join(" "),
    promptSnippet:
      "Send a message to another Pi terminal on the local link network",
    parameters: Type.Object({
      to: Type.String({
        description: 'Target terminal name, or "*" for broadcast',
      }),
      message: Type.String({ description: "Message content" }),
      triggerTurn: Type.Optional(
        Type.Boolean({
          description:
            "Whether to trigger an LLM turn on the receiver (default: false)",
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      if (role === "disconnected") return notConnectedResult();

      // Pre-validate target exists locally (best-effort, catches typos and definitely-absent names)
      if (params.to !== "*" && !connectedTerminals.includes(params.to)) {
        return textResult(
          `Terminal "${params.to}" not found. Connected: ${connectedTerminals.join(", ")}`,
          { to: params.to, error: "not_found" },
        );
      }

      const delivered = routeMessage({
        type: "chat",
        from: terminalName,
        to: params.to,
        content: params.message,
        triggerTurn: params.triggerTurn ?? false,
      });

      const target = params.to === "*" ? "all terminals" : `"${params.to}"`;
      if (!delivered) {
        return textResult(`Failed to send to ${target}`, {
          to: params.to,
          error: "not_delivered",
        });
      }
      // Hub delivery is authoritative; client delivery is optimistic (hub routes)
      const verb = role === "hub" ? "Sent to" : "Sent to hub for delivery to";
      return textResult(`${verb} ${target}`, {
        to: params.to,
        triggerTurn: params.triggerTurn ?? false,
      });
    },

    renderCall(args, theme) {
      const target = args.to === "*" ? "broadcast" : args.to;
      const preview =
        typeof args.message === "string"
          ? truncatePreview(args.message)
          : "...";
      let text = theme.fg("toolTitle", theme.bold("link_send "));
      text += theme.fg("accent", target);
      if (args.triggerTurn) text += theme.fg("warning", " (trigger)");
      text += "\n  " + theme.fg("dim", preview);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const txt = result.content[0];
      const details = result.details as Record<string, unknown> | undefined;
      const icon = details?.error
        ? theme.fg("error", "✗ ")
        : theme.fg("success", "✓ ");
      return new Text(icon + (txt?.type === "text" ? txt.text : ""), 0, 0);
    },
  });

  pi.registerTool({
    name: "link_prompt",
    label: "Link Prompt",
    description: [
      "Send a prompt to another Pi terminal and wait for its LLM to respond.",
      "The remote terminal processes the prompt as if a user typed it,",
      "then returns the assistant's response. Times out after 90s of inactivity.",
    ].join(" "),
    promptSnippet:
      "Send a prompt to another Pi terminal and receive its LLM response",
    parameters: Type.Object({
      to: Type.String({ description: "Target terminal name" }),
      prompt: Type.String({ description: "Prompt to send" }),
    }),

    async execute(_toolCallId, params, signal) {
      if (role === "disconnected") return notConnectedResult();

      if (params.to === terminalName) {
        return textResult("Cannot prompt yourself", {
          to: params.to,
          error: "self_target",
        });
      }

      if (!connectedTerminals.includes(params.to)) {
        return textResult(
          `Terminal "${params.to}" not found. Connected: ${connectedTerminals.join(", ")}`,
          { to: params.to, error: "not_found" },
        );
      }

      const requestId = crypto.randomUUID();

      return new Promise((resolve) => {
        const inactivityTimeout = makeInactivityTimeout(requestId, params.to);

        const ceilingTimeout = setTimeout(() => {
          const pending = cleanupPending(requestId);
          if (pending) {
            pending.resolve(
              textResult(
                `Prompt to "${params.to}" hit hard ceiling (${PROMPT_HARD_CEILING_MS / 60_000}min)`,
                { to: params.to, error: "timeout" },
              ),
            );
          }
        }, PROMPT_HARD_CEILING_MS);

        pendingPromptResponses.set(requestId, {
          resolve,
          targetName: params.to,
          inactivityTimeout,
          ceilingTimeout,
        });

        // Abort handling
        signal?.addEventListener(
          "abort",
          () => {
            const pending = cleanupPending(requestId);
            if (pending) {
              pending.resolve(
                textResult("Prompt request aborted", {
                  to: params.to,
                  error: "aborted",
                }),
              );
            }
          },
          { once: true },
        );

        const delivered = routeMessage({
          type: "prompt_request",
          id: requestId,
          from: terminalName,
          to: params.to,
          prompt: params.prompt,
        });

        if (!delivered && pendingPromptResponses.has(requestId)) {
          const pending = cleanupPending(requestId);
          if (pending) {
            pending.resolve(
              textResult(`Failed to send prompt to "${params.to}"`, {
                to: params.to,
                error: "not_delivered",
              }),
            );
          }
        }
      });
    },

    renderCall(args, theme) {
      const preview =
        typeof args.prompt === "string" ? truncatePreview(args.prompt) : "...";
      let text = theme.fg("toolTitle", theme.bold("link_prompt "));
      text += theme.fg("accent", args.to ?? "...");
      text += "\n  " + theme.fg("dim", preview);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const txt = result.content[0];
      const details = result.details as Record<string, unknown> | undefined;
      if (details?.error) {
        return new Text(
          theme.fg("error", "✗ ") + (txt?.type === "text" ? txt.text : ""),
          0,
          0,
        );
      }
      const from = details?.from ?? "unknown";
      const response = txt?.type === "text" ? txt.text : "";
      const preview = truncatePreview(response, 200);
      return new Text(
        theme.fg("success", "✓ ") +
          theme.fg("accent", `[${from}] `) +
          theme.fg("text", preview),
        0,
        0,
      );
    },
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
      const list = connectedTerminals
        .map((name) => {
          const status = getStatusFor(name);
          const statusStr = status ? formatStatus(status) : "";
          if (statusStr) statuses[name] = statusStr;
          const cwd = getCwdFor(name);
          if (cwd) cwds[name] = cwd;
          const marker = name === terminalName ? " (you)" : "";
          let line = `  \u2022 ${name}${marker}${statusStr ? "  " + statusStr : ""}`;
          if (cwd) line += `\n    cwd: ${cwd}`;
          return line;
        })
        .join("\n");

      return textResult(`Connected terminals:\n${list}`, {
        terminals: connectedTerminals,
        statuses,
        cwds,
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
        const nameStr = isSelf ? `\u2022 ${name} (you)` : `\u2022 ${name}`;
        text +=
          "\n  " +
          (isSelf ? theme.fg("accent", nameStr) : theme.fg("text", nameStr)) +
          (status ? "  " + theme.fg("dim", status) : "");
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
        const marker = name === terminalName ? " (you)" : "";
        let line = `${name}${marker}${statusStr ? ": " + statusStr : ""}`;
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
      let newName = args.trim();
      if (!newName) {
        // No argument: use session name if available
        const sessionName = pi.getSessionName()?.trim().replace(/\s+/g, " ");
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
          },
          terminalName,
        );
        pushStatus(true);
        savePreference();
        _ctx.ui.notify(`Renamed to "${newName}"`, "info");
      } else if (role === "client") {
        // Reconnect with new name — hub will enforce uniqueness via register
        savePreference();
        terminalName = newName;
        ws?.close();
        // Reconnect will happen via the onClose handler → scheduleReconnect
        _ctx.ui.notify(
          `Reconnecting as "${newName}" (hub may assign a different name if taken)...`,
          "info",
        );
      } else {
        savePreference();
        terminalName = newName;
        _ctx.ui.notify(`Name set to "${newName}" (not connected)`, "info");
      }
    },
  });

  pi.registerCommand("link-broadcast", {
    description: "Broadcast a message to all connected terminals",
    handler: async (args, _ctx) => {
      const message = args.trim();
      if (!message) {
        _ctx.ui.notify("Usage: /link-broadcast <message>", "warning");
        return;
      }
      if (role === "disconnected") {
        _ctx.ui.notify("Not connected to link", "warning");
        return;
      }
      routeMessage({
        type: "chat",
        from: terminalName,
        to: "*",
        content: message,
        triggerTurn: false,
      });
      _ctx.ui.notify("Broadcast sent", "info");
    },
  });

  pi.registerCommand("link-disconnect", {
    description: "Disconnect from the link",
    handler: async (_args, _ctx) => {
      pi.appendEntry("link-active", { active: false });
      manuallyDisconnected = true;
      if (role === "disconnected") {
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
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

  pi.registerMessageRenderer("link", (message, _options, theme) => {
    const from =
      (message.details as Record<string, unknown> | undefined)?.from ?? "link";
    const text =
      theme.fg("accent", `⚡ [${from}] `) +
      theme.fg("text", String(message.content));
    return new Text(text, 0, 0);
  });
}
