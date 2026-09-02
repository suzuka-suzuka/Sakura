import { getBrowser } from "../ba/browser.js";

const CARD_WIDTH = 860;
const MAX_CARDS = 10;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeDataUri(value) {
  const uri = String(value || "");
  return /^data:image\/(?:png|jpe?g|webp|gif|avif);base64,/i.test(uri) ? uri : "";
}

function formatCount(value) {
  const number = Math.max(0, Number(value) || 0);
  if (number >= 1e8) return `${(number / 1e8).toFixed(number >= 1e9 ? 0 : 1)}亿`;
  if (number >= 1e4) return `${(number / 1e4).toFixed(number >= 1e5 ? 0 : 1)}万`;
  return String(Math.floor(number));
}

function avatarInitial(nickname) {
  const text = String(nickname || "抖").trim();
  return escapeHtml(Array.from(text)[0] || "抖");
}

function avatarHue(nickname) {
  let hash = 0;
  for (const char of String(nickname || "抖音")) {
    hash = (hash * 31 + char.codePointAt(0)) % 360;
  }
  return hash;
}

function cloneComment(comment) {
  return {
    ...comment,
    author: { ...(comment?.author || {}) },
    replies: (Array.isArray(comment?.replies) ? comment.replies : []).map((reply) => ({
      ...reply,
      author: { ...(reply?.author || {}) },
    })),
  };
}

async function runJobs(jobs, concurrency = 6) {
  let cursor = 0;
  const worker = async () => {
    while (cursor < jobs.length) {
      const index = cursor;
      cursor += 1;
      await jobs[index]();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, jobs.length)) }, () =>
      worker()
    )
  );
}

export async function hydrateDouyinCommentAssets(
  comments,
  { loadImage, concurrency = 6 } = {}
) {
  const hydrated = (Array.isArray(comments) ? comments : [])
    .slice(0, MAX_CARDS)
    .map(cloneComment);
  if (typeof loadImage !== "function" || hydrated.length === 0) return hydrated;

  const cache = new Map();
  const loadCached = (urls, id, maxBytes) => {
    const candidates = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
    if (candidates.length === 0) return Promise.resolve("");
    const key = candidates.join("\n");
    if (!cache.has(key)) {
      cache.set(
        key,
        Promise.resolve(loadImage(candidates, id, maxBytes))
          .then(safeDataUri)
          .catch(() => "")
      );
    }
    return cache.get(key);
  };

  const jobs = [];
  const addAssets = (comment, prefix) => {
    jobs.push(async () => {
      comment.author.avatarDataUri = await loadCached(
        comment.author.avatarUrls,
        `${prefix}-avatar`,
        2 * 1024 * 1024
      );
    });
  };

  hydrated.forEach((comment, index) => {
    addAssets(comment, `comment-${comment.id || index + 1}`);
    comment.replies.forEach((reply, replyIndex) => {
      addAssets(
        reply,
        `comment-${comment.id || index + 1}-reply-${reply.id || replyIndex + 1}`
      );
    });
  });
  await runJobs(jobs, concurrency);
  return hydrated;
}

function renderAvatar(author, sizeClass = "") {
  const avatar = safeDataUri(author?.avatarDataUri);
  const nickname = String(author?.nickname || "抖音用户");
  if (avatar) {
    return `<img class="avatar ${sizeClass}" src="${avatar}" alt="" />`;
  }
  const hue = avatarHue(nickname);
  return `<div class="avatar avatar-fallback ${sizeClass}" style="--avatar-hue:${hue}">${avatarInitial(
    nickname
  )}</div>`;
}

function renderBadges(comment) {
  const badges = [];
  if (comment?.author?.isCreator) badges.push('<span class="badge creator">作者</span>');
  if (comment?.isPinned) badges.push('<span class="badge pinned">置顶</span>');
  return badges.join("");
}

function renderMeta(comment) {
  const pieces = [];
  if (comment?.createdAt) pieces.push(escapeHtml(comment.createdAt));
  if (comment?.ipLabel) pieces.push(`IP属地 ${escapeHtml(comment.ipLabel)}`);
  return pieces.length > 0 ? pieces.join('<span class="meta-dot">·</span>') : "刚刚";
}

function renderReply(reply) {
  const replyPrefix = reply?.replyTo
    ? `<span class="reply-target">回复 @${escapeHtml(reply.replyTo)}</span>`
    : "";
  const text = escapeHtml(reply?.text || (reply?.hasImage ? "[图片回复]" : ""));
  return `
    <div class="reply-item">
      ${renderAvatar(reply?.author, "avatar-small")}
      <div class="reply-main">
        <div class="reply-head">
          <div class="reply-name">${escapeHtml(reply?.author?.nickname || "抖音用户")}${renderBadges(
            reply
          )}</div>
          <div class="reply-like">♥ ${formatCount(reply?.likes)}</div>
        </div>
        <div class="reply-text">${replyPrefix}${text}</div>
        ${
          reply?.hasImage
            ? '<div class="reply-image-hint">配图见本条消息的卡片下方</div>'
            : ""
        }
        <div class="reply-meta">${renderMeta(reply)}</div>
      </div>
    </div>`;
}

