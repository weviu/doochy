import { state, persistSettings } from "../../state";

// Manage Telegram notifications:
//   /notifications on|off                 - order fill notifications
//   /notifications signals on|off         - notify on every incoming signal
//   /notifications signals min <0-100>    - min confidence to notify on a signal
export async function notificationsCmd(ctx: any) {
  const parts = ctx.message.text.trim().split(/\s+/);
  const arg = parts[1]?.toLowerCase();

  // Fill notifications: /notifications on | off
  if (arg === "on" || arg === "off") {
    state.settings.notifyFills = arg === "on";
    persistSettings();
    await ctx.reply(
      state.settings.notifyFills
        ? "Order notifications on. You will get a message when an order fills."
        : "Order notifications off."
    );
    return;
  }

  // Signal notifications: /notifications signals on|off | min <n>
  if (arg === "signals") {
    const sub = parts[2]?.toLowerCase();

    if (sub === "on" || sub === "off") {
      state.settings.signalNotify = sub === "on";
      persistSettings();
      await ctx.reply(
        state.settings.signalNotify
          ? `Signal notifications on. You will get a message for every signal scoring at least ${state.settings.signalNotifyMinConfidence}, whether or not it trades here.`
          : "Signal notifications off."
      );
      return;
    }

    if (sub === "min" && parts[3] !== undefined) {
      const n = parseInt(parts[3]);
      if (isNaN(n) || n < 0 || n > 100) {
        await ctx.reply("Signal notification minimum confidence must be between 0 and 100%");
        return;
      }
      state.settings.signalNotifyMinConfidence = n;
      persistSettings();
      await ctx.reply(`Signal notifications now fire only for signals scoring at least ${n}%`);
      return;
    }

    await ctx.reply(
      `Signal notifications are ${state.settings.signalNotify ? "on" : "off"} (min confidence ${state.settings.signalNotifyMinConfidence}).\n` +
      "Usage: /notifications signals on | off | min <0-100>"
    );
    return;
  }

  await ctx.reply(
    `Order fill notifications: ${state.settings.notifyFills ? "on" : "off"}.\n` +
    `Signal notifications: ${state.settings.signalNotify ? "on" : "off"} (min confidence ${state.settings.signalNotifyMinConfidence}).\n` +
    "Usage:\n" +
    "/notifications on | off            (order fills)\n" +
    "/notifications signals on | off    (every incoming signal)\n" +
    "/notifications signals min <0-100> (signal threshold)"
  );
}
