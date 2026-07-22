// Lightweight push-notification helper. Two backends, registered at startup:
// the legacy single-user entrypoint wires a Telegram bot + chat IDs, the Agent
// entrypoint wires a sink that ships the message to the Hub over WebSocket.
// Either way, any module can push an alert without knowing the transport.
let bot: any = null;
let chatIds: number[] = [];
let sink: ((message: string) => void) | null = null;

export function setNotifier(b: any, ids: number[]): void {
  bot = b;
  chatIds = ids.filter((n) => !isNaN(n) && n !== 0);
}

// Agent mode: route notifications through the Hub instead of a local bot.
export function setNotifySink(fn: (message: string) => void): void {
  sink = fn;
}

export async function notify(message: string): Promise<void> {
  if (sink) {
    try { sink(message); } catch (err: any) {
      console.log(`[NOTIFY] Sink failed: ${err.message}`);
    }
    return;
  }
  if (!bot || chatIds.length === 0) return;
  for (const id of chatIds) {
    try {
      await bot.api.sendMessage(id, message);
    } catch (err: any) {
      console.log(`[NOTIFY] Failed to message ${id}: ${err.message}`);
    }
  }
}
