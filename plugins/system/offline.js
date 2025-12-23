import Config from "../../src/core/config.js";
import { Friend } from "../../src/api/client.js";

export class OfflineNotify extends plugin {
  constructor() {
    super({
      name: "离线通知",
      dsc: "Bot离线时通知主人",
      event: "notice.bot_offline",
      priority: -Infinity,
    });
  }

  handleOffline = OnEvent("notice.bot_offline", async (e) => {
    const master = Config.get('master');

    if (!master) {
      return false;
    }

    const selfId = e.self_id;
    const tag = e.tag;
    const message = e.message;

    const notifyMsg = `[${selfId}] ${tag}：${message}`;

    if (e.bot) {
      try {
        const friend = new Friend(e.bot, master);
        const res = await friend.sendMsg(notifyMsg);
        if (res?.message_id) {
          return false;
        }
      } catch {}
    }

    try {
      const { bots } = await import("../../src/api/client.js");

      for (const [botId, botInstance] of bots) {
        if (botId === selfId) continue;

        try {
          const friend = new Friend(botInstance, master);
          const res = await friend.sendMsg(notifyMsg);
          if (res?.message_id) {
            return false;
          }
        } catch {}
      }
    } catch {}

    return false;
  });
}