function renderCard(comment, index) {
  const text = escapeHtml(
    comment?.text || (comment?.hasImage ? "[图片评论]" : "该评论暂无文字内容")
  );
  const replies = (Array.isArray(comment?.replies) ? comment.replies : []).slice(0, 3);
  const hiddenReplies = Math.max(0, Number(comment?.replyCount || 0) - replies.length);
  return `
    <section class="capture" data-index="${index}">
      <article class="comment-card">
        <div class="top-accent"><i></i><i></i></div>
        <header class="comment-header">
          <div class="rank"><span>TOP</span><strong>${String(index + 1).padStart(2, "0")}</strong></div>
          ${renderAvatar(comment?.author)}
          <div class="identity">
            <div class="nickname">${escapeHtml(comment?.author?.nickname || "抖音用户")}${renderBadges(
              comment
            )}</div>
            <div class="meta">${renderMeta(comment)}</div>
          </div>
          <div class="like"><span>♥</span><strong>${formatCount(comment?.likes)}</strong></div>
        </header>
        <div class="comment-text">${text}</div>
        ${
          comment?.hasImage
            ? '<div class="comment-image-hint">配图见本条消息的卡片下方</div>'
            : ""
        }
        ${
          replies.length > 0
            ? `<div class="reply-panel">
                <div class="reply-title"><span>评论回复</span><b>${replies.length}/${formatCount(
                  comment?.replyCount || replies.length
                )}</b></div>
                ${replies.map(renderReply).join("")}
                ${hiddenReplies > 0 ? `<div class="more-replies">还有 ${formatCount(hiddenReplies)} 条回复</div>` : ""}
              </div>`
            : ""
        }
        <footer class="card-footer">
          <span><i class="pulse cyan"></i><i class="pulse pink"></i>抖音作品热评</span>
          <span>一级评论 · 最多展示 3 条回复</span>
        </footer>
      </article>
    </section>`;
}

