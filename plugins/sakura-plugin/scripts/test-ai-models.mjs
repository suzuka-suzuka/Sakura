// node --test plugins/sakura-plugin/scripts/test-ai-models.mjs
// 验证“供应商 + 模型 + 使用处模型列表”的配置、执行计划和旧配置迁移，不连接外部服务。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import yaml from "js-yaml";

import { ModelsSchema, ProvidersSchema, AISchema, MimicSchema, EditImageSchema } from "../configSchema.js";
import { buildModelsFromRoutes, migrateConfigDirectory, migrateProviders } from "../lib/AIUtils/configMigration.js";
import { formatModelList, modelKey, normalizeModelList, providerCredentials } from "../lib/AIUtils/aiModels.js";

globalThis.logger ||= { info() {}, warn() {}, error() {}, debug() {} };

const url = (relative) => new URL(relative, import.meta.url).href;

function mockSetting(configs) {
  const reads = [];
  const handle = mock.module(url("../lib/setting.js"), {
    defaultExport: {
      getConfig(moduleName, scope = {}) {
        reads.push({ moduleName, scope });
        return configs[moduleName] || {};
      },
    },
  });
  return { reads, restore: () => handle.restore() };
}

async function importFresh(relative) {
  return import(`${url(relative)}?t=${Date.now()}-${Math.random()}`);
}

const providers = {
  providers: [
    { name: "中转", protocol: "openai", baseURL: "https://relay.example/v1", vertex: false, apiKeys: ["key-a", "key-b"], serviceAccounts: [] },
    { name: "谷歌", protocol: "gemini", baseURL: "", vertex: false, apiKeys: ["gkey"], serviceAccounts: [] },
  ],
};

const models = {
  models: [
    { provider: "中转", model: "gpt-x", type: "chat", enabled: true, openaiReasoningEffort: "high" },
    { provider: "中转", model: "gpt-x", name: "gpt-x-快", type: "chat", enabled: true },
    { provider: "谷歌", model: "gemini-pro", type: "chat", enabled: true, geminiThinkingLevel: "low", timeoutSeconds: 45 },
    { provider: "中转", model: "old-model", type: "chat", enabled: false },
    { provider: "中转", model: "grok-imagine-image", type: "image", enabled: true },
    { provider: "中转", model: "gpt-image-2", type: "image", enabled: true },
  ],
};

test("模型用别名或模型名标识，使用处列表去重且保留顺序", () => {
  assert.equal(modelKey({ model: "gpt-x", name: "" }), "gpt-x");
  assert.equal(modelKey({ model: "gpt-x", name: " 快 " }), "快");
  assert.deepEqual(normalizeModelList(["a", " b ", "a", ""]), ["a", "b"]);
  assert.deepEqual(normalizeModelList("single"), ["single"]);
  assert.equal(formatModelList(["a", "b"]), "a → b");
});

test("供应商 Key 列表展开为内部凭据，日志里只显示 Key 末尾", () => {
  const credentials = providerCredentials(providers.providers[0]);
  assert.deepEqual(credentials.map((item) => item.apiKey), ["key-a", "key-b"]);
  assert.ok(credentials.every((item) => !item.id.includes("key-a") && !item.id.includes("key-b")));
  const vertex = providerCredentials({ protocol: "gemini", vertex: true, apiKeys: ["ignored"], serviceAccounts: ["sa.json"] });
  assert.deepEqual(vertex.map((item) => item.serviceAccountRef), ["sa.json"]);
});

test("供应商和模型 schema：Key 必填、模型名重复时提示填写别名", () => {
  assert.equal(ProvidersSchema.safeParse(providers).success, true);
  const missingKey = ProvidersSchema.safeParse({ providers: [{ name: "空", protocol: "openai" }] });
  assert.equal(missingKey.success, false);
  assert.match(missingKey.error.issues[0].message, /API Key/);

  assert.equal(ModelsSchema.safeParse(models).success, true);
  const duplicated = ModelsSchema.safeParse({ models: [
    { provider: "中转", model: "gpt-x" },
    { provider: "谷歌", model: "gpt-x" },
  ] });
  assert.equal(duplicated.success, false);
  assert.match(duplicated.error.issues[0].message, /别名/);

  const ai = AISchema.parse({ utilityModels: ["gpt-x"], profiles: [{ prefixes: ["%"], models: ["gpt-x", "gemini-pro"] }] });
  assert.deepEqual(ai.profiles[0].models, ["gpt-x", "gemini-pro"]);
  assert.deepEqual(AISchema.parse({}).geminiModels, []);
  assert.deepEqual(MimicSchema.parse({}).models, []);
  assert.deepEqual(EditImageSchema.parse({}).videoModels, []);
});

