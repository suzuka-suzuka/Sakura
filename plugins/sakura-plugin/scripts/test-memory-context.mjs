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
  utilityRoute: "测试", toolGroups: [{ name: "记忆", tools: ["Memory"] }],
}) } });
mock.module(url("../lib/AIUtils/getAI.js"), { namedExports: { getAI: async (...args) => {
  assert.ok(aiHandler, "测试禁止真实 AI 请求");
  return aiHandler(...args);
} } });
mock.module(url("../lib/AIUtils/MCPManager.js"), { namedExports: { mcpManager: {} } });
const toolSource = fs.readFileSync(new URL("../lib/AIUtils/tools/tools.js", import.meta.url), "utf8");
for (const [, name, file] of toolSource.matchAll(/import \{ (\w+) \} from "\.\/([^"/]+Tool\.js)";/g)) {
  if (["MemoryTool", "ReadUserMemoryTool"].includes(name)) continue;
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
const event = (userId, groupId = 962001) => ({ self_id: 960001, user_id: userId, group_id: groupId });

function seed(e, contents, summary = "已有成员摘要", scope = "user") {
  const location = memory.getMemoryLocation({ groupId: e.group_id, userId: e.user_id, scope });
  let document = memory.createEmptyMemoryDocument();
  for (const [index, content] of contents.entries()) {
    document = memory.appendMemory(document, { content, now: index + 1 }).document;
  }
  // 本组测试不触发摘要整理，只检查注入和按需查询。
  document.summary = { text: summary, updatedAt: 1, sourceRevision: document.revision };
  memory.writeMemoryDocument(location.memoryFile, document);
  return { location, document };
}

function call(qq, id = "查询") {
  return { name: "ReadUserMemory", id, args: { qq: String(qq) } };
}

function response(history) {
  assert.equal(history.at(-1).role, "function");
  return history.at(-1).parts[0].functionResponse.response;
}

async function runScenario(e, query, steps) {
  let step = 0;
  aiHandler = async (...args) => {
    assert.ok(step < steps.length, "模型调用次数超过测试步骤");
    return steps[step++](...args);
  };
  try {
    const result = await runAgentLoop({ e, route: "测试", queryParts: [{ text: query }],
      prompt: "角色提示词", toolGroup: "记忆", history: [] });
    assert.equal(result.status, "completed");
    assert.equal(step, steps.length);
    assert.equal(activeAiTasks.size, 0);
  } finally {
    aiHandler = undefined;
  }
}

