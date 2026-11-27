import Config from "../../src/core/config.js";
import { Friend } from "../../src/api/client.js";
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

  // 软关机期间也照发：账号掉线后收不到 #开机，得先让主人知道
  handleOffline = OnEvent("notice.bot_offline", { whileOff: true }, async (e) => {
    const pendingMasters = new Set(normalizeMasters(Config.get("master")));
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

    // 一个实例只有这一个号；协议端还能发消息时（比如被踢下线前的通知）才送得到
    if (e.bot) {
      await notifyWith(e.bot);
    }

    return false;
  });
}
