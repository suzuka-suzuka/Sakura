import Config from "../../src/core/config.js";
import { Friend, bots } from "../../src/api/client.js";
import { OnEvent, plugin } from "../../src/core/plugin.js";
import { normalizeMasters } from "../../src/utils/common.js";

export class OfflineNotify extends plugin {
  constructor() {
    super({
      name: "离线通知",
      dsc: "Bot 离线时通知主人",
      event: "notice.bot_offline",
      priority: -Infinity,
    });
  }

  handleOffline = OnEvent("notice.bot_offline", async (e) => {
    const pendingMasters = new Set(normalizeMasters(Config.getForSelf(e.self_id, "master")));
    if (pendingMasters.size === 0) {
      return false;
    }

    const selfId = e.self_id;
    const tag = e.tag;
    const message = e.message;
    const notifyMsg = `[${selfId}] ${tag}：${message}`;

    const notifyWith = async (botInstance) => {
      for (const master of [...pendingMasters]) {
        try {
          const friend = new Friend(botInstance, master);
          const res = await friend.sendMsg(notifyMsg);
          if (res?.message_id) {
            pendingMasters.delete(master);
          }
        } catch {}
      }
    };

    if (e.bot) {
      await notifyWith(e.bot);
    }

    for (const [botId, botInstance] of bots) {
      if (pendingMasters.size === 0) break;
      if (botId === selfId) continue;

      await notifyWith(botInstance);
    }

    return false;
  });
}
