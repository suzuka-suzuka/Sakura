import assert from "node:assert/strict";
import test, { after, mock } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 使用真实聊天循环、工具执行器和记忆文件，模型及向量请求均为本地替身。
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "sakura-memory-context-"));
const url = (relative) => new URL(relative, import.meta.url).href;
let aiHandler;
let failNextSearch = false;
const vectorCalls = [];
global.logger = { info() {}, warn() {}, error() {} };
mock.module(url("../lib/path.js"), { namedExports: {
  plugindata: fixture, pluginRoot: fileURLToPath(new URL("../", import.meta.url)),
} });
mock.module(url("../lib/setting.js"), { defaultExport: { getConfig: () => ({
  utilityModels: ["测试"], toolGroups: [{ name: "记忆", tools: ["Memory"] }, { name: "关闭记忆", tools: [] }],
}) } });
mock.module(url("../lib/AIUtils/getAI.js"), { namedExports: { getAI: async (...args) => {
  assert.ok(aiHandler, "测试禁止真实 AI 请求");
  return aiHandler(...args);
} } });
mock.module(url("../lib/AIUtils/MCPManager.js"), { namedExports: { mcpManager: {} } });
const toolSource = fs.readFileSync(new URL("../lib/AIUtils/tools/tools.js", import.meta.url), "utf8");
for (const [, name, file] of toolSource.matchAll(/import \{ (\w+) \} from "\.\/([^"/]+Tool\.js)";/g)) {
  if (name === "MemoryTool") continue;
  mock.module(url(`../lib/AIUtils/tools/${file}`), { namedExports: { [name]: class {
    name = name;
    function() { return { name, parameters: { type: "object", properties: {} } }; }
  } } });
}
mock.module(url("../lib/AIUtils/memoryVectorStore.js"), { namedExports: {
  memoryVectorStore: { search: async (query, targets, options) => {
    vectorCalls.push({ query, scopes: targets.map((target) => target.location.scopeKey), ...options });
    await new Promise((resolve) => setImmediate(resolve));
    if (failNextSearch) { failNextSearch = false; throw new Error("测试召回失败"); }
    return targets.flatMap((target) => target.document.memories.map((memory) => ({
      ...memory,
      scope: target.location.scope, scopeKey: target.location.scopeKey, title: target.location.title,
      score: /饮食|咖啡/.test(query) && /咖啡/.test(memory.content) ? 1 : 0,
    })).sort((a, b) => b.score - a.score).slice(0, options.maxResults)
      .filter((match) => options.includeLowScore || match.score >= 0.6));
  } },
} });

const memory = await import("../lib/AIUtils/memoryStore.js");
const { runAgentLoop } = await import("../lib/AIUtils/AgentRunner.js");
const { activeAiTasks } = await import("../lib/AIUtils/stopFlag.js");
const { withMemoryScope } = await import("../lib/AIUtils/memoryScope.js");
const { MemoryTool } = await import("../lib/AIUtils/tools/MemoryTool.js");
const event = (userId, groupId = 962001) => ({ self_id: 960001, user_id: userId, group_id: groupId });

// 摘要视为覆盖到当前 revision，避免注入时触发后台整理；空摘要模拟整理没产出摘要。
function seed(e, contents, summary = "已有成员摘要", scope = "user") {
  const location = memory.getMemoryLocation({ groupId: e.group_id, userId: e.user_id, scope });
  let document = memory.createEmptyMemoryDocument();
  for (const [index, content] of contents.entries()) {
    document = memory.appendMemory(document, { content, now: index + 1 }).document;
  }
  // 本组测试不触发摘要整理，只检查注入。
  document.summary = { text: summary, updatedAt: 1, sourceRevision: document.revision };
  memory.writeMemoryDocument(location.memoryFile, document);
  return { location, document };
}

function append(e, contents, scope = "user") {
  const location = memory.getMemoryLocation({ groupId: e.group_id, userId: e.user_id, scope });
  let document = memory.readMemoryDocument(location.memoryFile, { throwOnError: true });
  for (const content of contents) {
    document = memory.appendMemory(document, { content, now: 1000 + document.revision }).document;
  }
  memory.writeMemoryDocument(location.memoryFile, document);
}

const occurrences = (text, part) => text.split(part).length - 1;

async function injectedPrompt(e, query, options = {}) {
  let prompt;
  aiHandler = async (...args) => {
    prompt = args[3];
    return { text: "已完成" };
  };
  try {
    const result = await runAgentLoop({ e, route: "测试", queryParts: [{ text: query }],
      prompt: "角色提示词", toolGroup: "记忆", history: [], ...options });
    assert.equal(result.status, "completed");
    assert.equal(activeAiTasks.size, 0);
  } finally {
    aiHandler = undefined;
  }
  return prompt;
}

