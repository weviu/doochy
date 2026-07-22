// Wire protocol between the Hub and agents. One JSON object per WebSocket
// message, discriminated by `type`. The Hub NEVER trusts user-identifying
// fields inside a message: after pair/auth, the socket itself is bound to a
// userId and all routing derives from that binding.

// ---- Agent -> Hub ----------------------------------------------------------

export interface PairMsg {
  type: "pair";
  code: string; // 6-char code issued by the /pair bot command, 5-minute expiry
}

export interface AuthMsg {
  type: "auth";
  token: string; // long-lived token minted at pairing time
}

export interface ResponseMsg {
  type: "response";
  requestId: string;
  ok: boolean;
  // For cmd requests: { text, settings?, document? }. `text` is relayed verbatim
  // to the user; if `settings` is present the Hub persists it to users.json as
  // the last-known copy for offline display (the agent remains the authority);
  // if `document` is present the Hub sends it as a Telegram file (this is how
  // /export's trade history crosses the relay — see DocumentPayload).
  // For api requests: the JSON body to return to the mini-app.
  data?: any;
  error?: string;
}

// A file produced by a command (today only /export), carried inline as base64.
// Exports are small — ~286 KB base64 for 1000 trades, against a 100 MiB socket
// limit — so the simplicity of one JSON message beats a streaming channel.
export interface DocumentPayload {
  filename: string;
  // base64-encoded file contents
  data: string;
  caption?: string;
}

export interface NotifyMsg {
  type: "notify";
  message: string; // forwarded to the socket's bound user via Telegram
}

export type AgentMsg = PairMsg | AuthMsg | ResponseMsg | NotifyMsg;

// ---- Hub -> Agent ----------------------------------------------------------

export interface PairedMsg {
  type: "paired";
  token: string;
  userId: number;
}

export interface AuthOkMsg {
  type: "auth_ok";
  userId: number;
}

export interface ErrorMsg {
  type: "error";
  message: string;
}

// A relayed Telegram command, e.g. /risk pertrade 47 becomes
// { cmd: "risk", args: ["pertrade", "47"] }. The Hub does not parse command
// semantics; the agent runs its existing handler and returns display text.
export interface CmdMsg {
  type: "cmd";
  requestId: string;
  cmd: string;
  args: string[];
}

// A relayed mini-app API call, e.g. GET /api/status becomes
// { endpoint: "status", params: {} }.
export interface ApiMsg {
  type: "api";
  requestId: string;
  endpoint: string;
  params: Record<string, any>;
}

// A channel-listener signal, forwarded raw. The agent parses it with its own
// parser (the confidence default is an agent-side setting, so parsing cannot
// live in the Hub without duplicating that authority).
export interface SignalMsg {
  type: "signal";
  requestId: string;
  text: string;
  source: string;
}

export type HubMsg = PairedMsg | AuthOkMsg | ErrorMsg | CmdMsg | ApiMsg | SignalMsg;
