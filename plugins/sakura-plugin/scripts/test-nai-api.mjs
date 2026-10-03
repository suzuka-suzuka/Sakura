import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";
import { loadImage } from "@napi-rs/canvas";
import { NaiSchema } from "../configSchema.js";
import { getNaiApiConfig, DEFAULT_NAI_URL } from "../lib/nai/apiConfig.js";
import { generateImage, generateImageWithCallback, encodeVibe, getNaiQuota, checkNaiUsageLimit } from "../lib/nai/naiApi.js";
import { renderNaiQuotaImage } from "../lib/nai/quotaImage.js";
import Setting from "../lib/setting.js";
import configManager from "../../../src/core/pluginConfig.js";
import { getCurrentBotSelfId, withBotContext } from "../../../src/api/client.js";

const config = (key = "test-key", url = "https://relay.example.com") => ({ key, url, model: "nai-diffusion-4-5-full" });
const quota = (percent = 72.5, isRelay = false) => ({ percent, subscriptionAnlas: 8500, purchasedAnlas: 1200, totalAnlas: 9700, isRelay });

function subscription({ percent = 72.5, isRelay = false } = {}) {
    return { ok: true, status: 200, json: async () => ({
        tier: isRelay ? 1 : 3, active: true,
        usage: { percent, isNegative: percent === 0, timeUntilNextPercent: 60 },
        trainingStepsLeft: { fixedTrainingStepsLeft: 8500, purchasedTrainingSteps: 1200 },
        ...(isRelay && { relay: { billing: "local" } }),
    }) };
}

