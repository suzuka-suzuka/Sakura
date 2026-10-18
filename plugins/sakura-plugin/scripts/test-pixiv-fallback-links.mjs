// node --test plugins/sakura-plugin/scripts/test-pixiv-fallback-links.mjs
// 验证失败兜底链接，不连接 Pixiv、OneBot 或 Redis。
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { PixivSchema } from "../configSchema.js";
import { sendPixivImages } from "../lib/pixiv/sendImages.js";

const previousLogger = globalThis.logger;
globalThis.logger = { info() {}, warn() {} };
after(() => { globalThis.logger = previousLogger; });

const original = "https://i.pximg.net/img-original/img/2022/08/02/23/41/55/100189465_p0.jpg";
const second = original.replace("_p0.jpg", "_p1.jpg");
const artwork = "https://www.pixiv.net/artworks/100189465";
const heading = "图片最终发送失败，请点击链接查看：\n";

async function fallback(options = {}, receipt = { message_id: 123 }) {
  const messages = [];
  const downloads = [];
  const ok = await sendPixivImages({
    group_id: 600,
    reply: async (content, recall) => { messages.push({ content, recall }); return receipt; },
  }, {
    imageUrls: [original], proxy: "download.example", pid: 100189465, ...options,
  }, {
    download: async url => { downloads.push(url); return false; },
    flipImage: async () => { assert.fail("下载失败时不应翻转图片"); },
    verify: async () => { assert.fail("下载失败时不应发送图片"); },
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].recall, 60);
  return { content: messages[0].content, downloads, ok };
}

test("兜底反代配置默认留空，并独立于下载反代", () => {
  const defaults = PixivSchema.parse({ proxy: "download.example" });
  assert.equal(defaults.fallbackLinkProxy, "");
  const configured = PixivSchema.parse({ proxy: "download.example", fallbackLinkProxy: "public.example" });
  assert.equal(configured.proxy, "download.example");
  assert.equal(configured.fallbackLinkProxy, "public.example");
});

test("未配置、留空或只有空格时只发作品页，不暴露下载地址和原图地址", async () => {
  for (const options of [{}, { fallbackLinkProxy: "" }, { fallbackLinkProxy: "  " }]) {
    const result = await fallback(options);
    assert.equal(result.content, heading + artwork);
    assert.deepEqual(result.downloads, [original.replace("i.pximg.net", "download.example")]);
    assert.equal(result.ok, true);
  }
});

test("配置兜底反代后只发公开反代图片链接，下载仍使用下载反代", async () => {
  const result = await fallback({ fallbackLinkProxy: " public.example " });
  assert.equal(result.content, heading + original.replace("i.pximg.net", "public.example"));
  assert.deepEqual(result.downloads, [original.replace("i.pximg.net", "download.example")]);
});

test("下载反代留空时仍可独立配置公开兜底反代", async () => {
  const result = await fallback({ proxy: "", fallbackLinkProxy: "public.example" });
  assert.deepEqual(result.downloads, [original]);
  assert.equal(result.content, heading + original.replace("i.pximg.net", "public.example"));
});

test("多图兜底完整保留反代链接并去重，保持路径和查询参数", async () => {
  const sources = [original + "?test=1", second, original + "?test=1"];
  const result = await fallback({ imageUrls: sources, fallbackLinkProxy: "public.example" });
  assert.equal(result.content, heading + [sources[0], second].map(url => url.replace("i.pximg.net", "public.example")).join("\n"));
});

test("多图未配置兜底反代时只发一个作品页", async () => {
  const result = await fallback({ imageUrls: [original, second] });
  assert.equal(result.content, heading + artwork);
});

test("兜底消息发送失败时仍返回失败", async () => {
  for (const receipt of [null, { message_id: 0 }]) {
    assert.equal((await fallback({}, receipt)).ok, false);
  }
});
