// node --experimental-vm-modules --test plugins/sakura-plugin/scripts/test-get-img.mjs
// 使用真实提图函数和指令入口，隔离配置、图片下载与生成接口。
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import * as imageParser from "../lib/AIUtils/imageCommandParser.js";
import * as videoParser from "../lib/AIUtils/videoCommandParser.js";

const avatar = (qq) => `https://q1.qlogo.cn/g?b=qq&s=640&nk=${qq}`;
const image = (url) => ({ type: "image", data: { url } });
const at = (qq) => ({ type: "at", data: { qq } });
const plain = (value) => value == null ? value : structuredClone(value);
const decoded = (images) => Array.from(images, (item) => Buffer.from(item.base64, "base64").toString());
// 保留 VM 模块引用，避免 Node 22 在异步测试间过早回收上下文。
const harnessModules = [];

async function harness({ download } = {}) {
  const calls = { downloads: [], warnings: [], errors: [], imageRequests: [], videoRequests: [] };
  const context = vm.createContext({
    Buffer,
    logger: {
      warn: (...args) => calls.warnings.push(args),
      error: (...args) => calls.errors.push(args),
    },
    fetch: async (url) => {
      calls.downloads.push(url);
      if (download) await download(url);
      return {
        ok: true,
        headers: { get: () => "image/jpeg" },
        arrayBuffer: async () => Uint8Array.from(Buffer.from(url)).buffer,
      };
    },
    plugin: class {},
    Command: (pattern, ...args) => args.at(-1),
    OnEvent: (event, ...args) => args.at(-1),
    segment: { image: (buffer) => ({ type: "image", data: buffer }) },
  });
  const setting = {
    getConfig: () => ({ tasks: [{ trigger: "^换装", prompt: "换上礼服" }] }),
  };
  const imports = {
    "./path.js": { _path: "/isolated" },
    sharp: { default: () => assert.fail("本用例不应进行 GIF 转码") },
    marked: { marked() {} },
    puppeteer: { default: {} },
    remark: { remark() {} },
    "strip-markdown": { default() {} },
    "./AIUtils/messaging.js": { parseAtMessage() {} },
    "./setting.js": { default: setting },
    "./reactionEmojiStore.js": { chooseRandomReactionEmojiId() {}, getReactionEmojiIds() {} },
    "../lib/setting.js": { default: setting },
    "../lib/AIUtils/imageCommandParser.js": imageParser,
    "../lib/AIUtils/videoCommandParser.js": videoParser,
    "../lib/AIUtils/mediaErrorMessages.js": { formatMediaUserError: (error) => error.message },
    "../lib/AIUtils/imageProvider.js": {
      generateImagesWithProvider: async (config, prompt, images, options) => {
        calls.imageRequests.push({ prompt, images: plain(images), options: plain(options) });
        return [Buffer.from("模拟生成图片")];
      },
    },
    "../lib/AIUtils/videoProvider.js": {
      generateVideoWithProvider: async (request) => {
        calls.videoRequests.push({ images: plain(request.images) });
        return { provider: "gemini", source: "https://example.invalid/video.mp4" };
      },
    },
    "node:fs/promises": { default: { unlink: () => assert.fail("不应操作文件") } },
  };
  const synthetic = (exports) => {
    const module = new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
    harnessModules.push(module);
    return module;
  };
  const utils = new vm.SourceTextModule(fs.readFileSync(new URL("../lib/utils.js", import.meta.url), "utf8"), { context });
  harnessModules.push(utils, context);
  await utils.link((specifier) => {
    assert.ok(imports[specifier], `缺少依赖替身: ${specifier}`);
    return synthetic(imports[specifier]);
  });
  await utils.evaluate();

  const loadApp = async (name, exportName) => {
    const module = new vm.SourceTextModule(fs.readFileSync(new URL(`../apps/${name}.js`, import.meta.url), "utf8"), { context });
    harnessModules.push(module);
    await module.link((specifier) => {
      if (specifier === "../lib/utils.js") return utils;
      assert.ok(imports[specifier], `缺少依赖替身: ${specifier}`);
      return synthetic(imports[specifier]);
    });
    await module.evaluate();
    return new module.namespace[exportName]();
  };
  const event = (message, { reply, replyError, msg = "#i 合影" } = {}) => ({
    message,
    msg,
    self_id: 99999,
    get at() {
      const qq = message?.find((segment) => segment.type === "at")?.data?.qq;
      return qq && qq !== "all" ? String(qq) : undefined;
    },
    reply_id: reply !== undefined || replyError ? "引用消息" : undefined,
    getReplyMsg: async () => {
      if (replyError) throw replyError;
      return { message: reply };
    },
    react: async () => {},
    reply: async () => {},
  });
  return { getImg: utils.namespace.getImg, calls, event, loadApp };
}

