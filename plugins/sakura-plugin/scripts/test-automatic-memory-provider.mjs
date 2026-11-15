import assert from "node:assert/strict";
import test, { after, mock } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "sakura-memory-provider-"));
const url = (relative) => new URL(relative, import.meta.url).href;
let toolGroups = [];
global.logger = { info() {}, warn() {}, error() {} };
mock.module(url("../lib/path.js"), { namedExports: { plugindata: fixture, pluginRoot: fileURLToPath(new URL("../", import.meta.url)) } });
mock.module(url("../lib/setting.js"), { defaultExport: { getConfig: () => ({ toolGroups }) } });
mock.module(url("../lib/AIUtils/GroupContext.js"), { namedExports: { buildGroupPrompt: async () => "" } });
mock.module(url("../lib/AIUtils/MCPManager.js"), { namedExports: { mcpManager: {} } });
mock.module(url("../lib/AIUtils/embeddingProvider.js"), { namedExports: {
  DEFAULT_EMBEDDING_VERSION: "test-memory-provider-v1",
  generateTextEmbedding: async () => { throw new Error("读取个人记忆不应请求向量"); },
} });
// 无关工具用替身隔离，实际加载并验证工具注册器和记忆读写工具。
const toolSource = fs.readFileSync(new URL("../lib/AIUtils/tools/tools.js", import.meta.url), "utf8");
for (const [, name, file] of toolSource.matchAll(/import \{ (\w+) \} from "\.\/([^"/]+Tool\.js)";/g)) {
  if (name === "MemoryTool") continue;
  mock.module(url(`../lib/AIUtils/tools/${file}`), { namedExports: { [name]: class {
    name = name;
    function() { return { name, parameters: { type: "object", properties: {} } }; }
  } } });
}

let protocol = "openai";
const payloads = [];
mock.module(url("../lib/AIUtils/providerRouter.js"), { namedExports: {
  createRouteExecutionPlan: (id) => ({ route: { id }, attempts: [{
    target: { id: "test" }, provider: { id: "test" }, credential: { id: "test" },
    requestConfig: { channelType: protocol, model: "test-model", apiKey: "test", stream: false, nativeWebSearch: true },
  }] }),
  isRequestConfigComplete: () => true,
  prioritizeRouteAttempt: (plan) => plan,
  createRouteFailure: (message, routeAction) => Object.assign(new Error(message), { routeAction }),
  ROUTE_FAILURE_ACTIONS: { NEXT: "next", NEXT_MODEL: "next_model", NEXT_PROVIDER: "next_provider", ABORT: "abort" },
  executeRoutePlan: async ({ plan, run }) => {
    let error = null;
    for (const attempt of plan.attempts) {
      try {
        return { ok: true, value: await run(attempt), attempt };
      } catch (caught) {
        error = caught;
      }
    }
    return { ok: false, error };
  },
} });
mock.module("openai", { defaultExport: class {
  chat = { completions: { create: async (payload) => {
    payloads.push(payload);
    return { choices: [{ message: { content: "已完成" } }] };
  } } };
} });
mock.module(url("../lib/AIUtils/vertexAuth.js"), { namedExports: { createGeminiClient: () => ({
  models: { generateContent: async (payload) => {
    payloads.push(payload);
    return { candidates: [{ content: { parts: [{ text: "已完成" }] }, finishReason: "STOP" }] };
  } },
}) } });
const { getToolsSchema, AVAILABLE_TOOL_OPTIONS } = await import("../lib/AIUtils/tools/tools.js");
const { getAI } = await import("../lib/AIUtils/getAI.js");

after(() => {
  assert.ok(path.resolve(fixture).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("普通聊天复用Memory配置开放记忆写入工具，不再提供读取工具", async () => {
  toolGroups = [{ name: "记忆", tools: ["Memory"] }, { name: "关闭记忆", tools: [] }];
  const event = { self_id: 1, user_id: 2, group_id: 3, isMaster: false };
  const schema = await getToolsSchema(event, "记忆");
  assert.deepEqual(schema.localTools.map((tool) => tool.name), ["Memory"]);
  assert.equal(schema.localTools[0].parameters.properties.userId, undefined);
  assert.deepEqual((await getToolsSchema(event, "关闭记忆")).localTools, []);
  assert.deepEqual(AVAILABLE_TOOL_OPTIONS.filter((option) => option.key === "Memory"), [{ key: "Memory", label: "记忆工具" }]);
});

test("OpenAI 关闭原生搜索时只注入工具组工具，个人JSON无工具，正常请求保留原生搜索", async () => {
  const event = { self_id: 1, user_id: 2, group_id: 3 };
  const invoke = (tools, context = {}) => getAI("test", event, [{ text: "输入" }], "整理指令", false, tools, [], context);
  assert.equal((await invoke("记忆", { disableNativeWebSearch: true })).text, "已完成");
  assert.deepEqual(payloads.at(-1).tools.map((tool) => tool.function.name), ["Memory"]);
  await invoke(false, { disableNativeWebSearch: true });
  assert.equal(payloads.at(-1).tools, undefined);
  await invoke(false);
  assert.equal(payloads.at(-1).tools[0].type, "web_search");
});

test("Gemini 关闭原生搜索时只注入工具组工具或无工具，正常请求保留Google Search", async () => {
  protocol = "gemini";
  const event = { self_id: 1, user_id: 2, group_id: 3 };
  const invoke = (tools, context = {}) => getAI("test", event, [{ text: "输入" }], "整理指令", false, tools, [], context);
  assert.equal((await invoke("记忆", { disableNativeWebSearch: true })).text, "已完成");
  assert.deepEqual(payloads.at(-1).config.tools[0].functionDeclarations.map((tool) => tool.name), ["Memory"]);
  assert.equal(payloads.at(-1).config.tools.some((tool) => tool.googleSearch), false);
  await invoke(false, { disableNativeWebSearch: true });
  assert.equal(payloads.at(-1).config.tools, undefined);
  await invoke(false);
  assert.deepEqual(payloads.at(-1).config.tools, [{ googleSearch: {} }]);
});
