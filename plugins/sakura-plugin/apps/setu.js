import { sendPixivImages } from "../lib/pixiv/sendImages.js";
import setting from "../lib/setting.js";

export class setuPlugin extends plugin {
  constructor() {
    super({
      name: "setu",
      event: "message",
      priority: 1135,
    });
  }

  get r18Config() {
    return setting.getConfig("r18");
  }

  get pixivConfig() {
    return setting.getConfig("pixiv");
  }

  handleApiRequest = Command(/^#?来张涩图(。)?(.*)$/, async (e) => {
    let apiType = "lolicon",
      tag,
      isR18 = false;

    const match = e.msg.match(/^#?来张涩图(。)?(.*)$/);
    isR18 = !!match?.[1];
    tag = match?.[2]?.trim() || "";

    if (isR18 && !this.r18Config.Groups.includes(e.group_id)) {
      return e.reply("本群未开启r18功能哦~", 10, false);
    }
    await e.react(124);
    try {
      const imageInfo = await this.fetchLolicon(tag, isR18);

      if (!imageInfo?.url) {
        return e.reply(
          tag ? `标签「${tag}」找不到对应的图片。` : "未能找到图片。",
          10,
          true
        );
      }

      const messageText = `${imageInfo.id ? "pid:" + imageInfo.id : ""}${imageInfo.tags?.length ? "\n标签: " + imageInfo.tags.join(", ") : ""
        }`;

      await this.sendImageWithRetry(e, imageInfo.url, messageText, isR18, imageInfo.id);
    } catch (err) {
      logger.error(`处理API请求时出错 (${apiType}): ${err.message}`);
      await e.reply(`获取图片时出错: ${err.message}`, 10, true);
    }
  });

  async sendImageWithRetry(e, imageUrl, messageText, isR18, pid) {
    const config = this.pixivConfig;
    const initialRecallTime = isR18 ? (config.recallTime ?? 10) : 0;

    const finalSuccess = await sendPixivImages(e, {
      imageUrls: [imageUrl],
      proxy: config.proxy,
      pid,
      initialRecallTime,
      fallbackRecallTime: config.recallTime ?? 10,
    });

    if (finalSuccess) {
      if (messageText) {
        await e.reply(messageText, 60, false);
      }
      await e.reply("图片已发送", 10, true);
    } else {
      await e.reply(
        "图片和备用链接均发送失败，请稍后再试。",
        10,
        true
      );
    }

    return finalSuccess;
  }

  async fetchApi(url, apiName) {
    const response = await fetch(url).catch((err) => {
      throw new Error(`${apiName} 网络错误: ${err.message}`);
    });

    if (!response.ok) {
      const errorText = await response
        .text()
        .catch(() => `HTTP status ${response.status}`);
      throw new Error(`${apiName} API 错误: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    if (data.error || !data.data?.length) {
      throw new Error(
        `${apiName} API 返回错误或无数据: ${data.error || "空数据数组"}`
      );
    }
    return data.data[0];
  }

  async fetchLolicon(tag = "", isR18 = false) {
    const params = new URLSearchParams({
      size: "original",
      r18: isR18 ? "1" : "0",
      proxy: "",
      excludeAI: "true",
    });

    if (tag) {
      tag
        .split(/\s+/)
        .filter(Boolean)
        .forEach((t) => params.append("tag", t));
    }

    const apiUrl = `https://api.lolicon.app/setu/v2?${params}`;
    const imageInfo = await this.fetchApi(apiUrl, "Lolicon");

    return {
      url: imageInfo.urls?.original,
      id: imageInfo.pid,
      tags: imageInfo.tags?.slice(0, 5) || [],
    };
  }
}
