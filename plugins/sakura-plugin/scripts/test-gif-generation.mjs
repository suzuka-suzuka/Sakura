// node --experimental-test-module-mocks --experimental-vm-modules --test plugins/sakura-plugin/scripts/test-gif-generation.mjs
// 使用真实路由、请求构造和 GIF 解码，隔离配置、网络与 QQ 消息发送。
import assert from "node:assert/strict";
import test, { beforeEach, after, mock } from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import sharp from "sharp";
import * as parser from "../lib/AIUtils/imageCommandParser.js";
import { formatMediaUserError } from "../lib/AIUtils/mediaErrorMessages.js";
import { EditImageSchema } from "../configSchema.js";

const pixels = Buffer.from([255, 0, 0, 0, 0, 255]);
const gif = await sharp(pixels, { raw: { width: 1, height: 2, channels: 3, pageHeight: 1 } })
  .gif({ delay: [100, 100], loop: 0 }).toBuffer();
assert.equal((await sharp(gif).metadata()).pages, 2);
const png = await sharp(gif).png().toBuffer();
const singleGif = await sharp(png).gif().toBuffer();
let featureConfig;
let routes;
let requests;
let response;
let editRequests;
const target = (model, priority = 1) => ({ id: model, model, priority, provider: "openai", enabled: true });
const route = (id, models) => ({ id, strategy: "priority", maxAttempts: 2, retryDelayMs: 0, targets: models.map((model) => target(model)) });
const setting = {
  getConfig(name) {
    if (name === "EditImage") return featureConfig;
    if (name === "ImageRoutes") return { routes };
    if (name === "Providers") return { providers: [{
      id: "openai", protocol: "openai", baseURL: "https://example.invalid/v1",
      credentials: [{ id: "test", apiKey: "test-only", enabled: true }],
    }] };
    return {};
  },
};
class FakeOpenAI {
  images = {
    generate: async (request) => {
      requests.push(request);
      return response(request);
    },
    edit: async (request) => {
      editRequests.push(request);
      return response(request);
    },
  };
}
mock.module(new URL("../lib/setting.js", import.meta.url).href, { defaultExport: setting });
mock.module(new URL("../node_modules/openai/index.mjs", import.meta.url).href, {
  defaultExport: FakeOpenAI, namedExports: { toFile: async (value) => value },
});
const oldLogger = globalThis.logger;
const oldFetch = globalThis.fetch;
globalThis.logger = { warn() {}, error() {}, info() {}, mark() {} };
const { generateImagesWithProvider, normalizeImageGenerationOptions } = await import("../lib/AIUtils/imageProvider.js");
beforeEach(() => {
  featureConfig = { imageRoute: "static", gifRoute: "animation", gifFrameCount: 12, gifFrameDurationMs: 100 };
  routes = [route("static", ["gpt-image-2"]), route("animation", ["gpt-image-2.6-flare"])];
  requests = [];
  editRequests = [];
  response = async () => ({ data: [{ b64_json: gif.toString("base64") }] });
  globalThis.fetch = async () => assert.fail("不应访问网络");
});
after(() => { globalThis.logger = oldLogger; globalThis.fetch = oldFetch; mock.restoreAll(); });
const generate = (options = {}, images = []) => generateImagesWithProvider(featureConfig, "小猫挥手", images, { outputFormat: "gif", ...options });

test("GIF 参数解析不改变静态图片提示词", () => {
  const args = parser.parseGifCommandArgs("route=animation frames=16 delay=100 16:9 小猫挥手");
  assert.equal(args.frameCount, 16);
  assert.equal(args.frameDurationMs, 100);
  assert.equal(args.channel, "animation");
  assert.equal(args.aspectRatio, "16:9");
  assert.equal(args.promptText, "小猫挥手");
  assert.deepEqual(parser.parseGifCommandArgs("route=animation f=16 d=100 16:9 小猫挥手"), args);
  assert.deepEqual(parser.parseGifCommandArgs("route=animation --F=16 --D=100 16:9 小猫挥手"), args);
  const mixed = parser.parseGifCommandArgs("frames=8 f=16 d=200 delay=100 小猫挥手");
  assert.equal(mixed.frameCount, 16);
  assert.equal(mixed.frameDurationMs, 100);
  assert.equal(mixed.promptText, "小猫挥手");
  assert.equal(parser.parseImageCommandArgs("frames=16 小猫挥手").promptText, "frames=16 小猫挥手");
});

