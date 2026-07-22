import { state, symbolIdFor } from "../state";
import { processSignal } from "../risk/gate";
import { parseTextSignal } from "../webhook";
import { getSymbolSpec, previewOrder, getPendingOrders, cancelOrder, amendOrder } from "../ctrader/orders";
import { canValueInUsd, getQuote } from "../ctrader/livePrices";
import { closePosition } from "../risk/midnightClose";
import { amendPositionSLTP } from "../ctrader/amend";
import { pauseCmd } from "../bot/commands/pause";
import { resumeCmd } from "../bot/commands/resume";
import { symbolsCmd } from "../bot/commands/symbols";
import { riskCmd } from "../bot/commands/risk";
import { minholdCmd } from "../bot/commands/minhold";
import { closeallCmd } from "../bot/commands/closeall";
import { exportCmd } from "../bot/commands/export";
import { statusCmd, getStatusData } from "../bot/commands/status";
import { settingsCmd } from "../bot/commands/settings";
import { notificationsCmd } from "../bot/commands/notifications";
import { cooldownCmd } from "../bot/commands/cooldown";
import { positionsCmd, getPositionsData } from "../bot/commands/positions";
import { getSignalHistory } from "../signals/history";
import { orderCmd } from "../bot/commands/order";
import { getConnection, pauseTrading, resumeTrading, closeAll } from "../miniapp/service";
import { HubRequest } from "./hubClient";
import { DocumentPayload } from "../hub/protocol";

// Translate Hub requests into the existing single-user handlers. The grammY
// handlers only ever use ctx.message.text, ctx.reply, and (export only)
// ctx.replyWithDocument, so a synthetic ctx that collects replies lets them run
// unchanged over the WS relay.

type Handler = (ctx: any) => Promise<void> | void;

const COMMANDS: Record<string, Handler> = {
  pause: pauseCmd,
  resume: resumeCmd,
  symbols: symbolsCmd,
  risk: riskCmd,
  minhold: minholdCmd,
  closeall: closeallCmd,
  export: exportCmd,
  status: statusCmd,
  settings: settingsCmd,
  notifications: notificationsCmd,
  cooldown: cooldownCmd,
  positions: positionsCmd,
  order: orderCmd,
};

// Same text the legacy /guide serves (src/index.ts). Duplicated deliberately:
// the legacy entrypoint must stay byte-for-byte untouched until cutover, after
// which it is deleted and this copy becomes the only one.
const GUIDE_TEXT =
  "HOW TO START TRADING\n" +
  "\n" +
  "1. Set your risk per trade (REQUIRED)\n" +
  "Nothing trades until this is set. It is the max $ you lose if a trade's stop is hit; the bot sizes every position to match.\n" +
  "   /risk pertrade 50\n" +
  "\n" +
  "2. Nothing to set for SL/TP\n" +
  "Each signal carries its own stop and target; the bot sizes the trade to that stop so a hit loses ~your pertrade amount. A signal with no SL/TP is skipped.\n" +
  "\n" +
  "3. Choose which symbols to trade\n" +
  "   /symbols  (show current list)\n" +
  "   /symbols add XAUUSD\n" +
  "\n" +
  "4. Set daily safety limits (recommended)\n" +
  "Each one force-closes everything and stops trading for the day when hit.\n" +
  "   /risk maxloss 200  (daily loss limit)\n" +
  "   /risk cap 300      (daily profit cap, 0 = off)\n" +
  "\n" +
  "5. Confirm it is live\n" +
  "   /resume  (only if you previously paused)\n" +
  "   /status  (Sizing should show your $ risk, not 'not set')\n" +
  "\n" +
  "Done. Signals will now execute. See /help for the full command list.";

// Run one relayed command through its existing handler, collecting every
// ctx.reply into the response text. The full settings snapshot rides along on
// every response so the Hub's last-known copy (users.json) stays fresh without
// the Hub knowing which commands mutate settings.
async function runCommand(cmd: string, args: string[]): Promise<{ ok: boolean; data?: any; error?: string }> {
  if (cmd === "guide") {
    return { ok: true, data: { text: GUIDE_TEXT, settings: { ...state.settings } } };
  }

  const handler = COMMANDS[cmd];
  if (!handler) return { ok: false, error: `unknown command: ${cmd}` };

  // Manual orders arrive as the raw message ("SELL XAUUSD 0.02 ..."); slash
  // commands are reassembled the way grammY would have delivered them.
  const text = cmd === "order" ? args.join(" ") : `/${cmd} ${args.join(" ")}`.trim();

  const replies: string[] = [];
  let document: DocumentPayload | undefined;
  const ctx = {
    message: { text },
    reply: async (t: string) => { replies.push(t); },
    // /export hands grammY an InputFile; carry its bytes over the relay as
    // base64 so the Hub can send the real file to Telegram. Only the last
    // document survives — no command produces more than one.
    replyWithDocument: async (file: any, other?: { caption?: string }) => {
      const bytes: Buffer | undefined = file?.fileData;
      if (!Buffer.isBuffer(bytes)) {
        replies.push("(could not attach the file)");
        return;
      }
      document = {
        filename: file.filename || "export.json",
        data: bytes.toString("base64"),
        caption: other?.caption,
      };
    },
  };

  await handler(ctx);

  // Progress chatter ("Fetching trade history…") is written for a live chat: over
  // the relay every reply is delivered at once, at the END, so it would arrive
  // after the work it announces. Drop it when a file made it through — the
  // document and its caption are the real answer.
  const replyText = document
    ? replies.filter((r) => !/^Fetching /i.test(r)).join("\n\n")
    : replies.join("\n\n") || "OK";

  return {
    ok: true,
    data: {
      text: replyText,
      settings: { ...state.settings },
      ...(document ? { document } : {}),
    },
  };
}

