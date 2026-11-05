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
const { generateImagesWithProvider } = await import("../lib/AIUtils/imageProvider.js");
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
  assert.equal(parser.parseImageCommandArgs("frames=16 小猫挥手").promptText, "frames=16 小猫挥手");
});

test("配置不再包含 GIF 帧参数，忽略旧配置中的残留值", () => {
  const config = EditImageSchema.parse({ imageRoute: "static", gifFrameCount: 9, gifFrameDurationMs: 200 });
  assert.equal(config.gifRoute, "");
  assert.equal(Object.hasOwn(config, "gifFrameCount"), false);
  assert.equal(Object.hasOwn(config, "gifFrameDurationMs"), false);
});

test("请求使用 GIF 路由且忽略旧配置帧参数，保留多帧原始字节", async () => {
  const buffers = await generate({ selfId: 10001 });
  assert.deepEqual(buffers, [gif]);
  assert.deepEqual(requests[0], {
    model: "gpt-image-2.6-flare", prompt: "小猫挥手", output_format: "gif",
    size: "auto",
  });
});

test("请求传递显式路由与动画参数", async () => {
  routes.push(route("override", ["gpt-image-2.6-sunburst"]));
  await generate({ channel: "override", frameCount: 64, frameDurationMs: 20, count: 2 });
  assert.equal(requests[0].model, "gpt-image-2.6-sunburst");
  assert.equal(requests[0].frame_count, 64);
  assert.equal(requests[0].frame_duration_ms, 20);
  assert.equal(requests[0].n, 2);
});

test("未设置专用路由和帧参数时兼容旧配置", async () => {
  featureConfig = { imageRoute: "animation" };
  await generate();
  assert.equal(Object.hasOwn(requests[0], "frame_count"), false);
  assert.equal(Object.hasOwn(requests[0], "frame_duration_ms"), false);
});

test("两个 GIF 帧参数可独立省略", async () => {
  await generate({ frameCount: 8 });
  assert.equal(requests[0].frame_count, 8);
  assert.equal(Object.hasOwn(requests[0], "frame_duration_ms"), false);
  await generate({ frameDurationMs: 100 });
  assert.equal(Object.hasOwn(requests[1], "frame_count"), false);
  assert.equal(requests[1].frame_duration_ms, 100);
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
  for (const frameCount of [1, 65, 2.5, NaN]) {
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
  assert.equal(Object.hasOwn(editRequests[1], "frame_count"), false);
  assert.equal(Object.hasOwn(editRequests[1], "frame_duration_ms"), false);
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
  const e = event("#gif frames=16 delay=100 小猫挥手");
  assert.equal((await app.preflightImageEdit(e)).charge, true);
  assert.equal(await app.dispatchHandler(e), true);
  assert.equal(requests[0].frame_count, 16);
  assert.deepEqual(e.replies[0][0].buffer, gif);
  const withReference = event("#gif 让它眨眼", [png]);
  assert.equal(await app.dispatchHandler(withReference), true);
  assert.deepEqual(editRequests[0].image, png);
});

test("命令缺少提示词时免扣费，已受理请求的拒绝输入和生成失败均保留扣费", async () => {
  const app = await loadEntry("../apps/ImageEdit.js", "EditImage");
  const empty = event("#gif frames=16");
  assert.equal((await app.preflightImageEdit(empty)).charge, false);
  assert.equal(await app.dispatchHandler(empty), true);
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