function buildHtml(comments) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; width: ${CARD_WIDTH}px; background: #eef1f6; }
  body {
    font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", Arial, sans-serif;
    color: #171923;
    -webkit-font-smoothing: antialiased;
  }
  .capture { width: ${CARD_WIDTH}px; padding: 26px; background: #eef1f6; }
  .comment-card {
    position: relative; overflow: hidden; border-radius: 28px; padding: 30px 32px 24px;
    background: linear-gradient(145deg, #ffffff 0%, #fbfcff 68%, #f7f9ff 100%);
    border: 1px solid rgba(23, 31, 52, .08);
    box-shadow: 0 14px 38px rgba(40, 49, 72, .13), 0 3px 9px rgba(40, 49, 72, .06);
  }
  .top-accent { position: absolute; inset: 0 0 auto 0; height: 6px; display: flex; }
  .top-accent i:first-child { flex: 1; background: linear-gradient(90deg, #25f4ee, #75fff8); }
  .top-accent i:last-child { flex: 1; background: linear-gradient(90deg, #ff7190, #fe2c55); }
  .comment-header { display: flex; align-items: center; gap: 15px; }
  .rank {
    width: 66px; height: 66px; flex: 0 0 66px; border-radius: 20px; display: grid; place-content: center;
    text-align: center; background: #171923; color: white; box-shadow: 0 8px 18px rgba(23,25,35,.18);
  }
  .rank span { font-size: 12px; line-height: 14px; letter-spacing: 2px; color: #8cfbf6; font-weight: 800; }
  .rank strong { font-size: 25px; line-height: 28px; letter-spacing: 1px; }
  .avatar {
    width: 62px; height: 62px; flex: 0 0 62px; border-radius: 50%; object-fit: cover;
    border: 3px solid #fff; box-shadow: 0 0 0 2px rgba(37,244,238,.5), 0 5px 13px rgba(31,42,67,.16);
  }
  .avatar-small { width: 42px; height: 42px; flex-basis: 42px; border-width: 2px; box-shadow: 0 0 0 1px rgba(37,244,238,.36); }
  .avatar-fallback {
    display: grid; place-items: center; color: #fff; font-size: 23px; font-weight: 800;
    background: linear-gradient(145deg, hsl(var(--avatar-hue), 74%, 58%), hsl(calc(var(--avatar-hue) + 42), 70%, 44%));
  }
  .avatar-fallback.avatar-small { font-size: 16px; }
  .identity { min-width: 0; flex: 1; }
  .nickname, .reply-name { display: flex; align-items: center; gap: 8px; min-width: 0; font-weight: 800; color: #202331; }
  .nickname { font-size: 23px; line-height: 32px; }
  .reply-name { font-size: 16px; line-height: 22px; }
  .meta, .reply-meta { color: #8b91a2; font-size: 14px; line-height: 21px; margin-top: 3px; }
  .meta-dot { padding: 0 7px; color: #c3c7d0; }
  .badge { display: inline-flex; align-items: center; height: 23px; padding: 0 8px; border-radius: 8px; font-size: 12px; font-weight: 800; white-space: nowrap; }
  .badge.creator { color: #c71942; background: #fff0f4; border: 1px solid #ffd2dc; }
  .badge.pinned { color: #087e7a; background: #e9fffd; border: 1px solid #b8f3ef; }
  .like { min-width: 74px; text-align: right; color: #697083; }
  .like span { display: block; color: #fe2c55; font-size: 20px; line-height: 20px; }
  .like strong { font-size: 15px; line-height: 23px; }
  .comment-text { margin: 25px 2px 0; font-size: 25px; line-height: 1.62; font-weight: 650; white-space: pre-wrap; word-break: break-word; color: #20222c; }
  .comment-image-hint, .reply-image-hint { color: #148f8b; font-weight: 750; }
  .comment-image-hint { display: inline-flex; margin-top: 12px; padding: 7px 12px; border-radius: 99px; background: #e8fbf9; font-size: 14px; }
  .reply-panel { margin-top: 24px; padding: 17px 19px 12px; border-radius: 20px; background: linear-gradient(145deg, #f4f6fa, #f8f9fc); border: 1px solid #e5e8ef; }
  .reply-title { display: flex; justify-content: space-between; align-items: center; padding: 0 2px 8px; color: #757c8e; font-size: 14px; }
  .reply-title span { font-weight: 800; letter-spacing: .5px; color: #5e6576; }
  .reply-title b { padding: 3px 9px; border-radius: 99px; color: #087e7a; background: #e4fbf9; }
  .reply-item { display: flex; align-items: flex-start; gap: 12px; padding: 14px 2px; border-top: 1px solid #e3e6ed; }
  .reply-main { min-width: 0; flex: 1; }
  .reply-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  .reply-like { flex: 0 0 auto; color: #9499a8; font-size: 13px; }
  .reply-text { margin-top: 5px; color: #343744; font-size: 17px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
  .reply-target { color: #148f8b; font-weight: 750; margin-right: 7px; }
  .reply-image-hint { margin-top: 5px; font-size: 12px; }
  .reply-meta { font-size: 12px; margin-top: 6px; }
  .more-replies { padding: 10px 0 3px 54px; border-top: 1px solid #e3e6ed; color: #148f8b; font-size: 14px; font-weight: 750; }
  .card-footer { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-top: 22px; padding-top: 17px; border-top: 1px solid #eceef3; color: #9a9fad; font-size: 12px; }
  .card-footer span { display: flex; align-items: center; }
  .pulse { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
  .pulse.cyan { background: #25f4ee; margin-right: -2px; }
  .pulse.pink { background: #fe2c55; margin-right: 8px; }
</style>
</head>
<body>${comments.map(renderCard).join("")}</body>
</html>`;
}

export async function renderDouyinCommentCards(
  comments,
  { loadImage, assetConcurrency = 6, scale = 1.25 } = {}
) {
  const hydrated = await hydrateDouyinCommentAssets(comments, {
    loadImage,
    concurrency: assetConcurrency,
  });
  if (hydrated.length === 0) return [];

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({
      width: CARD_WIDTH,
      height: 1200,
      deviceScaleFactor: Math.max(1, Math.min(2, Number(scale) || 1.25)),
    });
    await page.setContent(buildHtml(hydrated), { waitUntil: "domcontentloaded" });
    await page.evaluateHandle("document.fonts.ready").catch(() => null);
    await page
      .evaluate(() =>
        Promise.all(
          Array.from(document.images).map((img) => {
            if (img.complete) return Promise.resolve();
            return new Promise((resolve) => {
              img.addEventListener("load", resolve, { once: true });
              img.addEventListener("error", resolve, { once: true });
            });
          })
        )
      )
      .catch(() => null);

    const elements = await page.$$(".capture");
    const buffers = [];
    for (const element of elements.slice(0, MAX_CARDS)) {
      buffers.push(await element.screenshot({ type: "jpeg", quality: 92 }));
    }
    return buffers;
  } finally {
    await page.close().catch(() => {});
  }
}