// The mini-app API surface, same endpoints the old in-process /api served.
async function runApi(endpoint: string, params: Record<string, any> = {}): Promise<{ ok: boolean; data?: any; error?: string }> {
  switch (endpoint) {
    case "status":
      return { ok: true, data: await getStatusData(getConnection()) };
    case "positions":
      return { ok: true, data: getPositionsData() };

    // The signal log: every signal the gate evaluated (executed or rejected),
    // newest first, for the mini-app's Signals view.
    case "signals":
      return { ok: true, data: { signals: getSignalHistory() } };

    // Resting (unfilled) LIMIT/STOP entry orders sitting at the broker. Read via
    // reconcile so it's authoritative and includes orders placed outside the bot.
    case "pending_orders":
      return { ok: true, data: { orders: await getPendingOrders() } };

    // Cancel one resting order by its broker orderId (the mini-app's per-order
    // cancel). Reuses the same ProtoOACancelOrderReq the news guard uses.
    case "cancel_order": {
      const orderId = Number(params.orderId);
      if (!orderId) return { ok: false, error: "no order id" };
      const r = await cancelOrder(orderId);
      return r.ok
        ? { ok: true, data: { cancelled: true, text: `Cancelled order #${orderId}.` } }
        : { ok: false, error: r.error || "cancel failed" };
    }

    // Edit a resting order's level and/or its SL/TP. Fields left null keep their
    // current value; the agent re-reads the order from the broker to validate.
    case "amend_order": {
      const orderId = Number(params.orderId);
      if (!orderId) return { ok: false, error: "no order id" };
      const price = params.price != null && Number(params.price) > 0 ? Number(params.price) : null;
      const sl = params.sl != null && Number(params.sl) > 0 ? Number(params.sl) : null;
      const tp = params.tp != null && Number(params.tp) > 0 ? Number(params.tp) : null;
      if (price === null && sl === null && tp === null) return { ok: false, error: "nothing to change" };
      const r = await amendOrder(orderId, { price, sl, tp });
      return r.ok
        ? { ok: true, data: { text: `Updated order #${orderId}.` } }
        : { ok: false, error: r.error || "amend failed" };
    }
    case "settings":
      // The full settings object, for the mini-app's control panel to pre-fill
      // its forms. The text /settings command isn't machine-readable; this is.
      return { ok: true, data: { ...state.settings } };

    // Live two-sided prices plus each symbol's tradable size grid, for the
    // manual-order panel's selector and price header. Only allowed symbols:
    // those are the ones already pre-subscribed at boot (so this is an
    // in-memory read) and the only ones an order would be accepted for.
    case "quotes": {
      const rows = await Promise.all(state.settings.allowedSymbols.map(async (symbol) => {
        const q = getQuote(symbol);
        const symId = symbolIdFor(symbol);
        let minLots: number | null = null;
        let lotStep: number | null = null;
        if (symId !== undefined) {
          try {
            const spec = await getSymbolSpec(symId);
            if (spec?.lotSize) {
              minLots = spec.minVolume ? spec.minVolume / spec.lotSize : null;
              lotStep = spec.stepVolume ? spec.stepVolume / spec.lotSize : null;
            }
          } catch { /* spec unavailable; the panel falls back to free-form input */ }
        }
        return {
          symbol,
          bid: q?.bid ?? null,
          ask: q?.ask ?? null,
          hasQuote: !!q,
          tradable: symId !== undefined && canValueInUsd(symbol),
          minLots,
          lotStep,
        };
      }));
      return { ok: true, data: { quotes: rows } };
    }

    // Close one position outright (the mini-app's per-position close). Reuses
    // the same closePosition the midnight closer and /closeall drive.
    case "close_position": {
      const posId = Number(params.posId);
      const pos = state.positions.get(posId);
      if (!pos) return { ok: false, error: "position not found (it may have just closed)" };
      const label = `${pos.direction} ${pos.symbol} ${pos.volume}L`;
      const ok = await closePosition(posId);
      return ok
        ? { ok: true, data: { closed: true, text: `Closed ${label}.` } }
        : { ok: false, error: `Could not close ${label}` };
    }

    // Edit an open position's SL/TP. state.positions is updated as well as the
    // broker: the SL watchdog and the profit-cap re-amend both re-send the
    // position's stored levels, so without the state write they would quietly
    // revert this edit on their next pass.
    case "amend_position": {
      const posId = Number(params.posId);
      const pos = state.positions.get(posId);
      if (!pos) return { ok: false, error: "position not found (it may have just closed)" };

      const sl = params.sl != null && Number(params.sl) > 0 ? Number(params.sl) : null;
      const tp = params.tp != null && Number(params.tp) > 0 ? Number(params.tp) : null;
      if (sl === null && tp === null) return { ok: false, error: "nothing to change" };

      // Same rule the manual-order path enforces: levels must sit on the right
      // side of the entry, or the broker rejects them (or worse, accepts an
      // instant-loss stop).
      const ref = pos.entryPrice;
      if (pos.direction === "BUY") {
        if (tp != null && tp <= ref) return { ok: false, error: `For a BUY, TP must be above the entry (${ref})` };
        if (sl != null && sl >= ref) return { ok: false, error: `For a BUY, SL must be below the entry (${ref})` };
      } else {
        if (tp != null && tp >= ref) return { ok: false, error: `For a SELL, TP must be below the entry (${ref})` };
        if (sl != null && sl <= ref) return { ok: false, error: `For a SELL, SL must be above the entry (${ref})` };
      }

      const nextSl = sl ?? pos.sl ?? undefined;
      const nextTp = tp ?? pos.tp ?? undefined;
      try {
        await amendPositionSLTP(posId, pos.symbol, pos.entryPrice, pos.direction, { sl: nextSl, tp: nextTp });
      } catch (err: any) {
        return { ok: false, error: err?.message || "amend failed" };
      }
      pos.sl = nextSl ?? null;
      pos.tp = nextTp ?? null;
      return { ok: true, data: { text: `Updated ${pos.symbol}: SL ${pos.sl ?? "-"}, TP ${pos.tp ?? "-"}.` } };
    }

    // What a given size (or a given risk) would actually mean, computed by the
    // same code that sizes the real order.
    case "order_preview": {
      const res = await previewOrder({
        symbol: String(params.symbol || ""),
        direction: params.direction === "SELL" ? "SELL" : "BUY",
        orderType: params.orderType === "LIMIT" ? "LIMIT" : "MARKET",
        entry: params.entry != null ? Number(params.entry) : null,
        sl: params.sl != null ? Number(params.sl) : null,
        tp: params.tp != null ? Number(params.tp) : null,
        mode: params.mode === "risk" ? "risk" : "size",
        lots: params.lots != null ? Number(params.lots) : null,
        riskUSD: params.riskUSD != null ? Number(params.riskUSD) : null,
      });
      return res.ok ? { ok: true, data: res.preview } : { ok: false, error: res.error };
    }
    case "pause":
      pauseTrading();
      return { ok: true, data: { paused: true } };
    case "resume": {
      const { wasLocked } = resumeTrading();
      return { ok: true, data: { paused: false, lockCleared: wasLocked } };
    }
    case "closeall":
      return { ok: true, data: await closeAll() };
    default:
      return { ok: false, error: `unknown endpoint: ${endpoint}` };
  }
}

// Channel signal, forwarded raw by the Hub. Parsed here (not in the Hub)
// because the confidence default is this agent's own setting.
function runSignal(text: string, source: string): { ok: boolean; data?: any; error?: string } {
  const signal = parseTextSignal(text, source);
  if (!signal) return { ok: false, error: "could not parse signal" };
  const result = processSignal(signal);
  return {
    ok: true,
    data: {
      text: result.accepted
        ? `Signal accepted: ${signal.direction} ${signal.symbol} executing`
        : `Signal rejected: ${result.reason ?? "unknown reason"}`,
    },
  };
}

export async function handleHubRequest(msg: HubRequest): Promise<{ ok: boolean; data?: any; error?: string }> {
  switch (msg.type) {
    case "cmd":
      return runCommand(String(msg.cmd || ""), msg.args || []);
    case "api":
      return runApi(String(msg.endpoint || ""), msg.params || {});
    case "signal":
      return runSignal(String(msg.text || ""), String(msg.source || "Channel"));
    default:
      return { ok: false, error: `unknown request type: ${(msg as any).type}` };
  }
}