test("GIF 配置补齐默认值并校验帧参数范围", () => {
  const config = EditImageSchema.parse({ imageRoute: "static" });
  assert.equal(config.gifRoute, "");
  assert.equal(config.gptQuality, "auto");
  assert.equal(EditImageSchema.parse({ gptQuality: "max" }).gptQuality, "max");
  assert.equal(EditImageSchema.safeParse({ gptQuality: "ultra" }).success, false);
  assert.equal(config.gifFrameCount, 9);
  assert.equal(config.gifFrameDurationMs, 200);
  assert.equal(EditImageSchema.safeParse({ gifFrameCount: 17 }).success, false);
  assert.equal(EditImageSchema.safeParse({ gifFrameDurationMs: 25 }).success, false);
});

test("请求使用 GIF 路由和配置帧参数，保留多帧原始字节", async () => {
  const buffers = await generate({ selfId: 10001 });
  assert.deepEqual(buffers, [gif]);
  assert.deepEqual(requests[0], {
    model: "gpt-image-2.6-flare", prompt: "小猫挥手", output_format: "gif",
    frame_count: 12, frame_duration_ms: 100,
  });
});

test("请求传递显式路由与动画参数", async () => {
  routes.push(route("override", ["gpt-image-2.6-sunburst"]));
  await generate({ channel: "override", frameCount: 16, frameDurationMs: 20, count: 2 });
  assert.equal(requests[0].model, "gpt-image-2.6-sunburst");
  assert.equal(requests[0].frame_count, 16);
  assert.equal(requests[0].frame_duration_ms, 20);
  assert.equal(requests[0].n, 2);
});

test("未设置专用路由和帧参数时兼容旧配置", async () => {
  featureConfig = { imageRoute: "animation" };
  await generate();
  assert.equal(requests[0].frame_count, 9);
  assert.equal(requests[0].frame_duration_ms, 200);
});

test("两个 GIF 帧参数可独立覆盖配置", async () => {
  await generate({ frameCount: 8 });
  assert.equal(requests[0].frame_count, 8);
  assert.equal(requests[0].frame_duration_ms, 100);
  await generate({ frameDurationMs: 300 });
  assert.equal(requests[1].frame_count, 12);
  assert.equal(requests[1].frame_duration_ms, 300);
});

test("GIF 在 maxAttempts 截断前筛选模型，保留可用目标", async () => {
  routes[1].targets = [target("gpt-image-2", 10), target("gpt-image-2.6-flare", 1)];
  routes[1].maxAttempts = 1;
  await generate();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, "gpt-image-2.6-flare");
});

test("GIF 目标失败后只回退到兼容模型", async () => {
  routes[1].targets = [target("gpt-image-2.6-sunburst", 3), target("gpt-image-2", 2), target("gpt-image-2.6-flare", 1)];
  response = async (request) => {
    if (request.model.endsWith("sunburst")) throw new Error("模拟上游失败");
    return { data: [{ b64_json: gif.toString("base64") }] };
  };
  await generate();
  assert.deepEqual(requests.map((request) => request.model), ["gpt-image-2.6-sunburst", "gpt-image-2.6-flare"]);
});