test("多个头像在当前图片之前，重复头像和图片只保留第一次", async () => {
  const { getImg, event } = await harness();
  const e = event([image("当前1"), at(10001), at("10002"), at(10001), image("当前2"), image("当前1")]);
  const expected = [avatar(10001), avatar(10002), "当前1", "当前2"];
  assert.deepEqual(plain(await getImg(e, true)), expected);
  assert.deepEqual(plain(e.img), expected);
});

test("引用图片在当前图片之前，自动和手动 @ 都不进入引用模式", async () => {
  const { getImg, event } = await harness();
  const e = event([at(10001), image("当前"), at(10002)], {
    reply: [image("引用1"), at(10003), image("引用2"), image("当前")],
  });
  assert.deepEqual(plain(await getImg(e, { getAvatar: true })), ["引用1", "引用2", "当前"]);
});

test("引用没有图片时仍不提取自动 @，只保留当前图片", async () => {
  const { getImg, event } = await harness();
  assert.deepEqual(plain(await getImg(event([at(10001), image("当前")], { reply: [] }), true)), ["当前"]);
  assert.equal(await getImg(event([at(10001)], { reply: [] }), true), null);
});

test("引用读取失败仍保留当前图片，并继续排除自动 @", async () => {
  const { getImg, event, calls } = await harness();
  const e = event([at(10001), image("当前")], { replyError: new Error("引用已撤回") });
  assert.deepEqual(plain(await getImg(e, true)), ["当前"]);
  assert.equal(calls.warnings.length, 1);
});

test("关闭头像提取后仍能混合当前和引用图片", async () => {
  const { getImg, event } = await harness();
  assert.deepEqual(plain(await getImg(event([at(10001), image("当前")], { reply: [image("引用")] }))), ["引用", "当前"]);
  assert.equal(await getImg(event([at(10001)])), null);
});

test("全体、机器人自身和无效 @ 不进入头像列表", async () => {
  const { getImg, event } = await harness();
  const e = event([at("all"), at(99999), at(null), at("abc"), at(0), at(10001)]);
  assert.deepEqual(plain(await getImg(e, true)), [avatar(10001)]);
});

test("不完整消息返回空结果，不请求下载", async () => {
  const { getImg, event, calls } = await harness();
  for (const message of [undefined, "纯文本", []]) {
    assert.equal(await getImg(event(message), true, true), null);
  }
  assert.deepEqual(calls.downloads, []);
});

test("原来源优先模式不混合素材，并保留原先的头像回退", async () => {
  const { getImg, event } = await harness();
  const options = { mode: "priority", getAvatar: true };
  assert.deepEqual(plain(await getImg(event([at(10001), image("当前1"), image("当前2")], {
    replyError: new Error("有当前图片时不应读取引用"),
  }), options)), ["当前1", "当前2"]);
  assert.deepEqual(plain(await getImg(event([at(10001)], { reply: [image("引用")] }), options)), ["引用"]);
  assert.deepEqual(plain(await getImg(event([at(10001), at(10002)]), options)), [avatar(10001)]);
  assert.deepEqual(plain(await getImg(event([at(10001)], { reply: [] }), options)), [avatar(10001)]);
});

