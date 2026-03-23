/**
 * Pi Mesh — WebSocket-based inter-terminal communication
 *
 * Connects multiple Pi terminals over a local WebSocket mesh.
 * The first terminal becomes the hub (server); others join as clients.
 * If the hub exits, a surviving terminal promotes itself automatically.
 *
 * Features:
 *   - Auto-discovery: try to connect → fall back to becoming the hub
 *   - Named terminals with uniqueness enforcement
 *   - LLM tools: mesh_send (chat), mesh_prompt (remote prompt + response), mesh_list
 *   - Commands: /mesh, /mesh-name, /mesh-broadcast
 *   - Custom message renderer for incoming mesh messages
 *   - Auto-reconnect with hub promotion on disconnect
 *
 * Install:
 *   cd ~/.pi/agent/extensions/pi-mesh && npm install
 *
 * Then just start two or more `pi` terminals — they discover each other.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import * as crypto from "node:crypto";

import { WebSocket, WebSocketServer } from "ws";

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_PORT = 9900;
const PROMPT_TIMEOUT_MS = 120_000;
const RECONNECT_DELAY_MS = 2000;

// ─── Protocol ────────────────────────────────────────────────────────────────

interface RegisterMsg {
  type: "register";
  name: string;
}
interface WelcomeMsg {
  type: "welcome";
  name: string;
  terminals: string[];
}
interface TerminalJoinedMsg {
  type: "terminal_joined";
  name: string;
  terminals: string[];
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
interface ErrorMsg {
  type: "error";
  message: string;
}

type MeshMessage =
  | RegisterMsg
  | WelcomeMsg
  | TerminalJoinedMsg
  | TerminalLeftMsg
  | ChatMsg
  | PromptRequestMsg
  | PromptResponseMsg
  | ErrorMsg;

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── State ────────────────────────────────────────────────────────────────

  let role: "hub" | "client" | "disconnected" = "disconnected";
  let terminalName = `t-${crypto.randomUUID().slice(0, 4)}`;
  let connectedTerminals: string[] = [];
  let ctx: ExtensionContext | undefined;
  let isAgentBusy = false;
  let disposed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Hub state
  let wss: WebSocketServer | null = null;
  const hubClients = new Map<WebSocket, string>(); // ws → terminal name

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
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  // Pending remote prompt (this terminal is executing a prompt for someone else)
  let pendingRemotePrompt: { id: string; from: string } | null = null;

  // ── Helpers ──────────────────────────────────────────────────────────────

  function updateStatus() {
    if (!ctx) return;
    const theme = ctx.ui.theme;
    const count = connectedTerminals.length;
    const info =
      role === "disconnected"
        ? "mesh: offline"
        : `mesh: ${terminalName} (${role}) · ${count} terminal${count !== 1 ? "s" : ""}`;
    ctx.ui.setStatus("mesh", theme.fg("dim", info));
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

  function safeParse(data: string): MeshMessage | null {
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  // ── Routing ──────────────────────────────────────────────────────────────

  /** Hub: broadcast a message to every terminal except `excludeName`. */
  function hubBroadcast(msg: MeshMessage, excludeName?: string) {
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
      const errorMsg: MeshMessage =
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

  function handleIncoming(msg: MeshMessage) {
    switch (msg.type) {
      // ── Client receives after registering ──
      case "welcome":
        terminalName = msg.name;
        connectedTerminals = msg.terminals;
        updateStatus();
        ctx?.ui.notify(
          `Joined mesh as "${terminalName}" (${connectedTerminals.length} online)`,
          "info",
        );
        break;

      // ── Directory updates ──
      case "terminal_joined":
        connectedTerminals = msg.terminals;
        updateStatus();
        ctx?.ui.notify(`"${msg.name}" joined the mesh`, "info");
        break;

      case "terminal_left":
        connectedTerminals = msg.terminals;
        updateStatus();
        ctx?.ui.notify(`"${msg.name}" left the mesh`, "info");
        break;

      // ── Chat message ──
      case "chat":
        pi.sendMessage(
          {
            customType: "mesh",
            content: msg.content,
            display: true,
            details: { from: msg.from },
          },
          { triggerTurn: msg.triggerTurn, deliverAs: "steer" },
        );
        break;

      // ── Another terminal asks us to run a prompt ──
      case "prompt_request":
        if (isAgentBusy || pendingRemotePrompt) {
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
          ctx?.ui.notify(`Running remote prompt from "${msg.from}"`, "info");
          pi.sendUserMessage(
            `[Remote prompt from "${msg.from}"]\n\n${msg.prompt}`,
          );
        }
        break;

      // ── Response to a prompt we sent ──
      case "prompt_response": {
        const pending = pendingPromptResponses.get(msg.id);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingPromptResponses.delete(msg.id);
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
        ctx?.ui.notify(`Mesh: ${msg.message}`, "error");
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
        const list = terminalList();
        connectedTerminals = list;
        updateStatus();

        // Confirm to the new client
        clientWs.send(
          JSON.stringify({
            type: "welcome",
            name: clientName,
            terminals: list,
          } satisfies WelcomeMsg),
        );

        // Notify everyone else
        const joined: TerminalJoinedMsg = {
          type: "terminal_joined",
          name: clientName,
          terminals: list,
        };
        hubBroadcast(joined, clientName);
        return;
      }

      // Ignore messages from unregistered clients
      if (!clientName) return;

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
          `Mesh hub started on :${DEFAULT_PORT} as "${terminalName}"`,
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

  function connectAsClient(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`);
      let resolved = false;

      socket.on("open", () => {
        ws = socket;
        role = "client";
        resolved = true;
        // Register with the hub
        socket.send(
          JSON.stringify({
            type: "register",
            name: terminalName,
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
          ctx?.ui.notify("Disconnected from mesh hub", "warning");
          scheduleReconnect();
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
    if (await connectAsClient(DEFAULT_PORT)) return;

    // No hub found — become the hub
    if (await startHub()) return;

    // Port busy but couldn't connect (rare race). Retry after delay.
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (disposed || reconnectTimer) return;
    const delay = RECONNECT_DELAY_MS + Math.random() * 3000;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (role === "disconnected" && !disposed) initialize();
    }, delay);
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────

  function cleanup() {
    disposed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    // Clean up pending prompts
    for (const [id, pending] of pendingPromptResponses) {
      clearTimeout(pending.timeout);
      pending.resolve(textResult("Mesh shutting down", { error: "shutdown" }));
    }
    pendingPromptResponses.clear();

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
  }

  // ── Lifecycle events ─────────────────────────────────────────────────────

  pi.on("session_start", async (_event, _ctx) => {
    ctx = _ctx;
    await initialize();
  });

  pi.on("session_shutdown", async () => {
    cleanup();
  });

  pi.on("agent_start", async () => {
    isAgentBusy = true;
  });

  pi.on("agent_end", async (event) => {
    isAgentBusy = false;

    // If we were running a remote prompt, send the response back
    if (pendingRemotePrompt) {
      const { id, from } = pendingRemotePrompt;
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
    return textResult("Not connected to mesh");
  }

  function truncatePreview(text: string, max = 60) {
    return text.length > max ? text.slice(0, max) + "..." : text;
  }

  // ── Tools ────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "mesh_send",
    label: "Mesh Send",
    description: [
      "Send a message to another Pi terminal on the mesh.",
      'Use to:"*" for broadcast. Set triggerTurn:true to make the receiving terminal\'s LLM respond.',
    ].join(" "),
    promptSnippet:
      "Send a message to another Pi terminal on the local mesh network",
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
      let text = theme.fg("toolTitle", theme.bold("mesh_send "));
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
    name: "mesh_prompt",
    label: "Mesh Prompt",
    description: [
      "Send a prompt to another Pi terminal and wait for its LLM to respond.",
      "The remote terminal processes the prompt as if a user typed it,",
      "then returns the assistant's response. Times out after 2 minutes.",
    ].join(" "),
    promptSnippet:
      "Send a prompt to another Pi terminal and receive its LLM response",
    parameters: Type.Object({
      to: Type.String({ description: "Target terminal name" }),
      prompt: Type.String({ description: "Prompt to send" }),
    }),

    async execute(_toolCallId, params, signal) {
      if (role === "disconnected") return notConnectedResult();

      const requestId = crypto.randomUUID();

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          pendingPromptResponses.delete(requestId);
          resolve(
            textResult(
              `Prompt to "${params.to}" timed out after ${PROMPT_TIMEOUT_MS / 1000}s`,
              { to: params.to, error: "timeout" },
            ),
          );
        }, PROMPT_TIMEOUT_MS);

        pendingPromptResponses.set(requestId, { resolve, timeout });

        // Abort handling
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timeout);
            pendingPromptResponses.delete(requestId);
            resolve(
              textResult("Prompt request aborted", {
                to: params.to,
                error: "aborted",
              }),
            );
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
          clearTimeout(timeout);
          pendingPromptResponses.delete(requestId);
          resolve(
            textResult(`Failed to send prompt to "${params.to}"`, {
              to: params.to,
              error: "not_delivered",
            }),
          );
        }
      });
    },

    renderCall(args, theme) {
      const preview =
        typeof args.prompt === "string" ? truncatePreview(args.prompt) : "...";
      let text = theme.fg("toolTitle", theme.bold("mesh_prompt "));
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
    name: "mesh_list",
    label: "Mesh List",
    description: "List all Pi terminals currently connected to the mesh.",
    promptSnippet: "List connected Pi terminals on the mesh",
    parameters: Type.Object({}),

    async execute() {
      if (role === "disconnected") return notConnectedResult();

      const list = connectedTerminals
        .map((name) => {
          const marker = name === terminalName ? " (you)" : "";
          return `  • ${name}${marker}`;
        })
        .join("\n");

      return textResult(`Connected terminals:\n${list}`, {
        terminals: connectedTerminals,
        self: terminalName,
        role,
      });
    },

    renderResult(result, _options, theme) {
      const details = result.details as
        | { terminals?: string[]; self?: string; role?: string }
        | undefined;
      if (!details?.terminals) {
        const txt = result.content[0];
        return new Text(txt?.type === "text" ? txt.text : "", 0, 0);
      }

      let text = theme.fg("toolTitle", theme.bold("mesh "));
      text += theme.fg("muted", `(${details.role}) `);
      text += theme.fg("accent", `${details.terminals.length} terminal(s)`);
      for (const name of details.terminals) {
        const isSelf = name === details.self;
        text +=
          "\n  " +
          (isSelf
            ? theme.fg("accent", `• ${name} (you)`)
            : theme.fg("text", `• ${name}`));
      }
      return new Text(text, 0, 0);
    },
  });

  // ── Commands ─────────────────────────────────────────────────────────────

  pi.registerCommand("mesh", {
    description: "Show mesh status",
    handler: async (_args, _ctx) => {
      if (role === "disconnected") {
        _ctx.ui.notify("Mesh: not connected", "warning");
        return;
      }
      const names = connectedTerminals.join(", ");
      _ctx.ui.notify(
        `Mesh: ${terminalName} (${role}) · ${connectedTerminals.length} online: ${names}`,
        "info",
      );
    },
  });

  pi.registerCommand("mesh-name", {
    description: "Change mesh name. No arg = use session name",
    handler: async (args, _ctx) => {
      let newName = args.trim();
      if (!newName) {
        // No argument: use session name if available
        const sessionName = pi.getSessionName()?.trim().replace(/\s+/g, " ");
        if (sessionName) {
          newName = sessionName;
        } else {
          _ctx.ui.notify(
            `Current name: "${terminalName}". No session name set. Usage: /mesh-name <name>`,
            "info",
          );
          return;
        }
      }

      if (newName === terminalName) {
        _ctx.ui.notify(`Already using "${newName}"`, "info");
        return;
      }

      // If we're the hub, check uniqueness before renaming
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
        hubBroadcast({ type: "terminal_left", name: old, terminals: list });
        hubBroadcast(
          { type: "terminal_joined", name: newName, terminals: list },
          newName,
        );
        _ctx.ui.notify(`Renamed to "${newName}"`, "info");
      } else if (role === "client") {
        // Reconnect with new name — hub will enforce uniqueness via register
        terminalName = newName;
        ws?.close();
        // Reconnect will happen via the onClose handler → scheduleReconnect
        _ctx.ui.notify(
          `Reconnecting as "${newName}" (hub may assign a different name if taken)...`,
          "info",
        );
      } else {
        terminalName = newName;
        _ctx.ui.notify(`Name set to "${newName}" (not connected)`, "info");
      }
    },
  });

  pi.registerCommand("mesh-broadcast", {
    description: "Broadcast a message to all mesh terminals",
    handler: async (args, _ctx) => {
      const message = args.trim();
      if (!message) {
        _ctx.ui.notify("Usage: /mesh-broadcast <message>", "warning");
        return;
      }
      if (role === "disconnected") {
        _ctx.ui.notify("Not connected to mesh", "warning");
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

  // ── Message renderer ─────────────────────────────────────────────────────

  pi.registerMessageRenderer("mesh", (message, _options, theme) => {
    const from =
      (message.details as Record<string, unknown> | undefined)?.from ?? "mesh";
    const text =
      theme.fg("accent", `⚡ [${from}] `) +
      theme.fg("text", String(message.content));
    return new Text(text, 0, 0);
  });
}
