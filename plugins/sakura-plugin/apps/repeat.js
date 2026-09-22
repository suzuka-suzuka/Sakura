import _ from "lodash";
import Setting from "../lib/setting.js";
import path from "path";
import { pluginresources } from "../lib/path.js";
import fs from "fs/promises";
let msg = {};

const REPEAT_IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|bmp)$/i;

export class repeatPlugin extends plugin {
  constructor() {
    super({
      name: "repeat",
      event: "message.group",
      priority: 35,
    });
  }

  get appconfig() {
    return Setting.getConfig("repeat");
  }

  fd = OnEvent("message.group", async (e) => {
    try {
      const fdConfig = this.appconfig;
      if (!fdConfig.enable) {
        return false;
      }

      const scopeKey = this.getScopeKey(e.group_id);

      if (!msg[scopeKey]) {
        msg[scopeKey] = {
          message: e.message,
          times: 1,
          lastSender: e.sender.user_id,
        };
        return false;
      }

      if (await this.isSameMessage(e.message, msg[scopeKey].message)) {
        if (msg[scopeKey].lastSender === e.sender.user_id) return false;
        msg[scopeKey].times++;
        msg[scopeKey].lastSender = e.sender.user_id;

        const rule = fdConfig.rules?.find(
          (item) => item.repeatCount === msg[scopeKey].times,
        );
        if (rule) await this.runRule(e, msg[scopeKey], rule, fdConfig);
        return false;
      } else {
        msg[scopeKey].message = e.message;
        msg[scopeKey].times = 1;
        msg[scopeKey].lastSender = e.sender.user_id;
        return false;
      }
    } catch (error) {
      logger.warn(`复读处理失败：${error?.message || error}`);
    }
    // 复读仅执行群聊互动，始终放行给后续插件。
    return false;
  });

  async runRule(e, state, rule, config) {
    let action = rule.action;
    if (action === "random_interrupt") {
      const actions = this.isTextOnlyMessage(state.message)
        ? ["text", "shuffle", "image"]
        : ["text", "image"];
      action = _.sample(actions);
    }

    if (action === "follow") {
      await e.reply(state.message);
      return;
    }

    if (action === "shuffle") {
      await e.reply(this.randomString(e.msg));
      return;
    }

    if (action === "text") {
      await e.reply(this.getBreakText(rule, config));
      return;
    }

    if (action === "image") {
      await this.replyBreakImage(e, rule, config);
      return;
    }

    if (action === "mute") {
      await this.muteLastRepeater(e, state.lastSender, rule);
    }
  }

  getBreakText(rule, config) {
    if (rule.text?.trim()) return rule.text.trim();
    const messages = config.breakMessages?.filter((item) => item?.trim()) || [];
    return _.sample(messages)?.trim() || "请停止复读！";
  }

  async replyBreakImage(e, rule, config) {
    try {
      const repeatImagePath = path.join(pluginresources, "repeat");
      const files = (await fs.readdir(repeatImagePath)).filter((file) =>
        REPEAT_IMAGE_EXTENSIONS.test(file),
      );
      const randomImage = _.sample(files);
      if (!randomImage) throw new Error("复读打断图片目录中没有可用图片");
      await e.reply(segment.image(path.join(repeatImagePath, randomImage)));
    } catch (error) {
      logger.warn(`复读图片打断失败，改用文字打断：${error.message}`);
      await e.reply(this.getBreakText(rule, config));
    }
  }

  async muteLastRepeater(e, targetId, rule) {
    const [botInfo, targetInfo] = await Promise.all([
      e.getInfo(e.self_id),
      e.getInfo(targetId),
    ]);

    if (botInfo?.role === "member") {
      logger.warn(`复读禁言失败：机器人不是群主或管理员`);
      return;
    }
    if (targetInfo?.role !== "member") {
      logger.warn(`复读禁言已跳过：不能禁言群主或管理员 ${targetId}`);
      return;
    }

    await e.ban(rule.muteDuration, targetId);
    if (rule.text?.trim()) await e.reply(rule.text.trim());
  }

  isTextOnlyMessage(message) {
    if (typeof message === "string") return true;
    return (
      Array.isArray(message) &&
      message.length > 0 &&
      message.every((item) => item.type === "text")
    );
  }

  async isSameMessage(message1, message2) {
    if (!Array.isArray(message1) || !Array.isArray(message2)) {
      return message1 === message2;
    }

    if (message1.length !== message2.length) return false;

    for (let i = 0; i < message1.length; i++) {
      const m1 = message1[i];
      const m2 = message2[i];

      if (m1.type !== m2.type) return false;

      if (m1.type === "text") {
        if (m1.data?.text !== m2.data?.text) return false;
      } else if (m1.type === "image") {
        if (m1.data?.file !== m2.data?.file) {
          if (m1.data?.url && m2.data?.url) {
            if (m1.data.url !== m2.data.url) {
              return false;
            }
          } else {
            return false;
          }
        }
      } else {
        if (!_.isEqual(m1, m2)) return false;
      }
    }
    return true;
  }

  randomString(str) {
    if (!str) return "阿巴阿巴";
    let newStrAll = [];
    str.split("").forEach((item) => {
      let newIndex = _.random(0, newStrAll.length);
      newStrAll.splice(newIndex, 0, item);
    });
    return newStrAll.join("");
  }
}