test("URL 输出保留完整动画，兼容 GIF 和通用二进制响应头", async () => {
  response = async () => ({ data: [{ url: "https://example.invalid/result.gif" }] });
  for (const mimeType of ["image/gif", "application/octet-stream"]) {
    globalThis.fetch = async () => new Response(gif, { headers: { "content-type": mimeType } });
    assert.deepEqual(await generate(), [gif]);
  }
});

test("gpt 别名选择包含 GIF 模型的路由", async () => {
  await generate({ channel: "gpt" });
  assert.equal(requests[0].model, "gpt-image-2.6-flare");
});

test("拒绝超量参考图、非法帧参数和不兼容路由，均不发模型请求", async () => {
  await assert.rejects(generate({}, Array(17).fill("https://example.invalid/input.png")), /最多支持 16 张/);
  for (const frameCount of [1, 17, 64, 65, 2.5, NaN]) {
    await assert.rejects(generate({ frameCount }), /帧数/);
  }
  for (const frameDurationMs of [0, 25, 2010, NaN]) {
    await assert.rejects(generate({ frameDurationMs }), /每帧时长/);
  }
  await assert.rejects(generate({ channel: "static" }), /没有可用/);
  assert.equal(requests.length, 0);
  assert.equal(editRequests.length, 0);
});

test("GIF 参考图通过编辑接口提交原图字节和动画参数", async () => {
  assert.deepEqual(await generate({ frameCount: 4, frameDurationMs: 200 }, [png]), [gif]);
  assert.equal(requests.length, 0);
  assert.equal(editRequests[0].output_format, "gif");
  assert.equal(editRequests[0].frame_count, 4);
  assert.equal(editRequests[0].frame_duration_ms, 200);
  assert.deepEqual(editRequests[0].image, png);
  await generate({}, [png, png]);
  assert.deepEqual(editRequests[1].image, [png, png]);
  assert.equal(editRequests[1].frame_count, 12);
  assert.equal(editRequests[1].frame_duration_ms, 100);
  assert.equal(Object.hasOwn(editRequests[1], "size"), false);
  assert.equal(Object.hasOwn(editRequests[1], "quality"), false);
});

test("拒绝伪装成 GIF 的 PNG 和单帧 GIF", async () => {
  response = async () => ({ data: [{ b64_json: png.toString("base64") }] });
  await assert.rejects(generate(), /其他格式/);
  response = async () => ({ data: [{ b64_json: singleGif.toString("base64") }] });
  await assert.rejects(generate(), /单帧/);
});

test("普通静态生图仍走原始路由且不附带 GIF 参数", async () => {
  response = async () => ({ data: [{ b64_json: png.toString("base64") }] });
  const result = await generateImagesWithProvider(featureConfig, "小猫", [], {});
  assert.deepEqual(result, [png]);
  assert.equal(requests[0].model, "gpt-image-2");
  assert.equal(requests[0].output_format, undefined);
  assert.equal(requests[0].frame_count, undefined);
  assert.equal(Object.hasOwn(requests[0], "size"), false);
  assert.equal(Object.hasOwn(requests[0], "quality"), false);
});

test("画质参数独立于尺寸，支持简称、完整名称和自动值", async () => {
  const parsed = parser.parseImageCommandArgs("2K q=low quality=MAX 小猫");
  assert.equal(parsed.quality, "max");
  assert.equal(parsed.imageSize, "2K");
  assert.equal(parsed.promptText, "小猫");
  for (const quality of ["low", "medium", "high", "xhigh", "max", "auto"]) {
    await generate({ imageSize: "1K", quality });
    const request = requests.at(-1);
    assert.equal(request.size, "1024x1024");
    assert.equal(request.quality, quality === "auto" ? undefined : quality);
  }
  await generate({ imageSize: "2K" });
  assert.equal(requests.at(-1).size, "2048x2048");
  assert.equal(Object.hasOwn(requests.at(-1), "quality"), false);
  await generate({ quality: "max" });
  assert.equal(Object.hasOwn(requests.at(-1), "size"), false);
  const requestCount = requests.length;
  await assert.rejects(generate({ quality: "ultra" }), /图片画质/);
  assert.equal(requests.length, requestCount);
});