test("执行计划按列表顺序尝试模型，同一模型内轮流使用 Key，跳过停用和不存在的模型", async () => {
  const setting = mockSetting({ Providers: providers, Models: models });
  try {
    const router = await importFresh("../lib/AIUtils/providerRouter.js");
    const plan = router.createRouteExecutionPlan(["gpt-x-快", "missing", "old-model", "gemini-pro"], { selfId: 123 });
    assert.deepEqual(
      plan.attempts.map((attempt) => `${attempt.target.id}/${attempt.credential.apiKey}`),
      ["gpt-x-快/key-a", "gpt-x-快/key-b", "gemini-pro/gkey"]
    );
    assert.equal(plan.route.id, "gpt-x-快 → missing → old-model → gemini-pro");
    assert.ok(setting.reads.every((read) => read.scope.selfId === 123));

    const gemini = plan.attempts[2].requestConfig;
    assert.equal(gemini.channelType, "gemini");
    assert.equal(gemini.geminiThinkingLevel, "low");
    assert.equal(gemini.timeoutMs, 45000);
    assert.equal(plan.attempts[0].requestConfig.timeoutMs, 300000);

    const next = router.createRouteExecutionPlan(["gpt-x"], { selfId: 123 });
    assert.equal(next.attempts[0].requestConfig.openaiReasoningEffort, "high");

    const geminiOnly = router.createRouteExecutionPlan(["gpt-x", "gemini-pro"], { protocol: "gemini" });
    assert.deepEqual(geminiOnly.attempts.map((attempt) => attempt.target.id), ["gemini-pro"]);

    assert.throws(() => router.createRouteExecutionPlan([], {}), /没有选择对话模型/);
    assert.throws(() => router.createRouteExecutionPlan(["nope"], {}), /未找到对话模型：nope/);
    // 图片模型不会被对话列表误用
    assert.throws(() => router.createRouteExecutionPlan(["gpt-image-2"], {}), /未找到对话模型/);
  } finally {
    setting.restore();
  }
});

test("命令里的简写会展开成所有匹配的同类模型", async () => {
  const setting = mockSetting({ Providers: providers, Models: models });
  try {
    const router = await importFresh("../lib/AIUtils/providerRouter.js");
    const grok = ({ target }) => /grok/i.test(target.model);
    assert.deepEqual(router.resolveRouteReference("grok", { kind: "image", targetMatches: grok }), ["grok-imagine-image"]);
    assert.deepEqual(router.resolveRouteReference("GPT-IMAGE-2", { kind: "image" }), ["gpt-image-2"]);
    assert.deepEqual(router.resolveRouteReference("unknown", { kind: "image" }), ["unknown"]);
  } finally {
    setting.restore();
  }
});

test("旧凭据池迁移为 Key 列表：按优先级排序并去掉停用的凭据", () => {
  const migrated = migrateProviders({ providers: [{
    id: "cpa",
    protocol: "openai",
    baseURL: "https://x/v1",
    credentials: [
      { id: "1", apiKey: "low", priority: 0 },
      { id: "2", apiKey: "high", priority: 5 },
      { id: "3", apiKey: "off", priority: 9, enabled: false },
    ],
  }] });
  assert.deepEqual(migrated.providers[0], {
    name: "cpa", protocol: "openai", baseURL: "https://x/v1", vertex: false, apiKeys: ["high", "low"], serviceAccounts: [],
  });
});

