import setting from "../lib/setting.js";
import {
  DouyinService,
  extractDouyinUrlFromText,
  extractDouyinUrlFromValue,
  formatDouyinCount,
} from "../lib/douyin/douyinService.js";
import { renderDouyinCommentCards } from "../lib/douyin/commentRenderer.js";

const service = new DouyinService();
const activeRequests = new Set();
const requestCooldowns = new Map();
const MANUAL_COMMAND_PATTERN = /^\s*[#＃]?\s*抖音解析(?:\s|$)/i;
const CLEANUP_DELAY_MS = 90_000;
const MAX_COMMENT_IMAGES_PER_NODE = 9;
const MAX_COMMENT_IMAGE_BYTES = 10 * 1024 * 1024;

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

async function sendDirectSummary(e, aweme, text) {
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

async function sendSummary(e, aweme, commentResult = {}) {
  const text = buildSummaryText(aweme);
  const content = [
    ...(aweme.cover ? [segment.image(aweme.cover)] : []),
    segment.text(text),
  ];
  const commentNodes = Array.isArray(commentResult.nodes) ? commentResult.nodes : [];

  try {
    await sendForwardWithCommentFallback(
      e,
      [buildForwardNode(e, aweme, content)],
      commentNodes,
      (visibleCommentCount) => ({
        source:
          visibleCommentCount > 0
            ? `抖音视频解析 · ${visibleCommentCount}条热评`
            : "抖音视频解析",
        prompt:
          visibleCommentCount > 0 ? "点击查看视频信息与热评" : "点击查看视频信息",
        news: [
          { text: `作者：${aweme.author?.nickname || "抖音用户"}` },
          { text: shortText(aweme.desc, 80) || "无文案" },
        ],
      }),
      "视频信息"
    );
  } catch (error) {
    logger.warn(`[Douyin] 视频信息转发失败，回退为普通消息：${error.message}`);
    await sendDirectSummary(e, aweme, text);
  }
}

async function sendForwardWithCommentFallback(
  e,
  contentNodes,
  commentNodes,
  buildOptions,
  label
) {
  const safeCommentNodes = Array.isArray(commentNodes) ? commentNodes : [];
  try {
    await e.sendForwardMsg(
      [...contentNodes, ...safeCommentNodes],
      buildOptions(safeCommentNodes.length)
    );
  } catch (error) {
    if (safeCommentNodes.length === 0) throw error;
    logger.warn(
      `[Douyin] ${label}与评论卡片合并转发失败，去掉评论卡片重试：${error.message}`
    );
    await e.sendForwardMsg(contentNodes, buildOptions(0));
  }
}

function buildForwardNode(e, aweme, content, nickname = "") {
  const botId = Number(e.bot?.self_id || e.self_id || e.user_id || 10000);
  return {
    user_id: Number.isFinite(botId) ? botId : 10000,
    nickname: nickname || aweme.author?.nickname || "抖音图文",
    content,
  };
}

function getCommentImageCandidates(comment) {
  const candidates = Array.isArray(comment?.imageCandidates)
    ? comment.imageCandidates
    : [];
  return candidates
    .map((item) =>
      (Array.isArray(item) ? item : item?.urls || []).filter(
        (url) => typeof url === "string" && url.length > 0
      )
    )
    .filter((urls) => urls.length > 0);
}

async function downloadCommentImageBuffers(comments) {
  const safeComments = (Array.isArray(comments) ? comments : []).slice(0, 10);
  const buffersByComment = safeComments.map(() => []);
  const jobs = [];

  safeComments.forEach((comment, commentIndex) => {
    const visibleComments = [
      comment,
      ...(Array.isArray(comment?.replies) ? comment.replies.slice(0, 3) : []),
    ];
    let imageIndex = 0;
    for (const visibleComment of visibleComments) {
      for (const urls of getCommentImageCandidates(visibleComment)) {
        if (imageIndex >= MAX_COMMENT_IMAGES_PER_NODE) break;
        jobs.push({
          commentIndex,
          imageIndex,
          urls,
          id: visibleComment?.id || `${commentIndex + 1}-${imageIndex + 1}`,
        });
        imageIndex += 1;
      }
      if (imageIndex >= MAX_COMMENT_IMAGES_PER_NODE) break;
    }
  });

  let cursor = 0;
  const worker = async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor];
      cursor += 1;
      try {
        buffersByComment[job.commentIndex][job.imageIndex] =
          await service.downloadImageBuffer(
            job.urls,
            `comment-${job.id}-image-${job.imageIndex + 1}`,
            { maxBytes: MAX_COMMENT_IMAGE_BYTES }
          );
      } catch (error) {
        logger.warn(
          `[Douyin] 评论 ${job.id} 的配图下载失败，已略过：${error.message}`
        );
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(4, Math.max(1, jobs.length)) }, () => worker())
  );
  return buffersByComment.map((buffers) => buffers.filter(Buffer.isBuffer));
}