after(() => {
  assert.ok(path.resolve(fixture).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("未开启记忆工具时不注入个人或群记忆，也不请求向量", async () => {
  const e = event(961008, 962008);
  seed(e, Array.from({ length: 12 }, (_, i) => `群咖啡记忆${i}`), "群摘要", "group");
  seed(e, Array.from({ length: 12 }, (_, i) => `个人咖啡喜好${i}`), "个人摘要");
  const count = vectorCalls.length;
  assert.equal(await injectedPrompt(e, "饮食", { toolGroup: "关闭记忆" }), "角色提示词");
  assert.equal(vectorCalls.length, count);
});

test("不超过10条时个人和群记忆都只注入全部原文，不注入摘要，不请求向量", async () => {
  const e = event(961001);
  seed(e, ["不喝咖啡", "习惯早起"], "重视生活习惯");
  seed(e, ["本群每周五组织活动"], "群活动摘要", "group");
  const count = vectorCalls.length;
  const prompt = await injectedPrompt(e, "饮食");
  assert.match(prompt, /^角色提示词\n\n【长期记忆背景】/);
  assert.match(prompt, /【当前用户记忆】\n所属 QQ：961001（省略主语指此人）\n- 不喝咖啡\n- 习惯早起/);
  assert.match(prompt, /【当前群公共记忆】\n- 本群每周五组织活动/);
  assert.doesNotMatch(prompt, /重视生活习惯|群活动摘要|摘要：/);
  assert.equal(vectorCalls.length, count);
});

test("超过10条时个人和群记忆都注入摘要和召回条目，一次向量请求覆盖两份记忆", async () => {
  const e = event(961005, 962005);
  const { location: userLocation } = seed(e, ["个人细节：喜欢咖啡", ...Array.from({ length: 24 }, (_, i) => `个人细节${i}`)]);
  const { location: groupLocation } = seed(e, Array.from({ length: 12 }, (_, i) => i === 3 ? "本群咖啡活动" : `本群活动${i}`), "群活动摘要", "group");
  const count = vectorCalls.length;
  const prompt = await injectedPrompt(e, "饮食");
  assert.match(prompt, /【当前用户记忆】\n所属 QQ：961005（省略主语指此人）\n摘要：\n已有成员摘要\n与当前消息相关：\n- 个人细节：喜欢咖啡/);
  assert.match(prompt, /【当前群公共记忆】\n摘要：\n群活动摘要\n与当前消息相关：\n- 本群咖啡活动/);
  assert.doesNotMatch(prompt, /摘要之后新增|最近记录/);
  assert.equal(vectorCalls.length, count + 1);
  assert.deepEqual(vectorCalls.at(-1).scopes, [userLocation.scopeKey, groupLocation.scopeKey]);
  assert.equal(vectorCalls.at(-1).query, "饮食");
});

test("摘要之后新增的条目总会注入，且不与召回条目重复", async () => {
  const e = event(961002, 962002);
  seed(e, Array.from({ length: 25 }, (_, i) => `个人细节${i}结束`));
  append(e, ["以后叫我小夜", "最近开始喝咖啡"]);
  const prompt = await injectedPrompt(e, "饮食");
  assert.match(prompt, /摘要：\n已有成员摘要\n摘要之后新增：\n- 以后叫我小夜\n- 最近开始喝咖啡\n与当前消息相关：/);
  assert.equal(occurrences(prompt, "最近开始喝咖啡"), 1);
});

test("整理前的大量记忆没有摘要时注入最近10条和召回条目", async () => {
  const e = event(961004, null);
  seed(e, ["老家在河南", ...Array.from({ length: 24 }, (_, i) => `个人细节${i}结束`)], "");
  const prompt = await injectedPrompt(e, "饮食");
  assert.doesNotMatch(prompt, /摘要：/);
  assert.match(prompt, /最近记录：\n/);
  for (let i = 14; i < 24; i++) assert.equal(occurrences(prompt, `个人细节${i}结束`), 1);
});

test("召回失败或无查询文字时回退到最新10条，个人和群一致", async () => {
  const e = event(961006, 962006);
  seed(e, Array.from({ length: 25 }, (_, i) => `个人细节${i}结束`));
  seed(e, Array.from({ length: 12 }, (_, i) => `群记录${i}结束`), "群摘要", "group");
  for (const query of ["饮食", ""]) {
    const count = vectorCalls.length;
    failNextSearch = Boolean(query);
    const prompt = await injectedPrompt(e, query);
    assert.match(prompt, /已有成员摘要/);
    assert.match(prompt, /群摘要/);
    for (let i = 0; i < 15; i++) assert.ok(!prompt.includes(`个人细节${i}结束`));
    for (let i = 15; i < 25; i++) assert.ok(prompt.includes(`个人细节${i}结束`));
    assert.doesNotMatch(prompt, /群记录[01]结束/);
    for (let i = 2; i < 12; i++) assert.ok(prompt.includes(`群记录${i}结束`));
    assert.equal(vectorCalls.length, count + (query ? 1 : 0));
  }
});

test("没有记忆条目时不注入空背景，残留摘要也不注入", async () => {
  for (const summary of ["", "保留的个人摘要"]) {
    const e = event(961009, null);
    seed(e, [], summary);
    assert.equal(await injectedPrompt(e, "饮食"), "角色提示词");
  }
});

test("前缀角色仅注入自己的个人记忆，开关群上下文都不读取Mimic记忆", async () => {
  const e = event(961010, 962010);
  seed(e, ["拟态用户事实"], "拟态用户摘要");
  seed(e, Array.from({ length: 12 }, (_, i) => `拟态群事实${i}`), "拟态群摘要", "group");
  for (const source of ["chat:甲", "chat:乙"]) {
    withMemoryScope(source, () => seed(e, [`${source}个人事实`], `${source}个人摘要`));
  }
  const count = vectorCalls.length;
  for (const source of ["chat:甲", "chat:乙"]) {
    for (const groupContext of [false, true]) {
      const prompt = await injectedPrompt(e, "群活动", { memorySource: source, groupContext });
      assert.ok(prompt.includes(`- ${source}个人事实`));
      assert.doesNotMatch(prompt, /拟态|群事实|群摘要/);
      assert.ok(!prompt.includes(`${source === "chat:甲" ? "chat:乙" : "chat:甲"}个人事实`));
    }
  }
  assert.equal(vectorCalls.length, count);
});

test("并发工具调用按角色隔离，模型不能指定来源，前缀群记忆写入被后端拒绝", async () => {
  const e = event(961011, 962011);
  const tool = new MemoryTool();
  await Promise.all(["chat:甲", "chat:乙", "Mimic"].map((source) => withMemoryScope(source, async () => {
    await new Promise((resolve) => setImmediate(resolve));
    const schema = tool.function(e);
    assert.deepEqual(schema.parameters.properties.scope.enum, source === "Mimic" ? ["user", "group"] : ["user"]);
    assert.equal(schema.parameters.properties.source, undefined);
    const text = `${source}独立约定`;
    assert.match(await tool.func({ scope: "user", content: text, source: "Mimic", userId: "999999" }, e), /已写入/);
    await new Promise((resolve) => setImmediate(resolve));
    const location = memory.getMemoryLocation({ groupId: e.group_id, userId: e.user_id, scope: "user" });
    assert.deepEqual(memory.readMemoryDocument(location.memoryFile, { throwOnError: true }).memories.map((item) => item.content), [text]);
    if (source !== "Mimic") {
      assert.match(await tool.func({ scope: "group", content: "禁止的群约定", source: "Mimic" }, e), /不能保存群记忆/);
      assert.throws(() => memory.getMemoryLocation({ groupId: e.group_id, userId: e.user_id, scope: "group" }), /不能读写群记忆/);
    }
  })));
  const group = memory.getMemoryLocation({ groupId: e.group_id, scope: "group" });
  assert.equal(fs.existsSync(group.memoryFile), false);
  assert.deepEqual(tool.function(e).parameters.properties.scope.enum, ["user", "group"]);
});

test("摘要之后新增条目按 revision 差取末尾，整理期间新增的条目也算未整理", () => {
  let document = memory.createEmptyMemoryDocument();
  for (let i = 0; i < 12; i++) document = memory.appendMemory(document, { content: `事实${i}`, now: i + 1 }).document;
  assert.deepEqual(memory.getUnsummarizedMemories(document).length, 12);
  document.summary = { text: "摘要", updatedAt: 1, sourceRevision: 10 };
  assert.deepEqual(memory.getUnsummarizedMemories(document).map((item) => item.content), ["事实10", "事实11"]);
  document.summary.sourceRevision = 12;
  assert.deepEqual(memory.getUnsummarizedMemories(document), []);
  assert.equal(memory.MEMORY_MAINTENANCE_INTERVAL, 10);
});
