import assert from "node:assert/strict";
import test, { after, mock } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "sakura-memory-provider-"));
const url = (relative) => new URL(relative, import.meta.url).href;
global.logger = { info() {}, warn() {}, error() {} };
mock.module(url("../lib/path.js"), { namedExports: { plugindata: fixture, pluginRoot: fileURLToPath(new URL("../", import.meta.url)) } });
mock.module(url("../lib/setting.js"), { defaultExport: { getConfig: () => ({ toolGroups: [] }) } });
mock.module(url("../lib/AIUtils/GroupContext.js"), { namedExports: { buildGroupPrompt: async () => "" } });
mock.module(url("../lib/AIUtils/MCPManager.js"), { namedExports: { mcpManager: {} } });
// 无关工具用替身隔离，实际加载并验证工具注册器和 Memory 工具定义。
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
  formatRouteAttemptFailure: () => "测试请求失败",
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
const { getToolsSchema } = await import("../lib/AIUtils/tools/tools.js");
const { getAI } = await import("../lib/AIUtils/getAI.js");

after(() => {
  assert.ok(path.resolve(fixture).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("后台工具定义只含 Memory，目标成员参数不会污染普通聊天工具定义", async () => {
  const selection = { memoryOnly: true, memoryTargets: ["12345", "67890"] };
  const { localTools, allowedMcpServerIds } = await getToolsSchema({}, selection);
  assert.deepEqual(localTools.map((tool) => tool.name), ["Memory"]);
  assert.deepEqual(allowedMcpServerIds, []);
  assert.deepEqual(localTools[0].parameters.properties.userId.enum, selection.memoryTargets);
  const { MemoryTool } = await import("../lib/AIUtils/tools/MemoryTool.js");
  assert.equal(new MemoryTool().function().parameters.properties.userId, undefined);
  const empty = await getToolsSchema({}, { memoryOnly: true, memoryTargets: [] });
  assert.equal(empty.localTools[0].parameters.properties.userId.enum, undefined);
});

test("OpenAI 后台群任务只注入 Memory、个人 JSON 无工具，正常请求保留原生搜索", async () => {
  const event = { self_id: 1, user_id: 2, group_id: 3 };
  const invoke = (tools, context = {}) => getAI("test", event, [{ text: "输入" }], "整理指令", false, tools, [], context);
  assert.equal((await invoke({ memoryOnly: true, memoryTargets: ["12345"] }, { disableNativeWebSearch: true })).text, "已完成");
  assert.deepEqual(payloads.at(-1).tools.map((tool) => tool.function.name), ["Memory"]);
  await invoke(false, { disableNativeWebSearch: true });
  assert.equal(payloads.at(-1).tools, undefined);
  await invoke(false);
  assert.equal(payloads.at(-1).tools[0].type, "web_search");
});

test("Gemini 后台只注入 Memory 或无工具，正常请求保留 Google Search", async () => {
  protocol = "gemini";
  const event = { self_id: 1, user_id: 2, group_id: 3 };
  const invoke = (tools, context = {}) => getAI("test", event, [{ text: "输入" }], "整理指令", false, tools, [], context);
  assert.equal((await invoke({ memoryOnly: true, memoryTargets: ["12345"] }, { disableNativeWebSearch: true })).text, "已完成");
  assert.deepEqual(payloads.at(-1).config.tools[0].functionDeclarations.map((tool) => tool.name), ["Memory"]);
  assert.equal(payloads.at(-1).config.tools.some((tool) => tool.googleSearch), false);
  await invoke(false, { disableNativeWebSearch: true });
  assert.equal(payloads.at(-1).config.tools, undefined);
  await invoke(false);
  assert.deepEqual(payloads.at(-1).config.tools, [{ googleSearch: {} }]);
});