function imageResponse() {
    const zip = new AdmZip();
    zip.addFile("image.png", Buffer.from("fake-image"));
    const data = zip.toBuffer();
    return { ok: true, status: 200, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
}

function runtime(t, currentConfig = config()) {
    const original = { getConfig: Setting.getConfig, fetch: global.fetch, logger: global.logger, redis: global.redis, setTimeout: global.setTimeout };
    const warnings = [];
    const delays = [];
    const redisCalls = [];
    t.after(() => {
        Setting.getConfig = original.getConfig;
        Object.assign(global, { fetch: original.fetch, logger: original.logger, redis: original.redis, setTimeout: original.setTimeout });
    });
    Setting.getConfig = () => currentConfig;
    global.logger = { warn: (message) => warnings.push(message), error() {} };
    global.redis = {
        get: async (key) => { redisCalls.push(["get", key]); return null; },
        set: async (...args) => { redisCalls.push(["set", ...args]); return "OK"; },
        ttl: async () => -2,
    };
    global.setTimeout = (fn, delay) => { delays.push(delay); fn(); return 0; };
    return { warnings, delays, redisCalls };
}

test("NAI 配置只提供 Key 和 URL，旧配置不会迁移，面板元数据同步", () => {
    const parsed = NaiSchema.parse({ token: "old-key", apis: [{ token: "pool-key", weight: 2 }] });
    assert.equal(parsed.key, "");
    assert.equal(parsed.url, DEFAULT_NAI_URL);
    assert.equal(parsed.token, undefined);
    assert.equal(parsed.apis, undefined);
    assert.equal(NaiSchema.configInputMigration, undefined);
    assert.throws(() => getNaiApiConfig(parsed), /未设置 NovelAI API Key/);
    assert.equal(configManager._normalizeModuleData(NaiSchema, { token: "old" }).key, "");
    const metadata = configManager._schemaToMeta(NaiSchema);
    assert.equal(metadata.children.key.type, "string");
    assert.equal(metadata.children.key.label, "API Key");
    assert.equal(metadata.children.url.type, "string");
    for (const name of ["apis", "token", "weight", "name"]) assert.equal(metadata.children[name], undefined);
    assert.deepEqual(getNaiApiConfig(config(" key ", " https://relay.example.com/prefix/// ")), {
        key: "key", url: "https://relay.example.com/prefix",
    });
    for (const url of ["", "relay.example.com", "file:///tmp", "ftp://relay.example.com", "https://a:b@relay.example.com", "https://relay.example.com?key=x", "https://relay.example.com#x"]) {
        assert.throws(() => getNaiApiConfig(config("key", url)), /URL/);
        assert.equal(NaiSchema.safeParse(config("key", url)).success, false);
    }
});

test("生图、Vibe 和余额查询全部使用第三方 URL、路径前缀及同一 Key", async (t) => {
    runtime(t, config("skr_test", "https://relay.example.com/prefix///"));
    const requests = [];
    global.fetch = async (url, options) => {
        requests.push([url, options.headers.Authorization]);
        if (url.endsWith("/user/subscription")) return subscription({ isRelay: true });
        return imageResponse();
    };
    assert.equal((await generateImage("1girl")).toString(), "fake-image");
    await encodeVibe("base64");
    assert.equal((await getNaiQuota(Setting.getConfig("nai"))).isRelay, true);
    assert.deepEqual(requests, [
        ["https://relay.example.com/prefix/ai/generate-image", "Bearer skr_test"],
        ["https://relay.example.com/prefix/ai/encode-vibe", "Bearer skr_test"],
        ["https://relay.example.com/prefix/user/subscription", "Bearer skr_test"],
    ]);
});

test("队列跨机器人保留各自 URL、Key 和模型，配置修改不改变已入队请求", async (t) => {
    runtime(t);
    const configs = {
        101: config("bot-a", "https://a.example.com"),
        202: { ...config("bot-b", "https://b.example.com"), model: "nai-diffusion-4-5-curated" },
    };
    Setting.getConfig = () => configs[getCurrentBotSelfId()];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const calls = [];
    global.fetch = async (url, options) => {
        calls.push([url, options.headers.Authorization, JSON.parse(options.body).model]);
        if (calls.length === 1) await gate;
        return imageResponse();
    };
    const a = withBotContext(101, () => generateImage("a"));
    let started = false;
    const b = withBotContext(202, () => generateImageWithCallback("b", null, null, {}, null, [], () => { started = true; }));
    configs[202].key = "mutated-after-enqueue";
    configs[202].url = "https://changed.example.com";
    const c = withBotContext(101, () => generateImage("c"));
    release();
    await Promise.all([a, b, c]);
    assert.equal(started, true);
    assert.deepEqual(calls, [
        ["https://a.example.com/ai/generate-image", "Bearer bot-a", "nai-diffusion-4-5-full"],
        ["https://b.example.com/ai/generate-image", "Bearer bot-b", "nai-diffusion-4-5-curated"],
        ["https://a.example.com/ai/generate-image", "Bearer bot-a", "nai-diffusion-4-5-full"],
    ]);
});

test("网络错误、429 和响应中断固定每 2 秒重试，保留 URL、Key 和参数", async (t) => {
    const { delays, warnings } = runtime(t);
    const calls = [];
    global.fetch = async (url, options) => {
        calls.push([url, options.headers.Authorization, options.body]);
        if (calls.length === 1) throw new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET" } });
        if (calls.length === 2) return { ok: false, status: 429, text: async () => "limited" };
        if (calls.length === 3) return { ok: true, status: 200, arrayBuffer: async () => { throw new TypeError("terminated"); } };
        return imageResponse();
    };
    await generateImage("1girl");
    assert.equal(calls.length, 4);
    assert.equal(new Set(calls.map((call) => JSON.stringify(call))).size, 1);
    assert.deepEqual(delays, [2000, 2000, 2000]);
    assert.equal(warnings.length, 3);
    warnings.forEach((message, index) => assert.match(message, new RegExp(`2 秒后进行第 ${index + 1}/3 次重试`)));
    assert.doesNotMatch(warnings.join("\n"), /test-key/);
});

test("连续 429 最多重试三次，失败后下一张仍可继续生成", async (t) => {
    const { delays } = runtime(t);
    let calls = 0;
    global.fetch = async () => {
        calls += 1;
        if (calls <= 4) return { ok: false, status: 429, text: async () => "limited" };
        return imageResponse();
    };
    const failed = generateImage("a");
    const next = generateImage("b");
    await assert.rejects(failed, /429/);
    assert.equal((await next).toString(), "fake-image");
    assert.equal(calls, 5);
    assert.deepEqual(delays, [2000, 2000, 2000]);
});

test("Relay 502、503、504 临时错误也按 2 秒间隔重试", async (t) => {
    const { delays } = runtime(t);
    for (const status of [502, 503, 504]) {
        let calls = 0;
        global.fetch = async () => {
            calls += 1;
            return calls === 1 ? { ok: false, status, text: async () => "temporarily unavailable" } : imageResponse();
        };
        assert.equal((await generateImage("1girl")).toString(), "fake-image");
        assert.equal(calls, 2);
    }
    assert.deepEqual(delays, [2000, 2000, 2000]);
});

test("参数和鉴权错误不会重试，配置缺失不会发送请求", async (t) => {
    const { delays } = runtime(t);
    let calls = 0;
    for (const status of [400, 401, 403]) {
        global.fetch = async () => { calls++; return { ok: false, status, text: async () => "rejected" }; };
        await assert.rejects(generateImage("1girl"), new RegExp(`status ${status}`));
    }
    assert.equal(calls, 3);
    assert.deepEqual(delays, []);
    Setting.getConfig = () => ({ token: "legacy-token", apis: [{ token: "legacy-pool" }] });
    await assert.rejects(generateImage("1girl"), /未设置 NovelAI API Key/);
    await assert.rejects(encodeVibe("base64"), /未设置 NovelAI API Key/);
    await assert.rejects(getNaiQuota(Setting.getConfig("nai")), /未设置 NovelAI API Key/);
    assert.equal(calls, 3);
});

test("Relay 普通 Key 体力为 0% 时 V5 仍交给 Relay 处理且不设置客户端冷却", async (t) => {
    const { redisCalls } = runtime(t, { ...config(), model: "nai-diffusion-5-full" });
    const calls = [];
    global.fetch = async (url, options) => {
        calls.push([url, options.headers.Authorization, options.body && JSON.parse(options.body).model]);
        return url.endsWith("/subscription") ? subscription({ percent: 0, isRelay: true }) : imageResponse();
    };
    await generateImage("1girl");
    assert.deepEqual(calls, [
        ["https://relay.example.com/user/subscription", "Bearer test-key", undefined],
        ["https://relay.example.com/ai/generate-image", "Bearer test-key", "nai-diffusion-5-full"],
    ]);
    assert.equal(redisCalls.some(([operation]) => operation === "set"), false);
});

test("相同 Key 在不同 URL 下的用量冷却互相独立且不泄露密钥", async (t) => {
    runtime(t);
    const keys = [];
    const redisClient = { get: async (key) => { keys.push(key); return null; }, set: async () => "OK" };
    const fetchImpl = async () => subscription({ percent: 5 });
    for (const url of ["https://a.example.com", "https://b.example.com"]) {
        await assert.rejects(checkNaiUsageLimit(config("same-key", url), { redisClient, fetchImpl }), /用量仅剩 5%/);
    }
    assert.equal(new Set(keys).size, 2);
    assert.doesNotMatch(keys.join(" "), /same-key|example/);
});

test("单接口余额卡片支持官方、Relay 和零体力，输出 PNG", async () => {
    const previews = [["official", quota(86.5)], ["relay", quota(0, true)]];
    for (const [name, value] of previews) {
        const buffer = await renderNaiQuotaImage(value, { generatedAt: new Date("2026-10-03T08:30:00Z") });
        const image = await loadImage(buffer);
        assert.equal(image.width, 1160);
        assert.equal(image.height, 738);
        if (process.env.NAI_PREVIEW_DIR) {
            await mkdir(process.env.NAI_PREVIEW_DIR, { recursive: true });
            await writeFile(path.join(process.env.NAI_PREVIEW_DIR, `nai-quota-${name}.png`), buffer);
        }
    }
});

test("余额指令限定主人并读取事件账号的 URL 和 Key", async (t) => {
    runtime(t, config("command-key"));
    const original = { plugin: global.plugin, Command: global.Command, segment: global.segment };
    t.after(() => Object.assign(global, original));
    const registrations = [];
    global.plugin = class {};
    global.Command = (...args) => { registrations.push(args); return args.findLast((item) => typeof item === "function"); };
    global.segment = { image: (data) => ({ type: "image", data }) };
    const { NaiPainting } = await import("../apps/NaiPainting.js");
    const instance = new NaiPainting();
    const [pattern, permission] = registrations[0];
    assert.equal(permission, "master");
    for (const command of ["查询nai余额", "#查询nai额度", "#查询NAI余额"]) assert.ok(pattern.test(command));
    let configOptions;
    Setting.getConfig = (_module, options) => { configOptions = options; return config("command-key"); };
    global.fetch = async (url, options) => {
        assert.equal(url, "https://relay.example.com/user/subscription");
        assert.equal(options.headers.Authorization, "Bearer command-key");
        return subscription();
    };
    const replies = [];
    await instance.queryNaiQuota({ self_id: 987654, reply: async (value) => replies.push(value) });
    assert.deepEqual(configOptions, { selfId: 987654 });
    assert.equal(replies[0].type, "image");
    assert.ok(Buffer.isBuffer(replies[0].data));
    Setting.getConfig = () => ({ key: "", url: DEFAULT_NAI_URL });
    await instance.queryNaiQuota({ self_id: 987654, reply: async (value) => replies.push(value) });
    assert.match(replies[1], /未设置 NovelAI API Key/);
});
