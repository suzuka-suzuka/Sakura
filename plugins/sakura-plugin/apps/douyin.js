import setting from "../lib/setting.js";
import {
  DouyinService,
  extractDouyinUrlFromText,
  extractDouyinUrlFromValue,
  formatDouyinCount,
} from "../lib/douyin/douyinService.js";

const service = new DouyinService();
const activeRequests = new Set();
const requestCooldowns = new Map();
const MANUAL_COMMAND_PATTERN = /^\s*[#＃]?\s*抖音解析(?:\s|$)/i;
const CLEANUP_DELAY_MS = 90_000;

function scheduleCleanup(paths) {
  const files = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  if (files.length === 0) return;
  const timer = setTimeout(() => service.cleanup(files), CLEANUP_DELAY_MS);
  timer.unref?.();
}

function formatDuration(seconds) {
  const duration = Math.max(0, Math.floor(Number(seconds) || 0));
  if (!duration) return "";
  const hours = Math.floor(duration / 3600);
  const minutes = Math.floor((duration % 3600) / 60);
  const remaining = duration % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(
      2,
      "0"
    )}`;
  }
  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function formatSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return "";
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function shortText(value, maxLength = 400) {
  const text = String(value || "").trim().replace(/\n{3,}/g, "\n\n");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function buildSummaryText(aweme) {
  const lines = [aweme.type === "note" ? "抖音图文解析" : "抖音视频解析"];
  lines.push(`作者：${aweme.author?.nickname || "抖音用户"}`);
  if (aweme.desc) lines.push(`文案：${shortText(aweme.desc)}`);

  const stats = [];
  if (aweme.stats?.play > 0) stats.push(`播放 ${formatDouyinCount(aweme.stats.play)}`);
  if (aweme.stats?.like > 0) stats.push(`点赞 ${formatDouyinCount(aweme.stats.like)}`);
  if (aweme.stats?.comment > 0) stats.push(`评论 ${formatDouyinCount(aweme.stats.comment)}`);
  if (aweme.stats?.collect > 0) stats.push(`收藏 ${formatDouyinCount(aweme.stats.collect)}`);
  if (aweme.stats?.share > 0) stats.push(`分享 ${formatDouyinCount(aweme.stats.share)}`);
  if (stats.length > 0) lines.push(`数据：${stats.join(" · ")}`);

  if (aweme.duration > 0) lines.push(`时长：${formatDuration(aweme.duration)}`);
  if (aweme.publishedAt) lines.push(`发布时间：${aweme.publishedAt}`);
  if (aweme.sourceUrl) lines.push(`原链接：${aweme.sourceUrl}`);
  return lines.join("\n");
}

async function sendSummary(e, aweme) {
  const text = buildSummaryText(aweme);
  if (!aweme.cover) {
    await e.reply(text);
    return;
  }

  try {
    await e.reply([segment.image(aweme.cover), segment.text(text)]);
  } catch (error) {
    logger.warn(`[Douyin] 封面发送失败，回退为纯文本：${error.message}`);
    await e.reply(text);
  }
}

function buildForwardNode(e, aweme, content) {
  const botId = Number(e.bot?.self_id || e.self_id || e.user_id || 10000);
  return {
    user_id: Number.isFinite(botId) ? botId : 10000,
    nickname: aweme.author?.nickname || "抖音图文",
    content,
  };
}

async function sendGallery(e, aweme, config) {
  const maxCount = Math.max(1, Number(config.maxGalleryImages) || 12);
  const result = await service.downloadImages(aweme, {
    maxCount,
    concurrency: 3,
  });
  const paths = result.files.map((item) => item.path);

  try {
    if (paths.length === 0) {
      const firstImage = aweme.images?.[0];
      if (firstImage) {
        try {
          await e.reply(segment.image(firstImage));
        } catch {
        }
      }
      await e.reply(`图文图片下载失败，请打开原链接查看：\n${aweme.sourceUrl}`);
      return false;
    }

    const nodes = paths.map((filePath, index) =>
      buildForwardNode(e, aweme, [
        segment.image(filePath),
        ...(index === 0 && aweme.sourceUrl
          ? [segment.text(`第 1/${paths.length} 张\n${aweme.sourceUrl}`)]
          : [segment.text(`第 ${index + 1}/${paths.length} 张`)]),
      ])
    );
    await e.sendForwardMsg(nodes, {
      source: `抖音图文（${paths.length}张）`,
      prompt: "点击查看图文",
      news: [
        { text: `作者：${aweme.author?.nickname || "抖音用户"}` },
        { text: shortText(aweme.desc, 80) || "无文案" },
      ],
    });

    if (aweme.images.length > paths.length || result.failures.length > 0) {
      await e.reply(
        `共识别 ${aweme.images.length} 张图片，成功发送 ${paths.length} 张${
          aweme.images.length > maxCount ? `（最多发送 ${maxCount} 张）` : ""
        }。`
      );
    }
    return true;
  } catch (error) {
    logger.warn(`[Douyin] 图文转发失败，回退首图：${error.message}`);
    try {
      await e.reply([
        segment.image(paths[0]),
        segment.text(`图文合并转发失败，已发送首图。\n${aweme.sourceUrl}`),
      ]);
    } catch {
      await e.reply(`图文发送失败，请打开原链接查看：\n${aweme.sourceUrl}`);
    }
    return false;
  } finally {
    scheduleCleanup(paths);
  }
}

async function sendVideo(e, aweme, config) {
  const maxDuration = Math.max(0, Number(config.maxVideoDurationSeconds) || 0);
  if (maxDuration > 0 && aweme.duration > maxDuration) {
    await e.reply(
      `视频时长 ${formatDuration(aweme.duration)}，超过 ${formatDuration(
        maxDuration
      )} 的发送上限，已保留作品信息和原链接。`
    );
    return false;
  }

  const maxSizeMb = Math.max(1, Number(config.maxVideoSizeMB) || 80);
  try {
    const downloaded = await service.downloadVideo(aweme, {
      maxBytes: maxSizeMb * 1024 * 1024,
    });
    try {
      await e.reply(segment.video(downloaded.path));
      scheduleCleanup(downloaded.path);
      return true;
    } catch (error) {
      scheduleCleanup(downloaded.path);
      throw error;
    }
  } catch (error) {
    if (error?.code === "DOUYIN_MEDIA_TOO_LARGE") {
      const actualSize = formatSize(error.size);
      await e.reply(
        `视频文件${actualSize ? `约 ${actualSize}，` : ""}超过 ${maxSizeMb} MB 的发送上限，已保留原链接。`
      );
      return false;
    }

    logger.error(`[Douyin] 视频下载或发送失败：${error.stack || error.message}`);
    await e.reply(`视频下载或发送失败，请打开原链接观看：\n${aweme.sourceUrl}`);
    return false;
  }
}

function friendlyParseError(error, e, config) {
  switch (error?.code) {
    case "DOUYIN_INVALID_URL":
    case "DOUYIN_INVALID_ID":
    case "DOUYIN_RESOLVE_FAILED":
      return "未识别到有效的抖音作品链接，请确认链接后重试。";
    case "DOUYIN_AWEME_UNAVAILABLE":
      return "该抖音作品可能已删除、设为私密或暂时不可访问。";
    case "DOUYIN_BLOCKED":
    case "DOUYIN_COOKIE_REQUIRED": {
      const hasCookie = Boolean(String(config.cookie || "").trim());
      if (e.isMaster) {
        return hasCookie
          ? "抖音拒绝了本次请求，Cookie 可能已失效。请在 WebUI 的“抖音解析”中更新 Cookie 后重试。"
          : "抖音要求访问验证。请在 WebUI 的“抖音解析”中填写浏览器登录后的 Cookie，或编辑 config/sakura-plugin/douyin.yaml。";
      }
      return "抖音要求访问验证，请联系机器人主人更新抖音 Cookie。";
    }
    case "DOUYIN_TIMEOUT":
      return "请求抖音超时，请稍后重试。";
    case "DOUYIN_UNSAFE_REDIRECT":
      return "抖音链接跳转异常，已停止解析。";
    default:
      return "抖音作品解析失败，可能是访问限制或页面结构发生变化，请稍后重试。";
  }
}

async function extractUrlFromEvent(e, isManual) {
  const candidates = [e.msg, e.raw_message, e.url, e.json, e.message];
  for (const candidate of candidates) {
    const url =
      typeof candidate === "string"
        ? extractDouyinUrlFromText(candidate)
        : extractDouyinUrlFromValue(candidate);
    if (url) return url;
  }

  if (!isManual || !e.reply_id) return "";
  try {
    const quoted = await e.getMsg(e.reply_id);
    return (
      extractDouyinUrlFromValue(quoted?.message) ||
      extractDouyinUrlFromText(quoted?.raw_message || quoted?.message || "")
    );
  } catch (error) {
    logger.warn(`[Douyin] 获取引用消息失败：${error.message}`);
    return "";
  }
}

export class douyin extends plugin {
  constructor() {
    super({
      name: "抖音作品解析",
      event: "message",
      priority: 1135,
    });
  }

  get appconfig() {
    return setting.getConfig("douyin") || {};
  }

  handleDouyinLink = OnEvent("message", async (e) => {
    const config = this.appconfig;
    if (config.enable === false) return false;

    const text = String(e.msg || "");
    const isManual = MANUAL_COMMAND_PATTERN.test(text);
    const mightContainLink =
      /(?:douyin\.com|iesdouyin\.com)/i.test(text) ||
      e.message?.some?.((item) => item?.type === "json");
    if (!isManual && !mightContainLink) return false;
    if (!isManual && config.autoResolve === false) return false;

    const url = await extractUrlFromEvent(e, isManual);
    if (!url) {
      if (isManual) {
        await e.reply("请在指令后附上抖音链接，或引用一条包含抖音链接的消息。", true);
        return true;
      }
      return false;
    }

    const requestKey = `${e.bot?.self_id || "bot"}:${e.group_id || `private-${e.user_id}`}:${url}`;
    if (activeRequests.has(requestKey)) return true;

    const targetKey = `${e.bot?.self_id || "bot"}:${e.group_id || `private-${e.user_id}`}`;
    const cooldownMs = Math.max(0, Number(config.cooldownSeconds) || 0) * 1000;
    const lastRequestAt = requestCooldowns.get(targetKey) || 0;
    const remainingMs = cooldownMs - (Date.now() - lastRequestAt);
    if (!e.isMaster && remainingMs > 0) {
      if (isManual) {
        await e.reply(`抖音解析冷却中，请 ${Math.ceil(remainingMs / 1000)} 秒后再试。`, true);
      }
      return true;
    }

    const startedAt = Date.now();
    requestCooldowns.set(targetKey, startedAt);
    if (requestCooldowns.size > 1000) {
      for (const [key, timestamp] of requestCooldowns) {
        if (startedAt - timestamp > Math.max(cooldownMs, 60_000)) requestCooldowns.delete(key);
      }
    }
    activeRequests.add(requestKey);

    try {
      try {
        await e.react?.(124);
      } catch {
      }

      const aweme = await service.getAwemeDetail(url, {
        cookie: config.cookie || "",
        browserFallback: config.browserFallback !== false,
      });
      await sendSummary(e, aweme);

      if (aweme.type === "note") {
        if (aweme.images.length === 0) {
          await e.reply(`未取得图文原图，请打开原链接查看：\n${aweme.sourceUrl}`);
        } else {
          await sendGallery(e, aweme, config);
        }
      } else if (aweme.streams.length === 0) {
        await e.reply(`未取得可下载的视频地址，请打开原链接观看：\n${aweme.sourceUrl}`);
      } else {
        await sendVideo(e, aweme, config);
      }
    } catch (error) {
      logger.error(`[Douyin] 解析失败：${error.stack || error.message}`);
      await e.reply(friendlyParseError(error, e, config), true);
    } finally {
      activeRequests.delete(requestKey);
    }
    return true;
  });
}
