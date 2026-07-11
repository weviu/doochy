// Lightweight push-notification helper. The Telegram bot instance and the
// chat IDs (allowed user IDs double as DM chat IDs) are registered at startup,
// then any module can push an alert without importing the bot directly.
let bot: any = null;
let chatIds: number[] = [];

export function setNotifier(b: any, ids: number[]): void {
  bot = b;
  chatIds = ids.filter((n) => !isNaN(n) && n !== 0);
}

export async function notify(message: string): Promise<void> {
  if (!bot || chatIds.length === 0) return;
  for (const id of chatIds) {
    try {
      await bot.api.sendMessage(id, message);
    } catch (err: any) {
      console.log(`[NOTIFY] Failed to message ${id}: ${err.message}`);
    }
  }
}