test("并发转为 base64 保持素材顺序，单张失败不影响其他图片", async () => {
  const { getImg, event, calls } = await harness({
    download: async (url) => {
      if (url === "失败") throw new Error("下载失败");
      if (url === "引用") await new Promise((resolve) => setTimeout(resolve, 10));
    },
  });
  const e = event([at(10001), image("失败"), image("当前")], { reply: [image("引用")] });
  const images = await getImg(e, { getAvatar: true, toBase64: true });
  assert.deepEqual(decoded(images), ["引用", "当前"]);
  assert.deepEqual(plain(e.img), ["引用", "失败", "当前"]);
  assert.deepEqual(calls.downloads, ["引用", "失败", "当前"]);
  assert.equal(calls.errors.length, 1);
});

test("旧布尔参数写法兼容 base64，多头像按混合规则处理", async () => {
  const { getImg, event } = await harness();
  assert.deepEqual(decoded(await getImg(event([at(10001), at(10002)]), true, true)), [avatar(10001), avatar(10002)]);
});

test("#i 真实入口在同一次请求里传入两个人的头像和当前图片", async () => {
  const { event, calls, loadApp } = await harness();
  const app = await loadApp("ImageEdit", "EditImage");
  assert.equal(await app.dispatchHandler(event([at(10001), image("当前"), at(10002)])), true);
  assert.equal(calls.imageRequests.length, 1);
  assert.deepEqual(decoded(calls.imageRequests[0].images), [avatar(10001), avatar(10002), "当前"]);
});

test("#i 真实入口传入引用与当前图片，不传自动 @ 的头像", async () => {
  const { event, calls, loadApp } = await harness();
  const app = await loadApp("ImageEdit", "EditImage");
  assert.equal(await app.dispatchHandler(event([at(10001), image("当前")], { reply: [image("引用")] })), true);
  assert.deepEqual(decoded(calls.imageRequests[0].images), ["引用", "当前"]);
});

test("自定义触发词经过经济预检后只使用首张当前图片，复用已下载素材", async () => {
  const { event, calls, loadApp } = await harness();
  const app = await loadApp("ImageEdit", "EditImage");
  const e = event([at(10001), image("当前1"), image("当前2")], { msg: "换装", reply: [image("引用")] });
  assert.equal((await app.preflightImageEdit(e)).accepted, true);
  const downloads = calls.downloads.length;
  assert.equal(await app.dispatchHandler(e), true);
  assert.equal(calls.downloads.length, downloads);
  assert.deepEqual(decoded(calls.imageRequests[0].images), ["当前1"]);
});

test("自定义触发词未经过预检时也只使用一张引用图片", async () => {
  const { event, calls, loadApp } = await harness();
  const app = await loadApp("ImageEdit", "EditImage");
  assert.equal(await app.dispatchHandler(event([at(10001)], {
    msg: "换装", reply: [image("引用1"), image("引用2")],
  })), true);
  assert.deepEqual(decoded(calls.imageRequests[0].images), ["引用1"]);
});

test("自定义触发词缺少素材时不接受预检，也不调用生成接口", async () => {
  const { event, calls, loadApp } = await harness();
  const app = await loadApp("ImageEdit", "EditImage");
  const e = event([], { msg: "换装" });
  assert.equal(await app.preflightImageEdit(e), false);
  assert.equal(await app.dispatchHandler(e), false);
  assert.equal(calls.imageRequests.length, 0);
});

test("#v 真实入口按引用图片、当前图片的顺序传入素材", async () => {
  const { event, calls, loadApp } = await harness();
  const app = await loadApp("VideoGeneration", "VideoGeneration");
  assert.equal(await app.generateVideo(event([at(10001), image("当前")], {
    msg: "#v 跳舞", reply: [image("引用")],
  })), true);
  assert.deepEqual(decoded(calls.videoRequests[0].images), ["引用", "当前"]);
});
