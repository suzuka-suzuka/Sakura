import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { generateABogus } from "./aBogus.js";
import { plugindata } from "../path.js";

export const DOUYIN_WEB_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
export const DOUYIN_API_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 5.0; SM-G900P Build/LRX21T) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.25 Mobile Safari/537.36";

const DOUYIN_REFERER = "https://www.douyin.com/";
const DOUYIN_URL_PATTERN = /https?:\/\/[^\s<>"'`]+/giu;
const DIRECT_ID_PATTERN = /\/(?:video|note)\/(\d{15,22})(?:[/?#]|$)/i;
const SHARE_ID_PATTERN = /\/share\/(?:video|note)\/(\d{15,22})(?:[/?#]|$)/i;
const DEFAULT_TEMP_DIR = path.join(plugindata, "douyin_temp");
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_JSON_SEARCH_NODES = 50_000;
const COMMENT_CACHE_TTL_MS = 3 * 60 * 1000;

function createDouyinError(message, code, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function parseCookieHeader(value) {
  const cookies = new Map();
  for (const part of String(value || "").split(";")) {
    const item = part.trim();
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    const name = item.slice(0, separator).trim();
    const cookieValue = item.slice(separator + 1).trim();
    if (!name || !cookieValue || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) continue;
    cookies.set(name, cookieValue);
  }
  return cookies;
}

function serializeCookies(cookies) {
  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function stripUrlTail(value) {
  return normalizeText(value)
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&")
    .replace(/[，。！？、；：）》】」』”’]+$/gu, "")
    .replace(/[)\]}>.,!?;:'"]+$/gu, "");
}

function isDouyinHostname(hostname) {
  const host = normalizeText(hostname).toLowerCase().replace(/\.$/, "");
  return (
    host === "douyin.com" ||
    host.endsWith(".douyin.com") ||
    host === "iesdouyin.com" ||
    host.endsWith(".iesdouyin.com")
  );
}

export function normalizeDouyinUrl(value) {
  const input = stripUrlTail(value);
  if (!input) return "";

  try {
    const url = new URL(input);
    if (!/^https?:$/i.test(url.protocol) || !isDouyinHostname(url.hostname)) {
      return "";
    }
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function extractFromDecodedText(text) {
  const normalized = String(text || "").replace(/\\\//g, "/");
  for (const match of normalized.matchAll(DOUYIN_URL_PATTERN)) {
    const url = normalizeDouyinUrl(match[0]);
    if (url) return url;
  }
  return "";
}

export function extractDouyinUrlFromText(value) {
  const text = String(value ?? "");
  if (!text) return "";

  const direct = extractFromDecodedText(text);
  if (direct) return direct;

  if (/%(?:25)?3a|%(?:25)?2f/i.test(text)) {
    try {
      const decoded = decodeURIComponent(text);
      if (decoded !== text) return extractFromDecodedText(decoded);
    } catch {
    }
  }
  return "";
}

export function extractDouyinUrlFromValue(value, options = {}) {
  const maxDepth = Math.max(1, Number(options.maxDepth) || 8);
  const seen = new WeakSet();

  const visit = (current, depth) => {
    if (depth > maxDepth || current == null) return "";

    if (typeof current === "string") {
      const found = extractDouyinUrlFromText(current);
      if (found) return found;

      const trimmed = current.trim();
      if (
        trimmed.length <= 500_000 &&
        ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
          (trimmed.startsWith("[") && trimmed.endsWith("]")))
      ) {
        try {
          return visit(JSON.parse(trimmed), depth + 1);
        } catch {
        }
      }
      return "";
    }

    if (typeof current !== "object") return "";
    if (seen.has(current)) return "";
    seen.add(current);

    if (Array.isArray(current)) {
      for (const item of current) {
        const found = visit(item, depth + 1);
        if (found) return found;
      }
      return "";
    }

    for (const item of Object.values(current)) {
      const found = visit(item, depth + 1);
      if (found) return found;
    }
    return "";
  };

  return visit(value, 0);
}

export function extractAwemeId(value) {
  const input = normalizeText(value);
  if (!input) return "";

  const pathMatch = input.match(DIRECT_ID_PATTERN) || input.match(SHARE_ID_PATTERN);
  if (pathMatch) return pathMatch[1];

  try {
    const url = new URL(input);
    for (const key of ["aweme_id", "item_ids", "modal_id", "vid"]) {
      const candidate = normalizeText(url.searchParams.get(key));
      if (/^\d{15,22}$/.test(candidate)) return candidate;
    }
  } catch {
  }

  return "";
}

function buildDetailQuery(awemeId) {
  return new URLSearchParams({
    device_platform: "webapp",
    aid: "6383",
    channel: "channel_pc_web",
    aweme_id: String(awemeId),
    pc_client_type: "1",
    version_code: "190500",
    version_name: "19.5.0",
    cookie_enabled: "true",
    screen_width: "1344",
    screen_height: "756",
    browser_language: "zh-CN",
    browser_platform: "Win32",
    browser_name: "Firefox",
    browser_version: "118.0",
    browser_online: "true",
    engine_name: "Gecko",
    engine_version: "109.0",
    os_name: "Windows",
    os_version: "10",
    cpu_core_num: "16",
    device_memory: "",
    platform: "PC",
  });
}

export function buildAwemeDetailUrl(awemeId, signer = generateABogus) {
  if (!/^\d{15,22}$/.test(String(awemeId || ""))) {
    throw createDouyinError("无效的抖音作品 ID", "DOUYIN_INVALID_ID");
  }

  const query = buildDetailQuery(awemeId);
  const signature = signer(query.toString(), DOUYIN_API_USER_AGENT);
  query.set("a_bogus", signature);
  return `https://www.douyin.com/aweme/v1/web/aweme/detail/?${query.toString()}`;
}

function addCookieTokens(query, cookie) {
  const cookies = parseCookieHeader(cookie);
  const msToken = cookies.get("msToken");
  const verifyFp = cookies.get("s_v_web_id") || cookies.get("verifyFp");
  if (msToken) query.set("msToken", msToken);
  if (verifyFp) {
    query.set("verifyFp", verifyFp);
    query.set("fp", verifyFp);
  }
}

function buildCommentQuery(parameters, cookie = "") {
  const query = new URLSearchParams({
    device_platform: "webapp",
    aid: "6383",
    channel: "channel_pc_web",
    ...parameters,
    item_type: "0",
    cut_version: "1",
    pc_client_type: "1",
    version_code: "190500",
    version_name: "19.5.0",
    cookie_enabled: "true",
    screen_width: "1344",
    screen_height: "756",
    browser_language: "zh-CN",
    browser_platform: "Win32",
    browser_name: "Firefox",
    browser_version: "118.0",
    browser_online: "true",
    engine_name: "Gecko",
    engine_version: "109.0",
    os_name: "Windows",
    os_version: "10",
    cpu_core_num: "16",
    device_memory: "",
    platform: "PC",
  });
  addCookieTokens(query, cookie);
  return query;
}

function signCommentUrl(pathname, query, signer = generateABogus) {
  query.set("a_bogus", signer(query.toString(), DOUYIN_API_USER_AGENT));
  return `https://www.douyin.com${pathname}?${query.toString()}`;
}

export function buildCommentListUrl(
  awemeId,
  { cursor = 0, count = 10, cookie = "" } = {},
  signer = generateABogus
) {
  if (!/^\d{15,22}$/.test(String(awemeId || ""))) {
    throw createDouyinError("无效的抖音作品 ID", "DOUYIN_INVALID_ID");
  }
  const query = buildCommentQuery(
    {
      aweme_id: String(awemeId),
      cursor: String(Math.max(0, Math.floor(Number(cursor) || 0))),
      count: String(Math.min(20, Math.max(1, Math.floor(Number(count) || 10)))),
      insert_ids: "",
      whale_cut_token: "",
    },
    cookie
  );
  return signCommentUrl("/aweme/v1/web/comment/list/", query, signer);
}

export function buildCommentReplyUrl(
  awemeId,
  commentId,
  { cursor = 0, count = 3, cookie = "" } = {},
  signer = generateABogus
) {
  if (!/^\d{15,22}$/.test(String(awemeId || ""))) {
    throw createDouyinError("无效的抖音作品 ID", "DOUYIN_INVALID_ID");
  }
  if (!/^\d{10,30}$/.test(String(commentId || ""))) {
    throw createDouyinError("无效的抖音评论 ID", "DOUYIN_INVALID_COMMENT_ID");
  }
  const query = buildCommentQuery(
    {
      item_id: String(awemeId),
      comment_id: String(commentId),
      cursor: String(Math.max(0, Math.floor(Number(cursor) || 0))),
      count: String(Math.min(20, Math.max(1, Math.floor(Number(count) || 3)))),
    },
    cookie
  );
  return signCommentUrl("/aweme/v1/web/comment/list/reply/", query, signer);
}

function isPrivateIpv4(hostname) {
  const parts = String(hostname || "").split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false;
  const numbers = parts.map(Number);
  if (numbers.some((part) => part < 0 || part > 255)) return false;
  const [a, b] = numbers;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function normalizeMediaUrl(value) {
  let input = normalizeText(value).replace(/\\u002f/gi, "/").replace(/\\\//g, "/");
  if (!input) return "";
  if (input.startsWith("//")) input = `https:${input}`;

  try {
    const url = new URL(input);
    if (!/^https?:$/i.test(url.protocol) || url.username || url.password) return "";
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname === "::1" ||
      hostname === "::" ||
      isPrivateIpv4(hostname)
    ) {
      return "";
    }
    return url.toString().replace(/\/playwm(?=[/?])/i, "/play");
  } catch {
    return "";
  }
}

function collectUrls(value, output = []) {
  if (!value) return output;
  if (typeof value === "string") {
    const url = normalizeMediaUrl(value);
    if (url && !output.includes(url)) output.push(url);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, output);
    return output;
  }
  if (typeof value !== "object") return output;

  for (const key of ["url_list", "urlList", "download_url_list", "url", "src", "uri"]) {
    if (value[key] != null) collectUrls(value[key], output);
  }
  return output;
}

function pickFirstUrl(...values) {
  for (const value of values) {
    const urls = collectUrls(value, []);
    if (urls.length > 0) return urls[0];
  }
  return "";
}

function normalizeNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return Math.floor(number);
  }
  return 0;
}

function normalizeDuration(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  // 抖音作品详情里的 video.duration 以毫秒为单位；只有页面元数据回退
  // 才可能给出秒数，而这类值通常不会超过 1000。
  if (number <= 1000) return Math.round(number);
  if (number <= 4 * 3600 * 1000) return Math.max(1, Math.round(number / 1000));
  return Math.max(1, Math.round(number / 1_000_000));
}

function normalizeTimestamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "";
  const timestamp = number < 1e12 ? number * 1000 : number;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function collectImageUrls(...values) {
  const urls = [];
  for (const value of values) collectUrls(value, urls);
  return urls;
}

function normalizeImageCandidates(detail) {
  const pools = [
    detail?.image_post_info?.images,
    detail?.imagePostInfo?.images,
    detail?.image_list,
    detail?.imageList,
    detail?.images,
  ];
  const result = [];
  const usedPrimaryUrls = new Set();

  for (const pool of pools) {
    if (!Array.isArray(pool)) continue;
    for (const item of pool) {
      const cleanUrls = collectImageUrls(
        item?.origin_image,
        item?.originImage,
        item?.display_image,
        item?.displayImage,
        item?.url_list,
        item?.urlList,
        item?.image_url,
        item?.imageUrl,
        typeof item === "string" ? item : null
      );
      const watermarkUrls = collectImageUrls(
        item?.download_url_list,
        item?.downloadUrlList,
        item?.download_addr,
        item?.downloadAddr,
        item?.owner_watermark_image,
        item?.ownerWatermarkImage,
        item?.user_watermark_image,
        item?.userWatermarkImage
      ).filter((url) => !cleanUrls.includes(url));
      const primaryUrl = cleanUrls[0] || watermarkUrls[0] || "";
      if (!primaryUrl || usedPrimaryUrls.has(primaryUrl)) continue;
      usedPrimaryUrls.add(primaryUrl);
      result.push({
        cleanUrls: cleanUrls.slice(0, 8),
        watermarkUrls: watermarkUrls.slice(0, 4),
      });
    }
  }
  return result;
}

function truncateCommentText(value, maxLength = 600) {
  const text = normalizeText(value).replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function normalizeCommentImageCandidates(comment) {
  const pools = [
    comment?.image_list,
    comment?.imageList,
    comment?.images,
    comment?.comment_image_list,
    comment?.commentImageList,
  ];
  const result = [];
  const usedPrimaryUrls = new Set();

  for (const pool of pools) {
    const items = Array.isArray(pool) ? pool : pool ? [pool] : [];
    for (const item of items) {
      const urls = collectImageUrls(
        item?.origin_url,
        item?.originUrl,
        item?.large_url,
        item?.largeUrl,
        item?.download_url,
        item?.downloadUrl,
        item?.crop_url,
        item?.cropUrl,
        item?.medium_url,
        item?.mediumUrl,
        item?.thumb_url,
        item?.thumbUrl,
        item?.image_url,
        item?.imageUrl,
        item?.url_list,
        item?.urlList,
        item?.url,
        typeof item === "string" ? item : null
      ).slice(0, 8);
      const primaryUrl = urls[0];
      if (!primaryUrl || usedPrimaryUrls.has(primaryUrl)) continue;
      usedPrimaryUrls.add(primaryUrl);
      result.push(urls);
      if (result.length >= 9) return result;
    }
  }

  const sticker = comment?.sticker;
  const stickerUrls = collectImageUrls(
    sticker?.static_url,
    sticker?.staticUrl,
    sticker?.animate_url,
    sticker?.animateUrl,
    sticker?.sticker_url,
    sticker?.stickerUrl,
    sticker?.origin_url,
    sticker?.originUrl,
    sticker?.image_url,
    sticker?.imageUrl,
    sticker?.url_list,
    sticker?.urlList,
    sticker?.url,
    typeof sticker === "string" ? sticker : null
  ).slice(0, 8);
  if (stickerUrls[0] && !usedPrimaryUrls.has(stickerUrls[0])) {
    result.push(stickerUrls);
  }
  return result.slice(0, 9);
}

export function normalizeDouyinComment(
  comment,
  { creatorIds = [], isReply = false } = {}
) {
  const user = comment?.user && typeof comment.user === "object" ? comment.user : {};
  const userIds = [user?.uid, user?.sec_uid, user?.secUid]
    .map((value) => normalizeText(value))
    .filter(Boolean);
  const creatorSet = new Set(
    (Array.isArray(creatorIds) ? creatorIds : [creatorIds])
      .map((value) => normalizeText(value))
      .filter(Boolean)
  );
  const avatarUrls = collectImageUrls(
    user?.avatar_medium,
    user?.avatarMedium,
    user?.avatar_thumb,
    user?.avatarThumb,
    user?.avatar_larger,
    user?.avatarLarger,
    user?.avatar
  ).slice(0, 6);
  const imageCandidates = normalizeCommentImageCandidates(comment);

  return {
    id: normalizeText(comment?.cid ?? comment?.comment_id ?? comment?.commentId),
    text: truncateCommentText(comment?.text),
    likes: normalizeNumber(comment?.digg_count, comment?.diggCount),
    createdAt: normalizeTimestamp(comment?.create_time ?? comment?.createTime),
    ipLabel: normalizeText(comment?.ip_label ?? comment?.ipLabel),
    replyCount: normalizeNumber(
      comment?.reply_comment_total,
      comment?.replyCommentTotal
    ),
    replyTo: normalizeText(
      comment?.reply_to_user?.nickname ??
        comment?.replyToUser?.nickname ??
        comment?.reply_to_nickname
    ),
    isReply,
    isPinned: normalizeNumber(comment?.stick_position, comment?.stickPosition) > 0,
    author: {
      id: userIds[0] || "",
      nickname:
        normalizeText(user?.nickname ?? user?.unique_id ?? user?.uniqueId) ||
        "抖音用户",
      uniqueId: normalizeText(user?.unique_id ?? user?.uniqueId),
      avatarUrls,
      isCreator: userIds.some((id) => creatorSet.has(id)),
    },
    imageCandidates,
    hasImage: imageCandidates.length > 0 || Boolean(comment?.sticker),
    replies: [],
  };
}

function detectCodec(value, fallback = "unknown") {
  const text = normalizeText(value).toLowerCase();
  if (/h[._-]?265|hevc/.test(text)) return "h265";
  if (/h[._-]?264|avc/.test(text)) return "h264";
  return fallback;
}

function normalizeVideoStreams(video = {}) {
  const candidates = [];

  const push = (address, metadata = {}) => {
    const urls = collectUrls(address, []);
    if (urls.length === 0) return;
    candidates.push({
      urls,
      codec: metadata.codec || "unknown",
      width: normalizeNumber(metadata.width, video.width),
      height: normalizeNumber(metadata.height, video.height),
      bitRate: normalizeNumber(metadata.bitRate),
      dataSize: normalizeNumber(
        metadata.dataSize,
        address?.data_size,
        address?.dataSize
      ),
      quality: normalizeText(metadata.quality),
    });
  };

  push(video.play_addr_h264, { codec: "h264", quality: "原画" });

  for (const item of Array.isArray(video.bit_rate) ? video.bit_rate : []) {
    const codec = item?.is_h265
      ? "h265"
      : detectCodec(item?.codec_type ?? item?.codecType ?? item?.gear_name, "h264");
    push(item?.play_addr ?? item?.playAddr, {
      codec,
      width: item?.play_addr?.width ?? item?.width,
      height: item?.play_addr?.height ?? item?.height,
      bitRate: item?.bit_rate ?? item?.bitRate,
      dataSize: item?.play_addr?.data_size ?? item?.data_size,
      quality: item?.gear_name ?? item?.quality_type ?? item?.qualityType,
    });
  }

  push(video.play_addr, { codec: "unknown", quality: "默认" });
  push(video.play_addr_265, { codec: "h265", quality: "H.265" });

  const codecRank = { h264: 0, unknown: 1, h265: 2 };
  candidates.sort((left, right) => {
    const codecDiff = (codecRank[left.codec] ?? 1) - (codecRank[right.codec] ?? 1);
    if (codecDiff !== 0) return codecDiff;
    const leftPixels = left.width * left.height;
    const rightPixels = right.width * right.height;
    if (leftPixels !== rightPixels) return rightPixels - leftPixels;
    return right.bitRate - left.bitRate;
  });

  const usedUrls = new Set();
  const streams = [];
  for (const candidate of candidates) {
    const urls = candidate.urls.filter((url) => {
      if (usedUrls.has(url)) return false;
      usedUrls.add(url);
      return true;
    });
    if (urls.length > 0) streams.push({ ...candidate, urls });
  }
  // 一个作品通常只有 2～6 档码率。限制候选数，避免异常响应导致大量串行下载。
  return streams.slice(0, 8);
}

export function normalizeDouyinAweme(candidate, { sourceUrl = "", awemeId = "" } = {}) {
  const detail =
    candidate?.aweme_detail ??
    candidate?.awemeDetail ??
    candidate?.item_list?.[0] ??
    candidate?.itemList?.[0] ??
    candidate ??
    {};
  const video = detail?.video && typeof detail.video === "object" ? detail.video : {};
  const imageCandidates = normalizeImageCandidates(detail);
  const images = imageCandidates.map(
    (candidate) => candidate.cleanUrls[0] || candidate.watermarkUrls[0]
  );
  const streams = normalizeVideoStreams(video);
  const rawType = Number(detail?.aweme_type ?? detail?.awemeType);
  const isNote =
    Boolean(detail?.image_post_info || detail?.imagePostInfo) ||
    [68, 150].includes(rawType) ||
    (images.length > 0 && streams.length === 0);
  const author = detail?.author && typeof detail.author === "object" ? detail.author : {};
  const stats = detail?.statistics ?? detail?.stats ?? {};
  const id = normalizeText(
    detail?.aweme_id ?? detail?.awemeId ?? detail?.item_id ?? detail?.itemId ?? awemeId
  );
  const canonicalSourceUrl = id
    ? `https://www.douyin.com/${isNote ? "note" : "video"}/${id}`
    : normalizeDouyinUrl(sourceUrl) || sourceUrl;

  return {
    id,
    type: isNote ? "note" : "video",
    desc: normalizeText(detail?.desc ?? detail?.description ?? detail?.title),
    sourceUrl: canonicalSourceUrl,
    publishedAt: normalizeTimestamp(
      detail?.create_time ?? detail?.createTime ?? detail?.create_at
    ),
    author: {
      id: normalizeText(author?.uid ?? author?.sec_uid ?? author?.secUid),
      secUid: normalizeText(author?.sec_uid ?? author?.secUid),
      uniqueId: normalizeText(author?.unique_id ?? author?.uniqueId),
      nickname:
        normalizeText(author?.nickname ?? author?.unique_id ?? author?.uniqueId) ||
        "抖音用户",
      avatar: pickFirstUrl(
        author?.avatar_thumb,
        author?.avatar_medium,
        author?.avatar_larger,
        author?.avatar
      ),
    },
    stats: {
      play: normalizeNumber(stats?.play_count, stats?.playCount),
      like: normalizeNumber(stats?.digg_count, stats?.diggCount, stats?.like_count),
      comment: normalizeNumber(stats?.comment_count, stats?.commentCount),
      collect: normalizeNumber(stats?.collect_count, stats?.collectCount),
      share: normalizeNumber(stats?.share_count, stats?.shareCount),
    },
    cover:
      pickFirstUrl(video?.cover, video?.origin_cover, video?.dynamic_cover) ||
      images[0] ||
      "",
    duration: normalizeDuration(video?.duration ?? detail?.duration),
    images,
    imageCandidates,
    streams,
  };
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function parseJsonCandidate(value) {
  const input = decodeHtmlEntities(value).trim();
  if (!input) return null;
  const variants = [input];
  try {
    const decoded = decodeURIComponent(input);
    if (decoded !== input) variants.push(decoded);
  } catch {
  }

  for (const variant of variants) {
    try {
      return JSON.parse(variant);
    } catch {
    }
  }
  return null;
}

function findAwemeCandidate(root, awemeId = "") {
  if (!root || typeof root !== "object") return null;
  const queue = [root];
  const seen = new WeakSet();
  let fallback = null;
  let visited = 0;

  while (queue.length > 0 && visited < MAX_JSON_SEARCH_NODES) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    visited += 1;

    if (!Array.isArray(current)) {
      const id = normalizeText(
        current.aweme_id ?? current.awemeId ?? current.item_id ?? current.itemId
      );
      const looksLikeAweme = Boolean(
        current.video || current.image_post_info || current.images || current.statistics
      );
      if (id && id === awemeId) return current;
      if (!fallback && looksLikeAweme && (id || current.desc)) fallback = current;
    }

    for (const value of Array.isArray(current) ? current : Object.values(current)) {
      if (value && typeof value === "object") queue.push(value);
    }
  }
  return fallback;
}

function extractMetaContent(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`,
      "i"
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`,
      "i"
    ),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtmlEntities(match[1]);
  }
  return "";
}

function extractAwemeFromHtml(html, awemeId, sourceUrl) {
  const scriptPatterns = [
    /<script[^>]+id=["']RENDER_DATA["'][^>]*>([\s\S]*?)<\/script>/gi,
    /<script[^>]+id=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/gi,
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  ];

  for (const pattern of scriptPatterns) {
    for (const match of html.matchAll(pattern)) {
      const root = parseJsonCandidate(match[1]);
      const candidate = findAwemeCandidate(root, awemeId);
      if (candidate) return candidate;
    }
  }

  const desc =
    extractMetaContent(html, "og:description") ||
    extractMetaContent(html, "description") ||
    extractMetaContent(html, "og:title");
  const cover = extractMetaContent(html, "og:image");
  const videoUrl =
    extractMetaContent(html, "og:video:url") || extractMetaContent(html, "og:video");
  if (!desc && !cover && !videoUrl) return null;

  return {
    aweme_id: awemeId,
    desc,
    video: videoUrl
      ? {
          play_addr: { url_list: [videoUrl] },
          cover: { url_list: cover ? [cover] : [] },
        }
      : undefined,
    images: !videoUrl && cover ? [{ url_list: [cover] }] : undefined,
    share_url: sourceUrl,
  };
}

function contentTypeExtension(contentType, fallback = ".jpg") {
  const type = normalizeText(contentType).toLowerCase().split(";", 1)[0];
  const extensions = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/avif": ".avif",
    "image/heic": ".heic",
  };
  return extensions[type] || fallback;
}

function validateMp4(filePath) {
  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(64);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(Buffer.from("ftyp"));
  } finally {
    fs.closeSync(descriptor);
  }
}

function validateImage(filePath, contentType) {
  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(16);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead);
    const isJpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    const isPng = head.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
    const isGif = head.subarray(0, 3).toString("ascii") === "GIF";
    const isWebp =
      head.subarray(0, 4).toString("ascii") === "RIFF" &&
      head.subarray(8, 12).toString("ascii") === "WEBP";
    const isIsoImage =
      head.subarray(4, 8).toString("ascii") === "ftyp" &&
      /^(?:avif|avis|heic|heix|mif1)$/i.test(head.subarray(8, 12).toString("ascii"));
    return (
      isJpeg ||
      isPng ||
      isGif ||
      isWebp ||
      isIsoImage ||
      normalizeText(contentType).toLowerCase().startsWith("image/")
    );
  } finally {
    fs.closeSync(descriptor);
  }
}

export function formatDouyinCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "0";
  if (number >= 1e8) return `${(number / 1e8).toFixed(number >= 1e9 ? 0 : 1)}亿`;
  if (number >= 1e4) return `${(number / 1e4).toFixed(number >= 1e5 ? 0 : 1)}万`;
  return String(Math.floor(number));
}

export class DouyinService {
  constructor({
    fetchImpl = globalThis.fetch,
    tempDir = DEFAULT_TEMP_DIR,
    log = null,
    browserCookieProvider = null,
  } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new TypeError("DouyinService 需要可用的 fetch 实现");
    }
    this.fetch = fetchImpl;
    this.tempDir = path.resolve(tempDir);
    this.logger = log;
    this.browserCookieProvider = browserCookieProvider;
    this.browserCookieCache = null;
    this.browserCookiePromise = null;
    this.commentCache = new Map();
  }

  log(level, ...args) {
    const target = this.logger || globalThis.logger;
    target?.[level]?.(...args);
  }

  buildHeaders(cookie = "", extra = {}) {
    const headers = {
      accept: "application/json, text/plain, */*",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      referer: DOUYIN_REFERER,
      "user-agent": DOUYIN_WEB_USER_AGENT,
      ...extra,
    };
    const cookieHeader = normalizeText(cookie);
    if (cookieHeader) headers.cookie = cookieHeader;
    return headers;
  }

  getCachedBrowserCookie(sourceCookie = "") {
    const source = normalizeText(sourceCookie);
    const cache = this.browserCookieCache;
    if (
      cache &&
      cache.sourceCookie === source &&
      cache.expiresAt > Date.now() &&
      cache.cookieHeader
    ) {
      return cache.cookieHeader;
    }
    return source;
  }

  async collectBrowserCookies(sourceCookie = "") {
    if (typeof this.browserCookieProvider === "function") {
      return normalizeText(await this.browserCookieProvider(sourceCookie));
    }

    const puppeteerModule = await import("puppeteer");
    const puppeteer = puppeteerModule.default || puppeteerModule;
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-background-networking",
      ],
    });

    try {
      const page = await browser.newPage();
      await page.setUserAgent(DOUYIN_API_USER_AGENT);
      await page.setViewport({ width: 412, height: 915, isMobile: true });
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        const resourceType = request.resourceType();
        const action = ["media", "image", "font"].includes(resourceType)
          ? request.abort()
          : request.continue();
        void action.catch(() => {});
      });

      const configuredCookies = parseCookieHeader(sourceCookie);
      if (configuredCookies.size > 0) {
        await page.setCookie(
          ...[...configuredCookies.entries()].map(([name, value]) => ({
            name,
            value,
            url: DOUYIN_REFERER,
          }))
        );
      }

      await page.goto(DOUYIN_REFERER, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 2_500));

      const collected = new Map(configuredCookies);
      for (const cookie of await page.cookies(DOUYIN_REFERER)) {
        if (cookie?.name && cookie?.value) collected.set(cookie.name, cookie.value);
      }
      return serializeCookies(collected);
    } finally {
      await browser.close().catch(() => {});
    }
  }

  async refreshBrowserCookies(sourceCookie = "", { force = false } = {}) {
    const source = normalizeText(sourceCookie);
    if (!force) {
      const cache = this.browserCookieCache;
      if (
        cache &&
        cache.sourceCookie === source &&
        cache.expiresAt > Date.now() &&
        cache.cookieHeader
      ) {
        return cache.cookieHeader;
      }
    }

    if (!this.browserCookiePromise) {
      this.browserCookiePromise = this.collectBrowserCookies(source)
        .then((cookieHeader) => {
          if (!cookieHeader) {
            throw createDouyinError(
              "浏览器未取得抖音 Cookie",
              "DOUYIN_BROWSER_COOKIE_FAILED"
            );
          }
          this.browserCookieCache = {
            sourceCookie: source,
            cookieHeader,
            expiresAt: Date.now() + 30 * 60 * 1000,
          };
          return cookieHeader;
        })
        .finally(() => {
          this.browserCookiePromise = null;
        });
    }
    return this.browserCookiePromise;
  }

  async requestText(url, options = {}, timeoutMs = 30_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetch(url, { ...options, signal: controller.signal });
      const text = await response.text();
      return { response, text };
    } catch (error) {
      if (error?.name === "AbortError") {
        throw createDouyinError("请求抖音超时", "DOUYIN_TIMEOUT", { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async resolveShareUrl(rawUrl) {
    const initialUrl = normalizeDouyinUrl(rawUrl);
    if (!initialUrl) {
      throw createDouyinError("未识别到有效的抖音链接", "DOUYIN_INVALID_URL");
    }

    const directId = extractAwemeId(initialUrl);
    const initialHost = new URL(initialUrl).hostname.toLowerCase();
    if (directId && initialHost !== "v.douyin.com") {
      return { url: initialUrl, awemeId: directId, html: "" };
    }

    let currentUrl = initialUrl;
    for (let redirectCount = 0; redirectCount <= 6; redirectCount += 1) {
      const { response, text } = await this.requestText(
        currentUrl,
        {
          method: "GET",
          redirect: "manual",
          headers: this.buildHeaders("", {
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          }),
        },
        30_000
      );

      if (REDIRECT_STATUS.has(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          throw createDouyinError("抖音短链接缺少跳转地址", "DOUYIN_RESOLVE_FAILED");
        }
        const nextUrl = normalizeDouyinUrl(new URL(location, currentUrl).toString());
        if (!nextUrl) {
          throw createDouyinError("抖音短链接跳转到了非抖音地址", "DOUYIN_UNSAFE_REDIRECT");
        }
        currentUrl = nextUrl;
        continue;
      }

      if (!response.ok) {
        throw createDouyinError(
          `抖音短链接展开失败：HTTP ${response.status}`,
          "DOUYIN_RESOLVE_FAILED",
          { status: response.status }
        );
      }

      const finalUrl = normalizeDouyinUrl(response.url) || currentUrl;
      const awemeId =
        extractAwemeId(finalUrl) ||
        extractAwemeId(text.match(/\/(?:video|note)\/\d{15,22}/i)?.[0] || "");
      if (!awemeId) {
        throw createDouyinError("未能从抖音链接中提取作品 ID", "DOUYIN_INVALID_ID");
      }
      return { url: finalUrl, awemeId, html: text };
    }

    throw createDouyinError("抖音短链接跳转次数过多", "DOUYIN_RESOLVE_FAILED");
  }

  async fetchDetailApi(awemeId, cookie) {
    const url = buildAwemeDetailUrl(awemeId);
    const { response, text } = await this.requestText(
      url,
      {
        headers: this.buildHeaders(cookie, {
          "user-agent": DOUYIN_API_USER_AGENT,
        }),
        redirect: "error",
      },
      30_000
    );

    if ([403, 412, 418, 429].includes(response.status)) {
      throw createDouyinError("抖音触发了访问验证", "DOUYIN_BLOCKED", {
        status: response.status,
      });
    }
    if (!response.ok) {
      throw createDouyinError(
        `抖音详情接口返回 HTTP ${response.status}`,
        "DOUYIN_API_FAILED",
        { status: response.status }
      );
    }

    const data = parseJsonCandidate(text);
    if (!data) {
      throw createDouyinError("抖音详情接口未返回 JSON", "DOUYIN_BAD_JSON");
    }
    const detail = data?.aweme_detail ?? data?.awemeDetail;
    if (!detail) {
      const message = normalizeText(data?.status_msg ?? data?.message);
      if (/删除|私密|不存在|not found/i.test(message)) {
        throw createDouyinError(message || "作品不可访问", "DOUYIN_AWEME_UNAVAILABLE");
      }
      throw createDouyinError(
        message || "抖音详情为空，可能需要更新 Cookie",
        "DOUYIN_COOKIE_REQUIRED"
      );
    }
    return detail;
  }

  async fetchLegacyDetailApi(awemeId, cookie) {
    const url = `https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${encodeURIComponent(
      awemeId
    )}`;
    const { response, text } = await this.requestText(
      url,
      {
        headers: this.buildHeaders(cookie),
        redirect: "error",
      },
      30_000
    );
    if (!response.ok) return null;
    const data = parseJsonCandidate(text);
    return data?.item_list?.[0] ?? data?.itemList?.[0] ?? null;
  }

  async fetchPageDetail(url, awemeId, cookie, knownHtml = "") {
    let html = knownHtml;
    let finalUrl = url;
    if (!html) {
      const result = await this.requestText(
        url,
        {
          headers: this.buildHeaders(cookie, {
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          }),
          redirect: "follow",
        },
        30_000
      );
      if (!result.response.ok) return null;
      const validatedFinalUrl = normalizeDouyinUrl(result.response.url || url);
      if (!validatedFinalUrl) {
        throw createDouyinError("作品页面跳转到了非抖音地址", "DOUYIN_UNSAFE_REDIRECT");
      }
      finalUrl = validatedFinalUrl;
      html = result.text;
    }
    return {
      candidate: extractAwemeFromHtml(html, awemeId, finalUrl),
      finalUrl,
    };
  }

  async getAwemeDetail(rawUrl, { cookie = "", browserFallback = true } = {}) {
    const resolved = await this.resolveShareUrl(rawUrl);
    const awemeId = resolved.awemeId || extractAwemeId(resolved.url);
    if (!awemeId) {
      throw createDouyinError("未能从抖音链接中提取作品 ID", "DOUYIN_INVALID_ID");
    }

    const failures = [];
    let candidate = null;
    let effectiveCookie = this.getCachedBrowserCookie(cookie);
    try {
      candidate = await this.fetchDetailApi(awemeId, effectiveCookie);
    } catch (error) {
      failures.push(error);
      const shouldUseBrowser = [
        "DOUYIN_BLOCKED",
        "DOUYIN_COOKIE_REQUIRED",
        "DOUYIN_BAD_JSON",
      ].includes(error?.code);
      if (browserFallback && shouldUseBrowser) {
        try {
          this.log("info", "[Douyin] 普通请求受限，启动浏览器刷新匿名访问 Cookie");
          effectiveCookie = await this.refreshBrowserCookies(cookie, { force: true });
          candidate = await this.fetchDetailApi(awemeId, effectiveCookie);
        } catch (browserError) {
          failures.push(browserError);
          this.log(
            "warn",
            `[Douyin] 浏览器 Cookie 回退失败，继续尝试旧接口：${browserError.message}`
          );
        }
      } else {
        this.log("warn", `[Douyin] 签名详情接口失败，尝试旧接口：${error.message}`);
      }
    }

    if (!candidate) {
      try {
        candidate = await this.fetchLegacyDetailApi(awemeId, effectiveCookie);
      } catch (error) {
        failures.push(error);
        this.log("warn", `[Douyin] 旧详情接口失败，尝试页面数据：${error.message}`);
      }
    }

    let sourceUrl = resolved.url;
    if (!candidate) {
      try {
        const page = await this.fetchPageDetail(
          resolved.url,
          awemeId,
          effectiveCookie,
          resolved.html
        );
        candidate = page?.candidate || null;
        sourceUrl = page?.finalUrl || sourceUrl;
      } catch (error) {
        failures.push(error);
      }
    }

    if (!candidate) {
      const preferred =
        failures.find((error) => error?.code === "DOUYIN_AWEME_UNAVAILABLE") ||
        failures.find((error) => error?.code === "DOUYIN_BLOCKED") ||
        failures.find((error) => error?.code === "DOUYIN_COOKIE_REQUIRED") ||
        failures.at(-1);
      if (preferred) throw preferred;
      throw createDouyinError("未能解析抖音作品详情", "DOUYIN_PARSE_FAILED");
    }

    const aweme = normalizeDouyinAweme(candidate, { sourceUrl, awemeId });
    if (!aweme.id) aweme.id = awemeId;
    return aweme;
  }

  async requestCommentJson(url, cookie, referer) {
    const { response, text } = await this.requestText(
      url,
      {
        headers: this.buildHeaders(cookie, {
          referer: referer || DOUYIN_REFERER,
          "user-agent": DOUYIN_API_USER_AGENT,
        }),
        redirect: "error",
      },
      30_000
    );

    if ([403, 412, 418, 429].includes(response.status)) {
      throw createDouyinError("抖音评论接口触发了访问验证", "DOUYIN_BLOCKED", {
        status: response.status,
      });
    }
    if (!response.ok) {
      throw createDouyinError(
        `抖音评论接口返回 HTTP ${response.status}`,
        "DOUYIN_COMMENT_API_FAILED",
        { status: response.status }
      );
    }

    const data = parseJsonCandidate(text);
    if (!data) {
      throw createDouyinError("抖音评论接口未返回 JSON", "DOUYIN_COMMENT_BAD_JSON");
    }
    const statusCode = Number(data?.status_code ?? data?.statusCode ?? 0);
    if (Number.isFinite(statusCode) && statusCode !== 0) {
      const message = normalizeText(data?.status_msg ?? data?.statusMsg ?? data?.message);
      const code = /登录|验证|verify|cookie/i.test(message)
        ? "DOUYIN_COOKIE_REQUIRED"
        : "DOUYIN_COMMENT_API_FAILED";
      throw createDouyinError(message || `抖音评论接口状态异常：${statusCode}`, code, {
        statusCode,
      });
    }
    return data;
  }

  async fetchCommentListPage(aweme, { cursor = 0, count = 10, cookie = "" } = {}) {
    const url = buildCommentListUrl(aweme?.id, { cursor, count, cookie });
    return this.requestCommentJson(url, cookie, aweme?.sourceUrl);
  }

  async fetchCommentRepliesPage(
    aweme,
    commentId,
    { cursor = 0, count = 3, cookie = "" } = {}
  ) {
    const url = buildCommentReplyUrl(aweme?.id, commentId, {
      cursor,
      count,
      cookie,
    });
    return this.requestCommentJson(url, cookie, aweme?.sourceUrl);
  }

  async getTopComments(
    aweme,
    {
      limit = 10,
      replyLimit = 3,
      cookie = "",
      browserFallback = true,
      cacheTtlMs = COMMENT_CACHE_TTL_MS,
    } = {}
  ) {
    const awemeId = normalizeText(aweme?.id);
    if (!/^\d{15,22}$/.test(awemeId)) {
      throw createDouyinError("无效的抖音作品 ID", "DOUYIN_INVALID_ID");
    }
    const safeLimit = Math.min(10, Math.max(1, Math.floor(Number(limit) || 10)));
    const safeReplyLimit = Math.min(
      3,
      Math.max(0, Math.floor(Number(replyLimit) || 0))
    );
    const cacheKey = `${awemeId}:${safeLimit}:${safeReplyLimit}`;
    const cached = this.commentCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.result;
    if (cached) this.commentCache.delete(cacheKey);

    const loadTopLevel = async (effectiveCookie) => {
      const rawComments = [];
      const usedIds = new Set();
      let cursor = 0;
      let hasMore = true;
      let total = 0;
      let pageCount = 0;

      while (hasMore && rawComments.length < safeLimit && pageCount < 3) {
        const page = await this.fetchCommentListPage(aweme, {
          cursor,
          count: safeLimit - rawComments.length,
          cookie: effectiveCookie,
        });
        if (pageCount === 0) total = normalizeNumber(page?.total);
        const pageComments = Array.isArray(page?.comments) ? page.comments : [];
        for (const comment of pageComments) {
          const id = normalizeText(comment?.cid ?? comment?.comment_id);
          if (id && usedIds.has(id)) continue;
          if (id) usedIds.add(id);
          rawComments.push(comment);
          if (rawComments.length >= safeLimit) break;
        }

        const nextCursor = normalizeNumber(page?.cursor, page?.max_cursor);
        hasMore = Boolean(Number(page?.has_more ?? page?.hasMore));
        pageCount += 1;
        if (pageComments.length === 0 || nextCursor === cursor) break;
        cursor = nextCursor;
      }
      return { rawComments, total, effectiveCookie };
    };

    let effectiveCookie = this.getCachedBrowserCookie(cookie);
    let loaded;
    try {
      loaded = await loadTopLevel(effectiveCookie);
    } catch (error) {
      const shouldUseBrowser = [
        "DOUYIN_BLOCKED",
        "DOUYIN_COOKIE_REQUIRED",
        "DOUYIN_COMMENT_BAD_JSON",
      ].includes(error?.code);
      if (!browserFallback || !shouldUseBrowser) throw error;
      this.log("info", "[Douyin] 评论请求受限，启动浏览器刷新匿名访问 Cookie");
      effectiveCookie = await this.refreshBrowserCookies(cookie, { force: true });
      loaded = await loadTopLevel(effectiveCookie);
    }

    const creatorIds = [aweme?.author?.id, aweme?.author?.secUid].filter(Boolean);
    const comments = loaded.rawComments.map((comment) => {
      const normalized = normalizeDouyinComment(comment, { creatorIds });
      const includedReplies =
        comment?.reply_comment ?? comment?.replyComment ?? comment?.reply_comments;
      normalized.replies = (Array.isArray(includedReplies) ? includedReplies : [])
        .slice(0, safeReplyLimit)
        .map((reply) =>
          normalizeDouyinComment(reply, { creatorIds, isReply: true })
        );
      return normalized;
    });

    if (safeReplyLimit > 0) {
      let cursor = 0;
      const worker = async () => {
        while (cursor < comments.length) {
          const index = cursor;
          cursor += 1;
          const comment = comments[index];
          if (
            !comment.id ||
            comment.replies.length >= safeReplyLimit ||
            comment.replyCount <= comment.replies.length
          ) {
            continue;
          }
          try {
            const page = await this.fetchCommentRepliesPage(aweme, comment.id, {
              cursor: 0,
              count: safeReplyLimit,
              cookie: loaded.effectiveCookie,
            });
            const usedReplyIds = new Set(comment.replies.map((reply) => reply.id));
            for (const rawReply of Array.isArray(page?.comments) ? page.comments : []) {
              const reply = normalizeDouyinComment(rawReply, {
                creatorIds,
                isReply: true,
              });
              if (reply.id && usedReplyIds.has(reply.id)) continue;
              if (reply.id) usedReplyIds.add(reply.id);
              comment.replies.push(reply);
              if (comment.replies.length >= safeReplyLimit) break;
            }
          } catch (error) {
            this.log(
              "warn",
              `[Douyin] 获取评论 ${comment.id} 的二级回复失败：${error.message}`
            );
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(3, Math.max(1, comments.length)) }, () =>
          worker()
        )
      );
    }

    const result = {
      comments,
      total: loaded.total,
      fetchedAt: Date.now(),
    };
    this.commentCache.set(cacheKey, {
      result,
      expiresAt: Date.now() + Math.max(10_000, Number(cacheTtlMs) || COMMENT_CACHE_TTL_MS),
    });
    if (this.commentCache.size > 100) {
      const now = Date.now();
      for (const [key, entry] of this.commentCache) {
        if (entry.expiresAt <= now || this.commentCache.size > 80) {
          this.commentCache.delete(key);
        }
      }
    }
    return result;
  }

  ensureTempDir() {
    fs.mkdirSync(this.tempDir, { recursive: true });
  }

  createTempPath(id, suffix) {
    this.ensureTempDir();
    const safeId = normalizeText(id).replace(/[^\w-]/g, "_").slice(0, 80) || "douyin";
    const random = Math.random().toString(36).slice(2, 9);
    const target = path.resolve(
      this.tempDir,
      `${safeId}_${Date.now()}_${random}${suffix}`
    );
    const relative = path.relative(this.tempDir, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw createDouyinError("临时文件路径越界", "DOUYIN_UNSAFE_PATH");
    }
    return target;
  }

  async fetchMediaResponse(url, headers, signal) {
    let currentUrl = normalizeMediaUrl(url);
    if (!currentUrl) {
      throw createDouyinError("媒体地址不安全或无效", "DOUYIN_INVALID_MEDIA_URL");
    }

    for (let redirectCount = 0; redirectCount <= 6; redirectCount += 1) {
      const response = await this.fetch(currentUrl, {
        headers,
        redirect: "manual",
        signal,
      });
      if (!REDIRECT_STATUS.has(response.status)) {
        return { response, finalUrl: currentUrl };
      }

      const location = response.headers.get("location");
      try {
        await response.body?.cancel();
      } catch {
      }
      if (!location) {
        throw createDouyinError("媒体跳转缺少地址", "DOUYIN_MEDIA_FAILED");
      }
      const nextUrl = normalizeMediaUrl(new URL(location, currentUrl).toString());
      if (!nextUrl) {
        throw createDouyinError("媒体跳转地址不安全", "DOUYIN_UNSAFE_REDIRECT");
      }
      currentUrl = nextUrl;
    }
    throw createDouyinError("媒体跳转次数过多", "DOUYIN_MEDIA_FAILED");
  }

  async downloadOnce(url, targetPath, { maxBytes, timeoutMs, mediaType }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    const partialPath = `${targetPath}.part`;
    let received = 0;

    try {
      const { response } = await this.fetchMediaResponse(
        url,
        {
          accept: "*/*",
          "accept-encoding": "identity",
          referer: DOUYIN_REFERER,
          "user-agent": DOUYIN_WEB_USER_AGENT,
        },
        controller.signal
      );
      if (!response.ok) {
        throw createDouyinError(
          `媒体下载返回 HTTP ${response.status}`,
          "DOUYIN_MEDIA_FAILED",
          { status: response.status }
        );
      }
      if (!response.body) {
        throw createDouyinError("媒体响应为空", "DOUYIN_MEDIA_FAILED");
      }

      const contentType = normalizeText(response.headers.get("content-type"));
      if (/^(?:text\/|application\/(?:json|xml|javascript))/i.test(contentType)) {
        throw createDouyinError(
          `媒体地址返回了 ${contentType || "非媒体内容"}`,
          "DOUYIN_BAD_MEDIA_CONTENT"
        );
      }
      const declaredSize = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
        throw createDouyinError("媒体文件超过大小限制", "DOUYIN_MEDIA_TOO_LARGE", {
          size: declaredSize,
          maxBytes,
        });
      }

      const limiter = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          if (received > maxBytes) {
            callback(
              createDouyinError("媒体文件超过大小限制", "DOUYIN_MEDIA_TOO_LARGE", {
                size: received,
                maxBytes,
              })
            );
            return;
          }
          callback(null, chunk);
        },
      });

      await pipeline(
        Readable.fromWeb(response.body),
        limiter,
        fs.createWriteStream(partialPath, { flags: "w" })
      );
      if (received < 64) {
        throw createDouyinError("媒体文件内容过短", "DOUYIN_BAD_MEDIA_CONTENT");
      }

      const valid =
        mediaType === "video"
          ? validateMp4(partialPath)
          : validateImage(partialPath, contentType);
      if (!valid) {
        throw createDouyinError("下载结果不是有效媒体文件", "DOUYIN_BAD_MEDIA_CONTENT");
      }

      fs.renameSync(partialPath, targetPath);
      return { path: targetPath, size: received, contentType };
    } catch (error) {
      for (const filePath of [partialPath, targetPath]) {
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch {
        }
      }
      if (error?.name === "AbortError") {
        throw createDouyinError("媒体下载超时", "DOUYIN_MEDIA_TIMEOUT", {
          cause: error,
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async downloadVideo(aweme, { maxBytes, timeoutMs = 120_000, retries = 2 } = {}) {
    const safeMaxBytes = Math.max(1024 * 1024, Number(maxBytes) || 80 * 1024 * 1024);
    const streams = Array.isArray(aweme?.streams) ? aweme.streams : [];
    if (streams.length === 0) {
      throw createDouyinError("未找到可下载的视频地址", "DOUYIN_VIDEO_URL_MISSING");
    }

    const usableStreams = streams.filter(
      (stream) => !stream.dataSize || stream.dataSize <= safeMaxBytes
    );
    if (usableStreams.length === 0) {
      const smallestSize = Math.min(...streams.map((stream) => stream.dataSize || Infinity));
      throw createDouyinError("视频文件超过大小限制", "DOUYIN_MEDIA_TOO_LARGE", {
        size: Number.isFinite(smallestSize) ? smallestSize : 0,
        maxBytes: safeMaxBytes,
      });
    }

    let lastError = null;
    for (let streamIndex = 0; streamIndex < usableStreams.length; streamIndex += 1) {
      const stream = usableStreams[streamIndex];
      for (const url of stream.urls || []) {
        const mediaUrl = normalizeMediaUrl(url);
        if (!mediaUrl) {
          lastError = createDouyinError(
            "媒体地址不安全或无效",
            "DOUYIN_INVALID_MEDIA_URL"
          );
          continue;
        }
        for (let attempt = 1; attempt <= Math.max(1, retries); attempt += 1) {
          const targetPath = this.createTempPath(
            `${aweme?.id || "video"}_${streamIndex}`,
            ".mp4"
          );
          try {
            const result = await this.downloadOnce(mediaUrl, targetPath, {
              maxBytes: safeMaxBytes,
              timeoutMs,
              mediaType: "video",
            });
            return { ...result, stream };
          } catch (error) {
            lastError = error;
            this.log(
              "warn",
              `[Douyin] 视频下载失败 ${attempt}/${Math.max(1, retries)}：${error.message}`
            );
            if (error?.code === "DOUYIN_MEDIA_TOO_LARGE") break;
          }
        }
      }
    }
    throw lastError || createDouyinError("视频下载失败", "DOUYIN_MEDIA_FAILED");
  }

  async downloadImage(urlOrUrls, id, { maxBytes = 15 * 1024 * 1024 } = {}) {
    const urls = collectUrls(urlOrUrls, []).slice(0, 8);
    if (urls.length === 0) {
      throw createDouyinError("未找到可下载的图片地址", "DOUYIN_IMAGE_URL_MISSING");
    }

    let lastError = null;
    for (let urlIndex = 0; urlIndex < urls.length; urlIndex += 1) {
      const url = urls[urlIndex];
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const temporaryPath = this.createTempPath(id, ".image");
        try {
          const result = await this.downloadOnce(url, temporaryPath, {
            maxBytes,
            timeoutMs: 45_000,
            mediaType: "image",
          });
          const finalPath = temporaryPath.replace(
            /\.image$/,
            contentTypeExtension(result.contentType)
          );
          fs.renameSync(temporaryPath, finalPath);
          return { ...result, path: finalPath, sourceUrl: url };
        } catch (error) {
          lastError = error;
          this.log(
            "warn",
            `[Douyin] 图片候选 ${urlIndex + 1}/${urls.length} 下载失败 ${attempt}/2：${
              error.message
            }`
          );
        }
      }
    }
    throw lastError || createDouyinError("图片下载失败", "DOUYIN_MEDIA_FAILED");
  }

  async downloadImageDataUri(
    urlOrUrls,
    id,
    { maxBytes = 10 * 1024 * 1024 } = {}
  ) {
    const result = await this.downloadImage(urlOrUrls, id, { maxBytes });
    try {
      const contentType = normalizeText(result.contentType)
        .toLowerCase()
        .split(";", 1)[0];
      const mimeType = contentType.startsWith("image/")
        ? contentType
        : result.path.endsWith(".png")
          ? "image/png"
          : result.path.endsWith(".webp")
            ? "image/webp"
            : result.path.endsWith(".gif")
              ? "image/gif"
              : "image/jpeg";
      return `data:${mimeType};base64,${fs.readFileSync(result.path).toString("base64")}`;
    } finally {
      this.cleanup(result.path);
    }
  }

  async downloadImageBuffer(
    urlOrUrls,
    id,
    { maxBytes = 10 * 1024 * 1024 } = {}
  ) {
    const result = await this.downloadImage(urlOrUrls, id, { maxBytes });
    try {
      return fs.readFileSync(result.path);
    } finally {
      this.cleanup(result.path);
    }
  }

  async downloadImages(aweme, { maxCount = 12, concurrency = 3 } = {}) {
    const images = (Array.isArray(aweme?.images) ? aweme.images : [])
      .filter(Boolean)
      .slice(0, Math.max(1, maxCount));
    const imageCandidates = Array.isArray(aweme?.imageCandidates)
      ? aweme.imageCandidates
      : [];
    const sources = images.map((url, index) => {
      const candidate = imageCandidates[index] || {};
      const cleanUrls = collectUrls(candidate.cleanUrls, []);
      const watermarkUrls = collectUrls(candidate.watermarkUrls, []).filter(
        (item) => !cleanUrls.includes(item)
      );
      // 详情提供了原图时只在原图 CDN 之间重试，不能因临时失败悄悄降级为水印图。
      const urls = cleanUrls.length > 0 ? cleanUrls : watermarkUrls;
      return {
        urls: (urls.length > 0 ? urls : [url]).slice(0, 8),
        watermarkUrls: cleanUrls.length > 0 ? [] : watermarkUrls,
      };
    });
    const results = new Array(sources.length);
    let cursor = 0;

    const worker = async () => {
      while (cursor < sources.length) {
        const index = cursor;
        cursor += 1;
        const source = sources[index];
        try {
          const downloaded = await this.downloadImage(
            source.urls,
            `${aweme?.id || "note"}_${index + 1}`
          );
          results[index] = {
            ...downloaded,
            watermarked: source.watermarkUrls.includes(downloaded.sourceUrl),
          };
        } catch (error) {
          results[index] = { error, urls: source.urls };
        }
      }
    };

    await Promise.all(
      Array.from(
        {
          length: Math.min(
            Math.max(1, concurrency),
            Math.max(1, sources.length)
          ),
        },
        () => worker()
      )
    );
    const files = results.filter((item) => item?.path);
    return {
      files,
      failures: results.filter((item) => item?.error),
      total: sources.length,
      watermarkedCount: files.filter((item) => item.watermarked).length,
    };
  }

  cleanup(paths) {
    for (const filePath of Array.isArray(paths) ? paths : [paths]) {
      if (!filePath) continue;
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (error) {
        this.log("warn", `[Douyin] 清理临时文件失败 ${filePath}：${error.message}`);
      }
    }
  }
}

export { createDouyinError };
