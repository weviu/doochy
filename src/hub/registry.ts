import crypto from "crypto";
import type { WebSocket } from "ws";
import { AgentMsg, ApiMsg, CmdMsg, HubMsg, SignalMsg } from "./protocol";
import { findAgentByToken, isKnownUser, mintAgentToken, touchAgent } from "./db";

// Live-connection registry and request/response correlation. This is the heart
// of the Hub: it binds authenticated sockets to Telegram user IDs, issues
// pairing codes, and matches agent responses back to waiting requests.

// How long a /pair code stays valid. Codes live in memory only; a Hub restart
// simply voids outstanding codes and the user runs /pair again.
const PAIR_CODE_TTL_MS = 5 * 60_000;

// How long any relayed request may wait for the agent's response. A friend's
// sleeping PC must produce a clean "agent not responding" reply, not a hang.
export const REQUEST_TIMEOUT_MS = 15_000;

// Unambiguous alphabet for pairing codes: no 0/O or 1/I lookalikes, since the
// code is read off a phone screen and typed into a terminal.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

interface Pending {
  resolve: (msg: { ok: boolean; data?: any; error?: string }) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface NotifySink {
  (userId: number, message: string): void;
}

export class Registry {
  private pairCodes = new Map<string, { userId: number; expires: number }>();
  private byUser = new Map<number, WebSocket>();
  private socketUser = new Map<WebSocket, number>();
  private socketToken = new Map<WebSocket, string>();
  private pending = new Map<string, Pending>();
  // Where notify messages go (the Telegram bot). Set once at boot; a no-op sink
  // keeps the Hub testable without a live bot.
  private notifySink: NotifySink = (userId, message) =>
    console.log(`[HUB] notify (no bot wired) for ${userId}: ${message}`);

  setNotifySink(sink: NotifySink): void {
    this.notifySink = sink;
  }

  // ---- pairing codes (issued by the /pair bot command) ---------------------

  issuePairCode(userId: number): string {
    // One active code per user: re-running /pair invalidates the previous code.
    for (const [code, rec] of this.pairCodes) {
      if (rec.userId === userId) this.pairCodes.delete(code);
    }
    let code = "";
    for (const b of crypto.randomBytes(6)) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
    this.pairCodes.set(code, { userId, expires: Date.now() + PAIR_CODE_TTL_MS });
    return code;
  }

  // Dev-only escape hatch: pre-seed a known code so pairing can be exercised
  // before the Telegram bot is live. Only wired up when HUB_DEV_PAIR_CODE is
  // set; never set it in production.
  seedDevPairCode(code: string, userId: number): void {
    this.pairCodes.set(code.toUpperCase(), { userId, expires: Date.now() + 24 * 3600_000 });
  }

  private consumePairCode(code: string): number | undefined {
    const rec = this.pairCodes.get(code.toUpperCase());
    if (!rec) return undefined;
    this.pairCodes.delete(code.toUpperCase());
    if (rec.expires < Date.now()) return undefined;
    return rec.userId;
  }

  // ---- socket lifecycle -----------------------------------------------------

  socketFor(userId: number): WebSocket | undefined {
    return this.byUser.get(userId);
  }

  userFor(socket: WebSocket): number | undefined {
    return this.socketUser.get(socket);
  }

  connectedUserIds(): number[] {
    return [...this.byUser.keys()];
  }

  private bind(socket: WebSocket, userId: number, token: string): void {
    // Newest connection wins: if the user's agent reconnects (restart, network
    // change) the stale socket is closed so routing never targets a zombie.
    const prev = this.byUser.get(userId);
    if (prev && prev !== socket) {
      this.socketUser.delete(prev);
      this.socketToken.delete(prev);
      try { prev.close(4000, "replaced by a newer connection"); } catch { /* already dead */ }
    }
    this.byUser.set(userId, socket);
    this.socketUser.set(socket, userId);
    this.socketToken.set(socket, token);
  }

  release(socket: WebSocket): void {
    const userId = this.socketUser.get(socket);
    const token = this.socketToken.get(socket);
    this.socketUser.delete(socket);
    this.socketToken.delete(socket);
    // Only clear the user mapping if this socket still owns it; a replaced
    // socket closing late must not evict its successor.
    if (userId !== undefined && this.byUser.get(userId) === socket) {
      this.byUser.delete(userId);
      console.log(`[HUB] Agent for user ${userId} disconnected`);
    }
    if (token) touchAgent(token);
  }

  // ---- request/response correlation ----------------------------------------

  // Send a cmd/api/signal message to an agent and await the matching response.
  // Rejects after REQUEST_TIMEOUT_MS so callers can tell the user the agent is
  // asleep instead of hanging a Telegram reply or an HTTP request forever.
  request(
    socket: WebSocket,
    // Omit must be applied per union member (it collapses a union to its
    // common properties otherwise), hence the explicit distribution.
    msg: Omit<CmdMsg, "requestId"> | Omit<ApiMsg, "requestId"> | Omit<SignalMsg, "requestId">,
    timeoutMs: number = REQUEST_TIMEOUT_MS
  ): Promise<{ ok: boolean; data?: any; error?: string }> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("agent did not respond in time"));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ ...msg, requestId }));
      } catch (err: any) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error(`send failed: ${err.message}`));
      }
    });
  }

  // ---- inbound message handling ---------------------------------------------

  // Process one message from an agent socket. Returns the reply to send, if any.
  handleMessage(socket: WebSocket, msg: AgentMsg): HubMsg | undefined {
    switch (msg.type) {
      case "pair": {
        const userId = this.consumePairCode(String(msg.code || ""));
        if (userId === undefined) return { type: "error", message: "invalid or expired pairing code" };
        const token = mintAgentToken(userId);
        this.bind(socket, userId, token);
        console.log(`[HUB] Agent paired for user ${userId}`);
        return { type: "paired", token, userId };
      }

      case "auth": {
        const rec = findAgentByToken(String(msg.token || ""));
        // Re-check the whitelist on every auth so removing someone from
        // users.json also cuts off their already-paired agent.
        if (!rec || !isKnownUser(rec.userId)) return { type: "error", message: "invalid token" };
        this.bind(socket, rec.userId, String(msg.token));
        touchAgent(String(msg.token));
        console.log(`[HUB] Agent authenticated for user ${rec.userId}`);
        return { type: "auth_ok", userId: rec.userId };
      }

      case "response": {
        if (this.userFor(socket) === undefined) return { type: "error", message: "not authenticated" };
        const p = this.pending.get(String(msg.requestId));
        // Late responses (after timeout) are dropped silently; the user was
        // already told the agent did not respond.
        if (!p) return undefined;
        this.pending.delete(String(msg.requestId));
        clearTimeout(p.timer);
        p.resolve({ ok: !!msg.ok, data: msg.data, error: msg.error });
        return undefined;
      }

      case "notify": {
        // Route by the socket's authenticated binding only. Any userId field an
        // agent might include is ignored: an agent can never notify (or spoof)
        // another user.
        const userId = this.userFor(socket);
        if (userId === undefined) return { type: "error", message: "not authenticated" };
        this.notifySink(userId, String(msg.message || ""));
        return undefined;
      }

      default:
        return { type: "error", message: `unknown message type: ${(msg as any)?.type}` };
    }
  }
}
