// Thin wrapper over the Telegram Mini App SDK. Everything degrades gracefully
// when the app is opened outside Telegram (e.g. a plain browser during dev),
// so the UI still renders — API calls will 401 without valid initData, which is
// expected off-platform.

export const tg = typeof window !== "undefined" ? window.Telegram?.WebApp : undefined;

export function initTelegram(): void {
  if (!tg) return;
  tg.ready();
  tg.expand();
  // Match the Dark Notion canvas so the Telegram chrome blends in.
  tg.setHeaderColor?.("#191919");
  tg.setBackgroundColor?.("#191919");
}

// The signed payload we send on every API request to prove who we are.
export function initData(): string {
  return tg?.initData || "";
}

export function haptic(style: "light" | "medium" | "heavy" = "light"): void {
  tg?.HapticFeedback?.impactOccurred(style);
}

export function notify(type: "error" | "success" | "warning"): void {
  tg?.HapticFeedback?.notificationOccurred(type);
}