test("路由迁移：按优先级展开，参数不同的同名模型自动起别名", () => {
  const { models: migrated, routeMaps } = buildModelsFromRoutes({
    chat: { routes: [
      { id: "1", timeoutMs: 600000, targets: [
        { id: "a", provider: "cpa", model: "gpt", priority: 0, nativeWebSearch: true },
        { id: "b", provider: "ms", model: "deepseek", priority: 2 },
      ] },
      { id: "gpt", timeoutMs: 300000, targets: [
        { id: "a", provider: "cpa", model: "gpt", priority: 1, openaiReasoningEffort: "xhigh", nativeWebSearch: true },
        { id: "off", provider: "cpa", model: "disabled-model", enabled: false },
      ] },
    ] },
    image: { routes: [{ id: "img", targets: [{ id: "g", provider: "cpa", model: "gpt-image-2" }] }] },
  });
  assert.deepEqual(routeMaps.chat.get("1"), ["deepseek", "gpt"]);
  assert.deepEqual(routeMaps.chat.get("gpt"), ["gpt-xhigh"]);
  assert.deepEqual(routeMaps.image.get("img"), ["gpt-image-2"]);
  const byKey = Object.fromEntries(migrated.map((entry) => [modelKey(entry), entry]));
  assert.equal(byKey.gpt.timeoutSeconds, 600);
  assert.equal(byKey["gpt-xhigh"].openaiReasoningEffort, "xhigh");
  assert.equal(byKey["gpt-xhigh"].timeoutSeconds, 0);
  assert.equal(byKey["disabled-model"].enabled, false);
  assert.equal(byKey["gpt-image-2"].type, "image");
  assert.equal(ModelsSchema.safeParse({ models: migrated }).success, true);
});

test("整目录迁移：改写引用、删除路由文件、留下备份，重复执行不再改动", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sakura-migrate-"));
  const write = (relative, data) => {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), yaml.dump(data));
  };
  const read = (relative) => yaml.load(fs.readFileSync(path.join(root, relative), "utf8"));
  try {
    write("Providers.yaml", { providers: [{ id: "cpa", protocol: "openai", credentials: [{ id: "1", apiKey: "k" }] }] });
    write("Routes.yaml", { routes: [{ id: "main", targets: [{ id: "t", provider: "cpa", model: "chat-model" }] }] });
    write("ImageRoutes.yaml", { routes: [{ id: "img", targets: [{ id: "t", provider: "cpa", model: "image-model" }] }] });
    write("VideoRoutes.yaml", { routes: [{ id: "vid", targets: [{ id: "t", provider: "cpa", model: "video-model" }] }] });
    write("AI.yaml", { utilityRoute: "main", geminiRoute: "", profiles: [{ prefixes: ["%"], route: "main" }] });
    write("mimic.yaml", { route: "main", GroupConfigs: [{ group: 1, route: "missing" }] });
    write("EditImage.yaml", { imageRoute: "img", gifRoute: "", videoRoute: "vid", tasks: [] });
    write("_accounts/42/AI.yaml", { utilityRoute: "main", profiles: [] });

    const warnings = [];
    migrateConfigDirectory(root, { logger: { info() {}, warn: (message) => warnings.push(message) } });

    assert.deepEqual(read("Providers.yaml").providers[0].apiKeys, ["k"]);
    assert.deepEqual(read("Models.yaml").models.map(modelKey), ["chat-model", "image-model", "video-model"]);
    assert.deepEqual(read("AI.yaml").utilityModels, ["chat-model"]);
    assert.deepEqual(read("AI.yaml").geminiModels, []);
    assert.deepEqual(read("AI.yaml").profiles[0].models, ["chat-model"]);
    assert.equal(Object.hasOwn(read("AI.yaml").profiles[0], "route"), false);
    assert.deepEqual(read("mimic.yaml").models, ["chat-model"]);
    assert.deepEqual(read("mimic.yaml").GroupConfigs[0].models, []);
    assert.deepEqual(read("EditImage.yaml").imageModels, ["image-model"]);
    assert.deepEqual(read("EditImage.yaml").videoModels, ["video-model"]);
    assert.deepEqual(read("_accounts/42/AI.yaml").utilityModels, ["chat-model"]);
    for (const file of ["Routes.yaml", "ImageRoutes.yaml", "VideoRoutes.yaml"]) {
      assert.equal(fs.existsSync(path.join(root, file)), false);
    }
    assert.equal(fs.readdirSync(path.join(root, "_migration-backup")).length, 1);
    assert.ok(warnings.some((message) => message.includes("missing")));

    const snapshot = ["Providers.yaml", "Models.yaml", "AI.yaml", "mimic.yaml", "EditImage.yaml"]
      .map((file) => fs.readFileSync(path.join(root, file), "utf8"));
    migrateConfigDirectory(root, { logger: { info() {}, warn() {} } });
    assert.deepEqual(
      ["Providers.yaml", "Models.yaml", "AI.yaml", "mimic.yaml", "EditImage.yaml"].map((file) => fs.readFileSync(path.join(root, file), "utf8")),
      snapshot
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
