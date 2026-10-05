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
  if (["MemoryTool", "ReadUserMemoryTool"].includes(name)) continue;
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
const { getToolsSchema, executeToolCalls, AVAILABLE_TOOL_OPTIONS } = await import("../lib/AIUtils/tools/tools.js");
const { getAI } = await import("../lib/AIUtils/getAI.js");
const memory = await import("../lib/AIUtils/memoryStore.js");

after(() => {
  assert.ok(path.resolve(fixture).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("后台只开放记忆读写工具，读取参数仅qq，写入目标不污染普通定义", async () => {
  const selection = { memoryOnly: true, memoryTargets: ["12345", "67890"] };
  const { localTools, allowedMcpServerIds } = await getToolsSchema({}, selection);
  assert.deepEqual(localTools.map((tool) => tool.name), ["Memory", "ReadUserMemory"]);
  assert.deepEqual(allowedMcpServerIds, []);
  assert.deepEqual(localTools[0].parameters.properties.userId.enum, selection.memoryTargets);
  assert.deepEqual(Object.keys(localTools[1].parameters.properties), ["qq"]);
  assert.deepEqual(localTools[1].parameters.required, ["qq"]);
  assert.equal(localTools[1].parameters.additionalProperties, false);
  assert.ok(localTools[1].description.length < 100);
  assert.doesNotMatch(localTools[1].description, /cacheHit|alreadyInContext|fallback|mode/);
  const { MemoryTool } = await import("../lib/AIUtils/tools/MemoryTool.js");
  assert.equal(new MemoryTool().function().parameters.properties.userId, undefined);
  const empty = await getToolsSchema({}, { memoryOnly: true, memoryTargets: [] });
  assert.equal(empty.localTools[0].parameters.properties.userId.enum, undefined);
});

test("普通聊天复用Memory配置开放读写两种工具，并通过真实执行器返回查询结果", async () => {
  toolGroups = [{ name: "记忆", tools: ["Memory"] }, { name: "关闭记忆", tools: [] }];
  const event = { self_id: 1, user_id: 2, group_id: 3, isMaster: false };
  const schema = await getToolsSchema(event, "记忆");
  assert.deepEqual(schema.localTools.map((tool) => tool.name), ["Memory", "ReadUserMemory"]);
  assert.equal(schema.localTools[0].parameters.properties.userId, undefined);
  assert.deepEqual((await getToolsSchema(event, "关闭记忆")).localTools, []);
  assert.deepEqual(AVAILABLE_TOOL_OPTIONS.filter((option) => ["Memory", "ReadUserMemory"].includes(option.key)), [{ key: "Memory", label: "记忆工具" }]);
  const location = memory.getMemoryLocation({ groupId: 3, userId: 4 });
  memory.writeMemoryDocument(location.memoryFile, memory.appendMemory(memory.createEmptyMemoryDocument(), { content: "成员喜欢茶" }).document);
  const result = await executeToolCalls(event, [{ id: "read-normal", name: "ReadUserMemory", args: { qq: "4" } }], null, "记忆");
  const response = result.historyContents[0].parts[0].functionResponse;
  assert.equal(response.id, "read-normal");
  assert.equal(response.name, "ReadUserMemory");
  assert.equal(response.response.qq, "4");
  assert.equal(response.response.groupId, "3");
  assert.equal(response.response.totalCount, 1);
  assert.equal(response.response.summary, undefined);
  assert.deepEqual(response.response.memories.map((item) => item.content), ["成员喜欢茶"]);
  assert.deepEqual(result.queryParts, []);
});

test("OpenAI 后台群任务只注入记忆读写工具，个人JSON无工具，正常请求保留原生搜索", async () => {
  const event = { self_id: 1, user_id: 2, group_id: 3 };
  const invoke = (tools, context = {}) => getAI("test", event, [{ text: "输入" }], "整理指令", false, tools, [], context);
  assert.equal((await invoke({ memoryOnly: true, memoryTargets: ["12345"] }, { disableNativeWebSearch: true })).text, "已完成");
  assert.deepEqual(payloads.at(-1).tools.map((tool) => tool.function.name), ["Memory", "ReadUserMemory"]);
  const readDefinition = payloads.at(-1).tools[1].function;
  assert.deepEqual(readDefinition.parameters.required, ["qq"]);
  assert.deepEqual(Object.keys(readDefinition.parameters.properties), ["qq"]);
  assert.equal(readDefinition.parameters.properties.qq.type, "string");
  await invoke(false, { disableNativeWebSearch: true });
  assert.equal(payloads.at(-1).tools, undefined);
  await invoke(false);
  assert.equal(payloads.at(-1).tools[0].type, "web_search");
});

test("Gemini 后台只注入记忆读写工具或无工具，正常请求保留Google Search", async () => {
  protocol = "gemini";
  const event = { self_id: 1, user_id: 2, group_id: 3 };
  const invoke = (tools, context = {}) => getAI("test", event, [{ text: "输入" }], "整理指令", false, tools, [], context);
  assert.equal((await invoke({ memoryOnly: true, memoryTargets: ["12345"] }, { disableNativeWebSearch: true })).text, "已完成");
  assert.deepEqual(payloads.at(-1).config.tools[0].functionDeclarations.map((tool) => tool.name), ["Memory", "ReadUserMemory"]);
  const readDefinition = payloads.at(-1).config.tools[0].functionDeclarations[1];
  assert.deepEqual(readDefinition.parameters.required, ["qq"]);
  assert.deepEqual(Object.keys(readDefinition.parameters.properties), ["qq"]);
  assert.equal(readDefinition.parameters.properties.qq.type, "STRING");
  assert.equal(payloads.at(-1).config.tools.some((tool) => tool.googleSearch), false);
  await invoke(false, { disableNativeWebSearch: true });
  assert.equal(payloads.at(-1).config.tools, undefined);
  await invoke(false);
  assert.deepEqual(payloads.at(-1).config.tools, [{ googleSearch: {} }]);
});