after(() => {
  assert.ok(path.resolve(fixture).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("群聊个人记忆只注入摘要，工具按QQ读取全部记录，少量群公共记忆仍直接注入", async () => {
  const e = event(961001);
  seed(e, ["个人细节：不喝咖啡", "个人细节：习惯早起"], "小夜重视生活习惯");
  seed(e, ["本群每周五组织活动"], "群活动摘要", "group");
  const count = vectorCalls.length;
  await runScenario(e, "饮食", [
    async (...args) => {
      assert.match(args[3], /小夜重视生活习惯/);
      assert.match(args[3], /群活动摘要/);
      assert.match(args[3], /本群每周五组织活动/);
      assert.doesNotMatch(args[3], /个人细节/);
      assert.equal(vectorCalls.length, count);
      return { functionCalls: [call(e.user_id)] };
    },
    async (...args) => {
      const result = response(args[6]);
      assert.equal(result.summary, undefined);
      assert.deepEqual(result.memories.map((item) => item.content), ["个人细节：不喝咖啡", "个人细节：习惯早起"]);
      assert.equal(vectorCalls.length, count);
      return { text: "已完成" };
    },
  ]);
});

test("大量个人记忆也不自动检索，同一轮重复查询仍返回全部记录", async () => {
  const e = event(961002, 962002);
  seed(e, ["个人细节：不喝咖啡", ...Array.from({ length: 24 }, (_, i) => `个人细节${i}`)]);
  const count = vectorCalls.length;
  await runScenario(e, "饮食", [
    async (...args) => {
      assert.match(args[3], /已有成员摘要/);
      assert.doesNotMatch(args[3], /个人细节/);
      assert.equal(vectorCalls.length, count);
      return { functionCalls: [call(e.user_id, "首次")] };
    },
    async (...args) => {
      assert.equal(response(args[6]).memories.length, 25);
      return { functionCalls: [call(e.user_id, "再次")] };
    },
    async (...args) => {
      const result = response(args[6]);
      assert.equal(result.memories.length, 25);
      assert.deepEqual(Object.keys(result), ["qq", "groupId", "totalCount", "memories"]);
      assert.equal(vectorCalls.length, count);
      return { text: "已完成" };
    },
  ]);
});

test("私聊同样仅注入摘要，工具读取全部记录而不请求向量", async () => {
  const e = event(961003, null);
  const contents = ["私聊细节：不喝咖啡", ...Array.from({ length: 24 }, (_, i) => `私聊细节${i}`)];
  seed(e, contents, "私聊用户摘要");
  const count = vectorCalls.length;
  await runScenario(e, "饮食", [
    async (...args) => {
      assert.match(args[3], /私聊用户摘要/);
      assert.doesNotMatch(args[3], /私聊细节/);
      return { functionCalls: [call(e.user_id)] };
    },
    async (...args) => {
      assert.deepEqual(response(args[6]).memories.map((item) => item.content), contents);
      assert.equal(vectorCalls.length, count);
      return { text: "已完成" };
    },
  ]);
});

test("个人摘要为空时不回退注入原始记录，记录仍可通过工具读取", async () => {
  const e = event(961004, null);
  seed(e, ["个人细节：不喝咖啡"], "");
  const count = vectorCalls.length;
  await runScenario(e, "饮食", [
    async (...args) => {
      assert.equal(args[3], "角色提示词");
      assert.equal(vectorCalls.length, count);
      return { functionCalls: [call(e.user_id)] };
    },
    async (...args) => {
      assert.deepEqual(response(args[6]).memories.map((item) => item.content), ["个人细节：不喝咖啡"]);
      assert.equal(vectorCalls.length, count);
      return { text: "已完成" };
    },
  ]);
});

test("大量群公共记忆仍自动召回，向量目标仅包含群公共记忆", async () => {
  const e = event(961005, 962005);
  seed(e, Array.from({ length: 25 }, (_, i) => `个人细节咖啡${i}`));
  seed(e, Array.from({ length: 12 }, (_, i) => `本群咖啡活动${i}`), "群活动摘要", "group");
  const count = vectorCalls.length;
  await runScenario(e, "饮食", [async (...args) => {
    assert.match(args[3], /已有成员摘要/);
    assert.match(args[3], /群活动摘要/);
    assert.match(args[3], /本群咖啡活动/);
    assert.doesNotMatch(args[3], /个人细节/);
    assert.equal(vectorCalls.length, count + 1);
    assert.deepEqual(vectorCalls.at(-1).scopes, ["group:962005"]);
    return { text: "已完成" };
  }]);
});

test("群召回失败或无查询文字时只回退最新10条群记录，个人仍仅摘要", async () => {
  const e = event(961006, 962006);
  seed(e, Array.from({ length: 25 }, (_, i) => `个人细节${i}`));
  seed(e, Array.from({ length: 12 }, (_, i) => `群记录${i}结束`), "群摘要", "group");
  for (const query of ["饮食", ""]) {
    const count = vectorCalls.length;
    failNextSearch = Boolean(query);
    await runScenario(e, query, [async (...args) => {
      assert.match(args[3], /已有成员摘要/);
      assert.doesNotMatch(args[3], /个人细节|群记录[01]结束/);
      for (let i = 2; i < 12; i++) assert.ok(args[3].includes(`群记录${i}结束`));
      assert.equal(vectorCalls.length, count + (query ? 1 : 0));
      return { text: "已完成" };
    }]);
  }
});

test("只有个人摘要且无详细记录时仍注入摘要，查询明确无详细记录", async () => {
  const e = event(961007, null);
  seed(e, [], "保留的个人摘要");
  const count = vectorCalls.length;
  await runScenario(e, "饮食", [
    async (...args) => {
      assert.match(args[3], /保留的个人摘要/);
      return { functionCalls: [call(e.user_id)] };
    },
    async (...args) => {
      const result = response(args[6]);
      assert.deepEqual(result.memories, []);
      assert.equal(result.summary, undefined);
      assert.match(result.message, /暂无私聊记忆记录/);
      assert.equal(vectorCalls.length, count);
      return { text: "已完成" };
    },
  ]);
});