test("GPT 默认画质支持命令覆盖、显式自动和账号配置", async () => {
  featureConfig.gptQuality = "max";
  await generate({}, [png]);
  assert.equal(editRequests[0].quality, "max");
  await generate({ quality: "low" });
  assert.equal(requests[0].quality, "low");
  await generate({ quality: "auto" });
  assert.equal(Object.hasOwn(requests[1], "quality"), false);
  response = async () => ({ data: [{ b64_json: png.toString("base64") }] });
  await generateImagesWithProvider({ ...featureConfig, gptQuality: "low" }, "小猫", [], {
    selfId: 10001, channel: "animation",
  });
  assert.equal(requests[2].quality, "max");
  await generateImagesWithProvider({ ...featureConfig, gptQuality: "medium" }, "小猫", [], {
    channel: "animation",
  });
  assert.equal(requests[3].quality, "medium");
  for (const [provider, model] of [["gemini", "gemini-3-pro-image-preview"], ["openai", "grok-imagine-image"], ["openai", "dall-e-3"]]) {
    const normalized = normalizeImageGenerationOptions(provider, model, { defaultGptQuality: "max" });
    assert.equal(normalized.options.quality, undefined);
    assert.deepEqual(normalized.warnings, []);
  }
});

test("每次路由回退按目标模型调整默认画质并提示", async () => {
  featureConfig.gptQuality = "max";
  routes[0].targets = [target("gpt-image-2.6-sunburst", 3), target("gpt-image-2", 2), target("gpt-image-2.5-flare", 1)];
  routes[0].maxAttempts = 3;
  response = async (request) => {
    if (request.model === "gpt-image-2.6-sunburst") throw new Error("模拟上游失败");
    return { data: [{ b64_json: png.toString("base64") }] };
  };
  const warnings = [];
  await generateImagesWithProvider(featureConfig, "小猫", [], {}, {
    onParameterWarnings: (items) => warnings.push(...items),
  });
  assert.deepEqual(requests.map((request) => request.quality), ["max", "high"]);
  assert.match(warnings.join(" "), /max.*high/);
  const modern = normalizeImageGenerationOptions("openai", "gpt-image-2.5-flare-2026-09-08", { quality: "max" });
  assert.equal(modern.options.quality, "max");
  for (const [provider, model] of [["gemini", "gemini-3-pro-image-preview"], ["openai", "grok-imagine-image"], ["openai", "dall-e-3"]]) {
    const normalized = normalizeImageGenerationOptions(provider, model, { quality: "max" });
    assert.equal(normalized.options.quality, undefined);
    assert.match(normalized.warnings.join(" "), /忽略 q=max/);
  }
});