async function buildCommentNodes(e, aweme, config) {
  if (config.commentsEnabled === false) return { nodes: [], count: 0, total: 0 };
  const limit = Math.min(10, Math.max(1, Number(config.maxComments) || 10));
  const replyLimit = Math.min(
    3,
    Math.max(0, Number(config.maxCommentReplies ?? 3))
  );

  try {
    const result = await service.getTopComments(aweme, {
      limit,
      replyLimit,
      cookie: config.cookie || "",
      browserFallback: config.browserFallback !== false,
    });
    if (result.comments.length === 0) {
      return { nodes: [], count: 0, total: result.total || 0 };
    }
    const comments = result.comments.slice(0, limit);
    const [cardBuffers, commentImageBuffers] = await Promise.all([
      renderDouyinCommentCards(comments, {
        loadImage: (urls, id, maxBytes) =>
          service.downloadImageDataUri(urls, id, { maxBytes }),
      }),
      downloadCommentImageBuffers(comments),
    ]);
    const nodes = cardBuffers.map((buffer, index) =>
      buildForwardNode(
        e,
        aweme,
        [
          segment.image(buffer),
          ...(commentImageBuffers[index] || []).map((imageBuffer) =>
            segment.image(imageBuffer)
          ),
        ],
        comments[index]?.author?.nickname || `热评 ${index + 1}`
      )
    );
    return { nodes, count: nodes.length, total: result.total || nodes.length };
  } catch (error) {
    logger.warn(`[Douyin] 评论获取或卡片渲染失败，继续发送作品：${error.message}`);
    return { nodes: [], count: 0, total: 0 };
  }
}

async function sendGallery(e, aweme, config, commentResultPromise) {
  const maxCount = Math.max(1, Number(config.maxGalleryImages) || 12);
  const [result, commentResult] = await Promise.all([
    service.downloadImages(aweme, {
      maxCount,
      concurrency: 3,
    }),
    commentResultPromise,
  ]);
  const commentNodes = Array.isArray(commentResult?.nodes) ? commentResult.nodes : [];
  const paths = result.files.map((item) => item.path);
  const summaryText = buildSummaryText(aweme);

  try {
    if (paths.length === 0) {
      const firstImage = aweme.images?.[0];
      const content = [
        ...(firstImage ? [segment.image(firstImage)] : []),
        segment.text(`${summaryText}\n\n图片下载失败，请打开原链接查看。`),
      ];
      await sendForwardWithCommentFallback(
        e,
        [buildForwardNode(e, aweme, content)],
        commentNodes,
        (visibleCommentCount) => ({
          source:
            visibleCommentCount > 0
              ? `抖音图文解析 · ${visibleCommentCount}条热评`
              : "抖音图文解析",
          prompt:
            visibleCommentCount > 0 ? "点击查看图文与热评" : "点击查看图文信息",
          news: [
            { text: `作者：${aweme.author?.nickname || "抖音用户"}` },
            { text: shortText(aweme.desc, 80) || "无文案" },
          ],
        }),
        "图文信息"
      );
      return false;
    }

    const deliveryNotes = [];
    if (aweme.images.length > paths.length || result.failures.length > 0) {
      deliveryNotes.push(
        `共识别 ${aweme.images.length} 张图片，成功载入 ${paths.length} 张${
          aweme.images.length > maxCount ? `（最多载入 ${maxCount} 张）` : ""
        }`
      );
    }
    if (result.watermarkedCount > 0) {
      deliveryNotes.push(
        `其中 ${result.watermarkedCount} 张未取得无水印原图，使用了平台下载版本`
      );
    }
    const deliveryNote =
      deliveryNotes.length > 0 ? `\n发送说明：${deliveryNotes.join("；")}。` : "";
    const imageNodes = paths.map((filePath, index) =>
      buildForwardNode(e, aweme, [
        segment.image(filePath),
        segment.text(
          index === 0
            ? `${summaryText}${deliveryNote}\n\n第 1/${paths.length} 张`
            : `第 ${index + 1}/${paths.length} 张`
        ),
      ])
    );
    await sendForwardWithCommentFallback(
      e,
      imageNodes,
      commentNodes,
      (visibleCommentCount) => ({
        source: `抖音图文（${paths.length}张${
          visibleCommentCount > 0 ? ` · ${visibleCommentCount}条热评` : ""
        }）`,
        prompt: visibleCommentCount > 0 ? "点击查看图文与热评" : "点击查看图文",
        news: [
          { text: `作者：${aweme.author?.nickname || "抖音用户"}` },
          { text: shortText(aweme.desc, 80) || "无文案" },
        ],
      }),
      "图文"
    );
    return true;
  } catch (error) {
    logger.warn(`[Douyin] 图文转发失败，回退首图：${error.message}`);
    try {
      await e.reply([
        ...(paths[0] ? [segment.image(paths[0])] : []),
        segment.text(`${summaryText}\n\n图文合并转发失败，已回退为普通消息。`),
      ]);
    } catch {
      await e.reply(`${summaryText}\n\n图文发送失败，请打开原链接查看。`);
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
      const commentResultPromise = buildCommentNodes(e, aweme, config);

      if (aweme.type === "note") {
        await sendGallery(e, aweme, config, commentResultPromise);
      } else {
        const commentResult = await commentResultPromise;
        await sendSummary(e, aweme, commentResult);
        if (aweme.streams.length === 0) {
          await e.reply(`未取得可下载的视频地址，请打开原链接观看：\n${aweme.sourceUrl}`);
        } else {
          await sendVideo(e, aweme, config);
        }
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
