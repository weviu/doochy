// Lightweight push-notification helper. The Agent entrypoint registers a sink
// that ships each message to the Hub over WebSocket, which delivers it to the
// owning Telegram user, so any module can push an alert without knowing the
// transport. (The direct bot + chatIds backend belonged to the retired
// single-user entrypoint and was removed with it.)
let sink: ((message: string) => void) | null = null;

export function setNotifySink(fn: (message: string) => void): void {
  sink = fn;
}

export async function notify(message: string): Promise<void> {
  if (!sink) return;
  try {
    sink(message);
  } catch (err: any) {
    console.log(`[NOTIFY] Sink failed: ${err.message}`);
  }
}