async function loadEntry(relativePath, exportName) {
  const context = vm.createContext({
    Buffer, logger: globalThis.logger, plugin: class {},
    OnEvent: (_, ...args) => args.at(-1),
    segment: { image: (buffer) => ({ type: "image", buffer }) },
  });
  const imports = {
    "../lib/AIUtils/imageProvider.js": { generateImagesWithProvider },
    "../imageProvider.js": { generateImagesWithProvider },
    "../lib/AIUtils/imageCommandParser.js": parser,
    "../lib/AIUtils/mediaErrorMessages.js": { formatMediaUserError },
    "../lib/setting.js": { default: setting },
    "../../setting.js": { default: setting },
    "../lib/utils.js": { getImg: async (e) => e.inputs || [] },
    "./AbstractTool.js": { AbstractTool: class {} },
    "../messageLookup.js": { fetchMessageByIdentifier: async () => ({ message_id: 1, message: [{ type: "image", data: { url: "https://example.invalid/reference.png" } }] }) },
  };
  const module = new vm.SourceTextModule(fs.readFileSync(new URL(relativePath, import.meta.url), "utf8"), { context });
  await module.link((specifier) => {
    const exports = imports[specifier];
    assert.ok(exports, specifier);
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  return new module.namespace[exportName]();
}
const event = (msg, inputs = []) => ({ msg, inputs, self_id: 10001, replies: [], react: async () => {}, async reply(value) { this.replies.push(value); } });

test("真实命令入口完成预检、生成和 GIF 消息发送", async () => {
  const app = await loadEntry("../apps/ImageEdit.js", "EditImage");
  const e = event("#gif f=16 d=100 q=max 小猫挥手");
  assert.equal((await app.preflightImageEdit(e)).charge, true);
  assert.equal(await app.dispatchHandler(e), true);
  assert.equal(requests[0].frame_count, 16);
  assert.equal(requests[0].frame_duration_ms, 100);
  assert.equal(requests[0].quality, "max");
  assert.deepEqual(e.replies[0][0].buffer, gif);
  const withReference = event("#gif quality=xhigh 让它眨眼", [png]);
  assert.equal(await app.dispatchHandler(withReference), true);
  assert.deepEqual(editRequests[0].image, png);
  assert.equal(editRequests[0].quality, "xhigh");
});

test("普通生图和自定义编辑命令将画质传入请求", async () => {
  const app = await loadEntry("../apps/ImageEdit.js", "EditImage");
  response = async () => ({ data: [{ b64_json: png.toString("base64") }] });
  await app.dispatchHandler(event("#i 1K quality=high 小猫"));
  assert.equal(requests[0].size, "1024x1024");
  assert.equal(requests[0].quality, "high");
  assert.equal(requests[0].prompt, "小猫");
  await app.dynamicImageHandler(event("#修改 q=medium 小猫", [png]), { prompt: "变成水彩" }, ["#修改"], [png]);
  assert.equal(editRequests[0].quality, "medium");
  assert.equal(editRequests[0].prompt, "变成水彩 小猫");
});

test("命令缺少提示词时免扣费，已受理请求的拒绝输入和生成失败均保留扣费", async () => {
  const app = await loadEntry("../apps/ImageEdit.js", "EditImage");
  const empty = event("#gif frames=16");
  assert.equal((await app.preflightImageEdit(empty)).charge, false);
  assert.equal(await app.dispatchHandler(empty), false);
  assert.deepEqual(empty.replies, []);
  assert.equal(requests.length, 0);
  assert.equal(editRequests.length, 0);
  const invalid = event("#gif frames=1 小猫挥手");
  const rejected = await app.dispatchHandler(invalid);
  assert.equal(rejected, true);
  const preflight = await app.preflightImageEdit(invalid);
  assert.equal(preflight.charge, true);
  assert.equal(preflight.refundOnFalse, false);
  assert.match(invalid.replies[0], /帧数/);
  response = async () => { throw new Error("模拟失败"); };
  assert.equal(await app.dispatchHandler(event("#gif 小猫挥手")), true);
  response = async () => ({ data: [] });
  assert.equal(await app.dispatchHandler(event("#gif 小猫挥手")), true);
});

test("AI 生图工具支持文字及 seq 参考图生成 GIF", async () => {
  const tool = await loadEntry("../lib/AIUtils/tools/ImageGeneratorTool.js", "ImageGeneratorTool");
  const e = event("");
  const result = await tool.func({ prompt: "小猫挥手", outputFormat: "gif", frameCount: 16 }, e);
  assert.match(result, /已成功生成并发送 GIF/);
  assert.deepEqual(e.replies[0].buffer, gif);
  assert.equal(requests[0].frame_count, 16);
  globalThis.fetch = async () => new Response(png, { headers: { "content-type": "image/png" } });
  assert.match(await tool.func({ prompt: "挥手", outputFormat: "gif", seq: [1] }, e), /已成功生成并发送 GIF/);
  assert.deepEqual(editRequests[0].image, png);
});
