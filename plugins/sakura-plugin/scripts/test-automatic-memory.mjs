import assert from "node:assert/strict";
import test, { before, after, mock } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import Redis from "ioredis";
import YAML from "js-yaml";

// 使用独立 Redis 进程和临时记忆目录，所有 AI 请求均为本地替身。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "sakura-automatic-memory-"));
let redis;
let server;
let currentSelfId = 910001;
let memoryConfig = {};
let toolGroups = [{ name: "记忆", tools: ["Memory"] }, { name: "关闭记忆", tools: [] }];
let aiHandler;
let agentStatus = "completed";
const agentHistoryLengths = [];
const agentToolGroups = [];
const aiCalls = [];
const forwardCalls = [];
let forwardError;
global.logger = { info() {}, warn() {}, error() {} };
global.plugin = class { constructor(options) { Object.assign(this, options); } };
global.Cron = (_, handler) => handler;
global.OnEvent = (...args) => args.at(-1);
const moduleUrl = (relative) => new URL(relative, import.meta.url).href;
mock.module(moduleUrl("../lib/path.js"), { namedExports: { plugindata: path.join(fixture, "data") } });
mock.module(moduleUrl("../lib/setting.js"), { defaultExport: {
  getConfig(name) {
    if (name === "Memory") return memoryConfig;
    if (name === "mimic") return { toolGroup: "记忆" };
    return { utilityRoute: "test-utility", toolGroups };
  },
} });
mock.module(moduleUrl("../../../src/utils/redis.js"), { namedExports: { getRedis: () => redis } });
mock.module(moduleUrl("../../../src/api/client.js"), { namedExports: {
  getCurrentBotSelfId: () => currentSelfId,
  getBot: (selfId) => selfId ? {
    self_id: selfId,
    sendForwardMsg: async (payload) => {
      forwardCalls.push({ selfId, groupId: payload.group_id, nodes: structuredClone(payload.messages),
        source: payload.source, news: structuredClone(payload.news) });
      if (forwardError) throw forwardError;
      return { message_id: "测试转发消息" };
    },
  } : null,
} });
mock.module(moduleUrl("../lib/AIUtils/getAI.js"), { namedExports: { getAI: async (...args) => {
  aiCalls.push(args);
  if (aiHandler) return aiHandler(...args);
  const text = args[2]?.[0]?.text || "";
  if (text.includes("记忆数据：")) {
    const memories = JSON.parse(text.split("记忆数据：")[1]);
    return { text: JSON.stringify({ memories: memories.map((item) => ({ sourceIds: [item.id], content: item.content })), discarded: [], summary: "测试摘要" }) };
  }
  throw new Error("测试禁止真实 AI 请求");
} } });
// 隔离外部向量请求；个人记忆读取不应使用向量。
mock.module(moduleUrl("../lib/AIUtils/embeddingProvider.js"), { namedExports: {
  DEFAULT_EMBEDDING_VERSION: "test-memory-v1",
  generateTextEmbedding: async () => { throw new Error("读取个人记忆不应请求向量"); },
} });

mock.module(moduleUrl("../lib/AIUtils/AgentRunner.js"), { namedExports: { runAgentLoop: async ({ history, queryParts, toolGroup }) => {
  agentHistoryLengths.push(history.length);
  agentToolGroups.push(toolGroup);
  history.push({ role: "user", parts: queryParts }, { role: "model", parts: [{ text: "正常回复" }] });
  return { status: agentStatus, history, finalText: "正常回复" };
} } });
mock.module(moduleUrl("../lib/AIUtils/tools/tools.js"), { namedExports: {
  resolveToolConfirmation() {},
  toolGroupHasTool: (name, key) => Boolean(toolGroups.find((group) => group.name === name)?.tools.includes(key)),
} });
mock.module(moduleUrl("../lib/AIUtils/messaging.js"), { namedExports: {
  getQuoteContent: async () => "", splitAndReplyMessages: async () => {}, parseAtMessage: (text) => text,
} });
mock.module(moduleUrl("../lib/AIUtils/naiChatDraw.js"), { namedExports: { checkForNaiTags: async (text) => text } });
mock.module(moduleUrl("../lib/utils.js"), { namedExports: {
  randomReact: async () => {}, getImg: async () => [],
  smartReplyMsg: async (event, text, options = {}) => options.textReplyFn ? options.textReplyFn(text) : event.reply?.(text),
} });

const memory = await import("../lib/AIUtils/memoryStore.js");
const { storeMemories } = await import("../lib/AIUtils/memoryWriter.js");
const { MemoryTool } = await import("../lib/AIUtils/tools/MemoryTool.js");
const { ReadUserMemoryTool } = await import("../lib/AIUtils/tools/ReadUserMemoryTool.js");
const automatic = await import("../lib/AIUtils/automaticMemory.js");
const mimic = await import("../lib/AIUtils/mimicHistory.js");
const historyStore = await import("../lib/AIUtils/ConversationHistory.js");
const messages = await import("../lib/AIUtils/groupMessageStore.js");
const { AutomaticMemory } = await import("../apps/AutomaticMemory.js");
const { AIChat } = await import("../apps/chat.js");
const { Mimic } = await import("../apps/Mimic.js");
const tool = new MemoryTool();
const readTool = new ReadUserMemoryTool();
const e = (userId, groupId = 920001) => ({ self_id: 910001, group_id: groupId, user_id: userId, sender: { nickname: `成员${userId}` } });
const conversation = (text = "我希望被称为小夜") => [
  { role: "user", parts: [{ text }] }, { role: "model", parts: [{ text: "好的" }] },
];
const document = (event, scope = "user") => memory.readMemoryDocument(memory.getMemoryLocation({ groupId: event.group_id, userId: event.user_id, scope }).memoryFile, { throwOnError: true });

before(async () => {
  const executable = process.env.SAKURA_TEST_REDIS_SERVER || YAML.load(fs.readFileSync(path.join(root, "config/config.yaml"), "utf8")).redis.execPath;
  assert.ok(executable && fs.existsSync(executable), "需要本机 Redis 可执行文件或 SAKURA_TEST_REDIS_SERVER");
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  server = spawn(executable, ["--bind", "127.0.0.1", "--port", String(port), "--save", "", "--appendonly", "no", "--dir", "."], { cwd: fixture, windowsHide: true, stdio: "ignore" });
  redis = new Redis({ host: "127.0.0.1", port, retryStrategy: (count) => count < 50 ? 100 : null, maxRetriesPerRequest: 50, connectTimeout: 1000 });
  redis.on("error", () => {});
  assert.equal(await redis.ping(), "PONG");
});

after(async () => {
  if (redis?.status === "ready") await redis.shutdown("NOSAVE").catch(() => {});
  redis?.disconnect();
  if (server && server.exitCode === null) server.kill();
  assert.ok(path.resolve(fixture).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("工具与 JSON 共用新增计数，第10条才整理，重复和空列表不计数", async () => {
  const event = e(930001);
  const first = await storeMemories({ e: event, scope: "user", contents: Array.from({ length: 9 }, (_, index) => `稳定事实${index}`) });
  assert.equal(first.maintenanceScheduled, false);
  assert.equal(document(event).revision, 9);
  const result = await tool.func({ scope: "user", content: "第十条稳定事实" }, event);
  assert.match(result, /后台整理/);
  for (let attempt = 0; document(event).summary.sourceRevision < 10 && attempt < 50; attempt++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document(event).summary.sourceRevision, 10);
  assert.equal(document(event).summary.text, "测试摘要");
  const count = aiCalls.length;
  assert.match(await tool.func({ scope: "user", content: "第十条稳定事实" }, event), /已存在/);
  await storeMemories({ e: event, scope: "user", contents: [] });
  assert.equal(document(event).revision, 10);
  assert.equal(aiCalls.length, count);
});

test("批量和并发写入不重复计数、不丢记忆", async () => {
  const event = e(930002);
  await Promise.all([
    storeMemories({ e: event, scope: "user", contents: ["事实甲", "事实甲", "事实乙"] }),
    storeMemories({ e: event, scope: "user", contents: ["事实乙", "事实丙"] }),
  ]);
  assert.equal(document(event).revision, 3);
  assert.equal(document(event).memories.length, 3);
});

test("查询其他成员只读取当前群个人记忆，参数不能指定其他群或作用域", async () => {
  const caller = e(940101, 924101);
  const target = e(940102, 924101);
  for (const [event, scope, content] of [
    [target, "user", "当前群成员的喜好"],
    [caller, "user", "调用者的个人信息"],
    [e(target.user_id, 920101), "user", "另一个群的个人信息"],
    [e(target.user_id, null), "user", "成员的私聊信息"],
    [target, "group", "本群公共规则"],
  ]) await storeMemories({ e: event, scope, contents: [content] });
  const result = await readTool.func({ qq: String(target.user_id), groupId: "920101", scope: "group", userId: String(caller.user_id) }, caller);
  assert.deepEqual(result, ["当前群成员的喜好"]);
});

test("按QQ只返回全部记忆文字数组，不附元数据、不写文件、不计数、不整理", async () => {
  const event = e(940103);
  const location = memory.getMemoryLocation({ groupId: event.group_id, userId: event.user_id });
  let data = memory.createEmptyMemoryDocument();
  for (let index = 0; index < 25; index++) {
    data = memory.appendMemory(data, { content: `事实${index}`, now: index + 1 }).document;
  }
  data.memories[0].updatedAt = 999;
  data.summary = { text: "已整理的成员摘要", updatedAt: 10, sourceRevision: 5 };
  memory.writeMemoryDocument(location.memoryFile, data);
  const before = fs.readFileSync(location.memoryFile, "utf8");
  const count = aiCalls.length;
  const result = await readTool.func({ qq: String(event.user_id) }, e(940101));
  assert.deepEqual(result, data.memories.map((item) => item.content));
  assert.equal(fs.readFileSync(location.memoryFile, "utf8"), before);
  assert.equal(aiCalls.length, count);
  assert.equal(document(event).revision, 25);
  assert.equal(document(event).summary.sourceRevision, 5);
});

test("暂无记忆返回空数组且不创建文件，拒绝非法QQ与缺少对话信息", async () => {
  const event = e(940104);
  const location = memory.getMemoryLocation({ groupId: event.group_id, userId: event.user_id });
  const result = await readTool.func({ qq: String(event.user_id) }, e(940101));
  assert.deepEqual(result, []);
  assert.equal(fs.existsSync(location.memoryFile), false);
  for (const qq of [undefined, null, 940104, "../940104", "", " 940104", "940104 "]) {
    assert.match((await readTool.func({ qq }, event)).error, /QQ号/);
  }
  assert.match((await readTool.func({ qq: "940104" }, null)).error, /对话信息/);
});

test("私聊可查本人记忆，不能读取其他人的私聊记忆", async () => {
  const event = e(940105, null);
  await storeMemories({ e: event, scope: "user", contents: ["本人的私聊信息"] });
  await storeMemories({ e: e(940106, null), scope: "user", contents: ["其他人的私聊信息"] });
  const result = await readTool.func({ qq: String(event.user_id) }, event);
  assert.deepEqual(result, ["本人的私聊信息"]);
  assert.match((await readTool.func({ qq: "940106", groupId: "920001" }, event)).error, /只能查询当前用户/);
  assert.deepEqual(await readTool.func({ qq: "940107" }, e(940107, null)), []);
});

test("损坏的记忆文件报告查询失败，不当作空记忆或覆盖原文件", async () => {
  const event = e(940108);
  const location = memory.getMemoryLocation({ groupId: event.group_id, userId: event.user_id });
  fs.mkdirSync(path.dirname(location.memoryFile), { recursive: true });
  const broken = "{损坏的记忆";
  fs.writeFileSync(location.memoryFile, broken, "utf8");
  const result = await readTool.func({ qq: String(event.user_id) }, e(940101));
  assert.match(result.error, /记忆查询失败/);
  assert.equal(result.totalCount, undefined);
  assert.equal(fs.readFileSync(location.memoryFile, "utf8"), broken);
});

async function append(groupId, count, endTime, offset = 0, { userId = 930003, senderName = "小夜" } = {}) {
  for (let index = 0; index < count; index++) {
    await messages.appendGroupMessage({ post_type: "message", message_type: "group", self_id: currentSelfId, group_id: groupId,
      user_id: userId, message_id: `${groupId}-${offset + index}`, time: endTime - count + index,
      sender: { user_id: userId, nickname: senderName }, message: [{ type: ["image", "face", "record", "text"][index % 4], data: { text: `消息${offset + index}`, id: 1 } }],
    }, { redis });
  }
}

test("一小时内文字、图片、表情与语音合计满100条，取最新100条且不补旧记录", async () => {
  const endTime = Math.floor(Date.now() / 1000);
  await append(920003, 99, endTime);
  await append(920003, 5, endTime - 3601, 1000);
  let records = await messages.getGroupMemoryMessages({ selfId: currentSelfId, groupId: 920003, startTime: endTime - 3600, endTime, redis });
  assert.equal(records.length, 99);
  assert.ok(records.some((record) => record.content === "[图片]"));
  assert.ok(records.some((record) => record.content === "[表情:1]"));
  assert.ok(records.some((record) => record.content === "[语音]"));
  let requested = false;
  assert.equal(await automatic.collectGroupMemories(e(930003, 920003), records, { aiRequest: () => { requested = true; } }), false);
  assert.equal(requested, false);
  await append(920003, 8, endTime + 8, 2000);
  records = await messages.getGroupMemoryMessages({ selfId: currentSelfId, groupId: 920003, startTime: endTime - 3600, endTime: endTime + 8, redis });
  assert.equal(records.length, 100);
  assert.equal(records.at(-1).messageId, "920003-2007");
  assert.ok(records.every((record) => record.time >= endTime - 3600));
});

test("群任务先查询个人记忆再写入，正确回传工具名和ID，仍限制个人写入目标", async () => {
  const event = e(910001, 920004);
  const records = Array.from({ length: 100 }, (_, index) => ({ messageId: String(index), userId: "930004", senderName: "小夜", content: "聊天", time: index, isBot: false }));
  let round = 0;
  const original = structuredClone(records);
  const addedMemories = [];
  const success = await automatic.collectGroupMemories(event, records, { addedMemories, aiRequest: async (...args) => {
    assert.equal(args[4], false);
    assert.deepEqual(args[5], { memoryOnly: true, memoryTargets: ["930004"] });
    assert.equal(args[7].disableNativeWebSearch, true);
    assert.match(args[3], /先调用 ReadUserMemory，qq 填该成员的 QQ/);
    assert.doesNotMatch(args[3], /query/);
    if (round++ === 0) return { text: "", functionCalls: [
      { id: "read-user", name: "ReadUserMemory", args: { qq: "930004" } },
    ] };
    assert.equal(args[6].at(-1).role, "function");
    if (round === 2) {
      const { functionResponse } = args[6].at(-1).parts[0];
      assert.equal(functionResponse.name, "ReadUserMemory");
      assert.equal(functionResponse.id, "read-user");
      assert.deepEqual(functionResponse.response, []);
      assert.equal(addedMemories.length, 0);
      return { text: "", functionCalls: [
        { name: "Memory", args: { scope: "group", content: "本群每周六活动" } },
        { name: "Memory", args: { scope: "user", userId: "930004", content: "用户希望被称为小夜" } },
      ] };
    }
    assert.deepEqual(args[6].at(-1).parts.map((part) => part.functionResponse.name), ["Memory", "Memory"]);
    return { text: "已完成" };
  } });
  assert.equal(success, true);
  assert.equal(document(event, "group").memories[0].content, "本群每周六活动");
  assert.equal(document(e(930004, 920004)).memories[0].content, "用户希望被称为小夜");
  assert.equal(document(event).memories.length, 0);
  assert.equal(addedMemories.length, 2);
  assert.deepEqual(records, original);
  assert.match(await tool.func({ scope: "user", content: "错误目标", userId: "999999" }, event, { memoryTargets: ["930004"] }), /发送者 QQ/);
  await assert.rejects(automatic.collectGroupMemories(event, records, { aiRequest: async () => ({ functionCalls: [{ name: "RunCommand", args: {} }] }) }), /只允许/);
});

test("个人20分钟空闲触发，新对话重新计时，旧完成回调不能覆盖新任务", async () => {
  const event = e(930005);
  const now = Date.now();
  const delay = automatic.PERSONAL_MEMORY_DELAY_MS;
  assert.equal(delay, 20 * 60 * 1000);
  assert.equal(delay, mimic.MIMIC_HISTORY_TTL_SECONDS * 1000);
  const first = await automatic.beginPersonalMemory(event, "Mimic", { redis, now });
  await automatic.finishPersonalMemory(first, conversation(), { redis, now });
  let calls = 0;
  await automatic.runDuePersonalMemories(event.self_id, { redis, now: now + 600001, aiRequest: () => { calls++; } });
  await automatic.runDuePersonalMemories(event.self_id, { redis, now: now + delay - 1, aiRequest: () => { calls++; } });
  assert.equal(calls, 0);
  const renewedAt = now + delay - 60000;
  const second = await automatic.beginPersonalMemory(event, "Mimic", { redis, now: renewedAt });
  assert.equal(await automatic.finishPersonalMemory(first, conversation("旧结果"), { redis, now }), false);
  const input = conversation("我喜欢简洁的界面");
  input[0].parts.push({ inlineData: { data: "图片" } });
  input.push({ role: "function", parts: [{ functionResponse: { name: "test" } }] });
  await automatic.finishPersonalMemory(second, input, { redis, now: renewedAt });
  await automatic.runDuePersonalMemories(event.self_id, { redis, now: now + delay + 1, aiRequest: () => { calls++; } });
  assert.equal(calls, 0);
  await automatic.runDuePersonalMemories(event.self_id, { redis, now: renewedAt + delay + 1, aiRequest: async (...args) => {
    calls++;
    assert.equal(args[4], false);
    assert.equal(args[5], false);
    assert.equal(args[7].disableNativeWebSearch, true);
    assert.deepEqual(args[6], [...conversation(), ...conversation("我喜欢简洁的界面")]);
    args[6].push({ role: "user", parts: [{ text: "后台副本" }] });
    return { text: '{"memories":[{"content":"用户喜欢简洁的界面"}]}' };
  } });
  assert.equal(calls, 1);
  assert.equal(document(event).memories[0].content, "用户喜欢简洁的界面");
  assert.equal(document(event, "group").memories.length, 0);
  assert.equal(input.length, 3);
  assert.equal(await redis.hget(automatic.getPersonalMemoryKeys(event.self_id).jobs, second.id), null);
});

test("提取期间继续聊天，旧结果不写入、不删除新任务", async () => {
  const event = e(930006);
  const now = Date.now();
  const handle = await automatic.beginPersonalMemory(event, "Mimic", { redis, now });
  await mimic.saveMimicHistory(event, conversation(), { redis, memoryTask: handle });
  await automatic.finishPersonalMemory(handle, conversation(), { redis, now });
  let newer;
  const dueAt = now + automatic.PERSONAL_MEMORY_DELAY_MS + 1;
  const newerHistory = [...conversation(), ...conversation("新的对话")];
  await automatic.runDuePersonalMemories(event.self_id, { redis, now: dueAt, aiRequest: async () => {
    newer = await automatic.beginPersonalMemory(event, "Mimic", { redis, now: dueAt });
    await mimic.saveMimicHistory(event, newerHistory, { redis, memoryTask: newer });
    await automatic.finishPersonalMemory(newer, newerHistory, { redis, now: dueAt });
    return { text: '{"memories":[{"content":"过期提取结果"}]}' };
  } });
  assert.equal(document(event).memories.length, 0);
  const job = JSON.parse(await redis.hget(automatic.getPersonalMemoryKeys(event.self_id).jobs, handle.id));
  assert.equal(job.token, newer.token);
  assert.deepEqual(await mimic.loadMimicHistory(event, { redis }), newerHistory);
  assert.equal(await mimic.saveMimicHistory(event, conversation("过期聊天回调"), { redis, memoryTask: handle }), false);
  assert.deepEqual(await mimic.loadMimicHistory(event, { redis }), newerHistory);
  await automatic.cancelPersonalMemory(event, "Mimic", { redis });
  await mimic.clearMimicHistory(event, { redis });
});

test("个人格式错误保留任务并退避，空数组成功完成且不增加计数", async () => {
  const event = e(930007);
  const now = Date.now();
  const handle = await automatic.beginPersonalMemory(event, "Mimic", { redis, now });
  await automatic.finishPersonalMemory(handle, conversation(), { redis, now });
  const dueAt = now + automatic.PERSONAL_MEMORY_DELAY_MS + 1;
  await automatic.runDuePersonalMemories(event.self_id, { redis, now: dueAt, aiRequest: async () => ({ text: '{"memories":[{"content":"不允许", "scope":"group"}]}' }) });
  const keys = automatic.getPersonalMemoryKeys(event.self_id);
  const job = JSON.parse(await redis.hget(keys.jobs, handle.id));
  assert.equal(job.attempts, 1);
  assert.ok(job.dueAt > dueAt);
  assert.equal(document(event).revision, 0);
  await automatic.runDuePersonalMemories(event.self_id, { redis, now: job.dueAt + 1, aiRequest: async () => ({ text: '{"memories":[]}' }) });
  assert.equal(await redis.hget(keys.jobs, handle.id), null);
  assert.equal(document(event).revision, 0);
  assert.throws(() => automatic.parsePersonalMemoryResponse('{"memories":[{"content":"事实", "userId":"别的用户"}]}'));
});

test("失败拟态保留清理任务但不提取记忆，用户、群和账号分别计时", async () => {
  const event = e(930008);
  const first = await automatic.beginPersonalMemory(event, "Mimic", { redis });
  await automatic.finishPersonalMemory(first, null, { redis });
  const job = JSON.parse(await redis.hget(automatic.getPersonalMemoryKeys(event.self_id).jobs, first.id));
  assert.equal(job.busy, false);
  assert.deepEqual(Object.values(job.history), []);
  await automatic.runDuePersonalMemories(event.self_id, { redis, now: job.dueAt + 1,
    aiRequest: async () => { throw new Error("失败拟态对话不应提取记忆"); },
  });
  assert.equal(await redis.hget(automatic.getPersonalMemoryKeys(event.self_id).jobs, first.id), null);
  assert.notEqual(automatic.getPersonalMemoryJobId(event, "Mimic"), automatic.getPersonalMemoryJobId(e(930009), "Mimic"));
  assert.notEqual(automatic.getPersonalMemoryJobId(event, "Mimic"), automatic.getPersonalMemoryJobId(e(930008, 920009), "Mimic"));
  assert.notDeepEqual(automatic.getPersonalMemoryKeys(910001), automatic.getPersonalMemoryKeys(910002));
});

test("未处理会话合并去除上下文重叠，历史裁剪不会丢掉早先事实", () => {
  const first = conversation("第一轮事实");
  const second = conversation("第二轮事实");
  const third = conversation("第三轮事实");
  assert.deepEqual(automatic.mergeMemoryConversation(first, [...first, ...second]), [...first, ...second]);
  assert.deepEqual(automatic.mergeMemoryConversation([...first, ...second], [...second, ...third]), [...first, ...second, ...third]);
  assert.deepEqual(automatic.mergeMemoryConversation(first, second), [...first, ...second]);
});

test("Mimic 不按轮数裁剪，未登记流程时仍以20分钟 TTL 兜底，后台读取不续期", async () => {
  const event = e(930010);
  const input = Array.from({ length: 50 }, (_, index) => conversation(`第${index}轮`)).flat();
  await mimic.saveMimicHistory(event, input, { redis });
  assert.equal((await mimic.loadMimicHistory(event, { redis })).length, 100);
  const key = mimic.getMimicHistoryKey(event);
  assert.ok(await redis.ttl(key) >= 1199);
  await redis.expire(key, 5);
  await mimic.loadMimicHistory(event, { redis });
  assert.ok(await redis.ttl(key) <= 5);
  await mimic.touchMimicHistory(event, { redis });
  assert.ok(await redis.ttl(key) >= 1199);
  await redis.pexpire(key, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await mimic.loadMimicHistory(event, { redis }), []);
});

test("拟态提取或写入失败时保留历史和任务，成功写入后才清空", async () => {
  const event = e(930020);
  const now = Date.now();
  const handle = await automatic.beginPersonalMemory(event, "Mimic", { redis, now });
  const input = conversation("我喜欢安静的环境");
  await mimic.saveMimicHistory(event, input, { redis, memoryTask: handle });
  await automatic.finishPersonalMemory(handle, input, { redis, now });
  const keys = automatic.getPersonalMemoryKeys(event.self_id);
  const key = mimic.getMimicHistoryKey(event);
  assert.equal(await redis.ttl(key), -1);
  assert.equal(await redis.ttl(keys.jobs), -1);
  let requested = 0;
  await automatic.runDuePersonalMemories(event.self_id, { redis, now: now + automatic.PERSONAL_MEMORY_DELAY_MS - 1, aiRequest: () => { requested++; } });
  assert.equal(requested, 0);
  await automatic.runDuePersonalMemories(event.self_id, { redis, now: now + automatic.PERSONAL_MEMORY_DELAY_MS + 1, aiRequest: async () => { throw new Error("模拟网络失败"); } });
  let job = JSON.parse(await redis.hget(keys.jobs, handle.id));
  assert.equal(job.attempts, 1);
  assert.deepEqual(await mimic.loadMimicHistory(event, { redis }), input);
  const result = { text: '{"memories":[{"content":"用户喜欢安静的环境"}]}' };
  await automatic.runDuePersonalMemories(event.self_id, { redis, now: job.dueAt + 1,
    aiRequest: async () => result, store: async () => { throw new Error("模拟磁盘写入失败"); },
  });
  job = JSON.parse(await redis.hget(keys.jobs, handle.id));
  assert.equal(job.attempts, 2);
  assert.deepEqual(await mimic.loadMimicHistory(event, { redis }), input);
  await automatic.runDuePersonalMemories(event.self_id, { redis, now: job.dueAt + 1, aiRequest: async () => result,
    store: async (...args) => {
      assert.equal(await redis.exists(key), 1);
      const stored = await storeMemories(...args);
      assert.equal(document(event).memories[0].content, "用户喜欢安静的环境");
      assert.equal(await redis.exists(key), 1, "记忆写入完成之前不能删历史");
      return stored;
    },
  });
  assert.equal(await redis.exists(key), 0);
  assert.equal(await redis.hget(keys.jobs, handle.id), null);
  assert.equal(await redis.zscore(keys.due, handle.id), null);
});

test("拟态没有可记信息也完成流程，成功返回空数组后才删历史", async () => {
  const event = e(930021);
  const now = Date.now();
  const handle = await automatic.beginPersonalMemory(event, "Mimic", { redis, now });
  await mimic.saveMimicHistory(event, conversation(), { redis, memoryTask: handle });
  await automatic.finishPersonalMemory(handle, conversation(), { redis, now });
  await automatic.runDuePersonalMemories(event.self_id, { redis, now: now + automatic.PERSONAL_MEMORY_DELAY_MS + 1,
    aiRequest: async () => {
      assert.equal(await redis.exists(mimic.getMimicHistoryKey(event)), 1);
      return { text: '{"memories":[]}' };
    },
  });
  assert.deepEqual(await mimic.loadMimicHistory(event, { redis }), []);
  assert.equal(document(event).revision, 0);
});

test("回复耗时超过20分钟时保持处理中，空闲计时从真正结束后开始", async (context) => {
  const event = e(930026);
  const now = Date.now();
  context.mock.timers.enable({ apis: ["setInterval", "Date"], now });
  const handle = await automatic.beginPersonalMemory(event, "Mimic", { redis });
  await mimic.saveMimicHistory(event, conversation(), { redis, memoryTask: handle });
  context.mock.timers.tick(automatic.PERSONAL_MEMORY_DELAY_MS);
  await redis.ping();
  const keys = automatic.getPersonalMemoryKeys(event.self_id);
  assert.ok(JSON.parse(await redis.hget(keys.jobs, handle.id)).busyUntil > Date.now());
  let requested = 0;
  await automatic.runDuePersonalMemories(event.self_id, { redis, aiRequest: async () => { requested++; } });
  assert.equal(requested, 0);
  assert.equal(await redis.exists(mimic.getMimicHistoryKey(event)), 1);
  await automatic.finishPersonalMemory(handle, conversation(), { redis });
  assert.equal(JSON.parse(await redis.hget(keys.jobs, handle.id)).dueAt, Date.now() + automatic.PERSONAL_MEMORY_DELAY_MS);
  context.mock.timers.reset();
  await automatic.cancelPersonalMemory(event, "Mimic", { redis });
  await mimic.clearMimicHistory(event, { redis });
});

test("记忆写入后、删除之前开始新对话，原子检查仍保护新会话", async () => {
  const event = e(930022);
  const now = Date.now();
  const dueAt = now + automatic.PERSONAL_MEMORY_DELAY_MS + 1;
  const handle = await automatic.beginPersonalMemory(event, "Mimic", { redis, now });
  await mimic.saveMimicHistory(event, conversation(), { redis, memoryTask: handle });
  await automatic.finishPersonalMemory(handle, conversation(), { redis, now });
  let newer;
  const input = [...conversation(), ...conversation("我刚开始新的对话")];
  const racingRedis = new Proxy(redis, { get(target, property) {
    if (property === "eval") return async (script, ...args) => {
      if (!newer && script.includes("if KEYS[3] ~= '' then redis.call('DEL', KEYS[3])")) {
        newer = await automatic.beginPersonalMemory(event, "Mimic", { redis, now: dueAt });
        await mimic.saveMimicHistory(event, input, { redis, memoryTask: newer });
        await automatic.finishPersonalMemory(newer, input, { redis, now: dueAt });
      }
      return target.eval(script, ...args);
    };
    const value = target[property];
    return typeof value === "function" ? value.bind(target) : value;
  } });
  await automatic.runDuePersonalMemories(event.self_id, { redis: racingRedis, now: dueAt,
    aiRequest: async () => ({ text: '{"memories":[{"content":"用户希望被称为小夜"}]}' }),
  });
  assert.ok(newer);
  assert.deepEqual(await mimic.loadMimicHistory(event, { redis }), input);
  assert.equal(JSON.parse(await redis.hget(automatic.getPersonalMemoryKeys(event.self_id).jobs, handle.id)).token, newer.token);
  await automatic.cancelPersonalMemory(event, "Mimic", { redis });
  await mimic.clearMimicHistory(event, { redis });
});

test("未开启记忆工具时不登记chat提取任务，拟态空闲20分钟后仅清理历史", async () => {
  const event = e(930023);
  const now = Date.now();
  assert.equal(await automatic.beginPersonalMemory(event, "chat:test", { redis, now, toolGroup: "关闭记忆" }), null);
  const handle = await automatic.beginPersonalMemory(event, "Mimic", { redis, now, toolGroup: "关闭记忆" });
  await mimic.saveMimicHistory(event, conversation(), { redis, memoryTask: handle });
  await automatic.finishPersonalMemory(handle, conversation(), { redis, now });
  const keys = automatic.getPersonalMemoryKeys(event.self_id);
  assert.equal(JSON.parse(await redis.hget(keys.jobs, handle.id)).cleanupOnly, true);
  let requested = 0;
  const aiRequest = async () => { requested++; throw new Error("关闭时不应请求 AI"); };
  await automatic.runDuePersonalMemories(event.self_id, { redis, now: now + automatic.PERSONAL_MEMORY_DELAY_MS - 1, aiRequest });
  assert.equal(await redis.exists(mimic.getMimicHistoryKey(event)), 1);
  await automatic.runDuePersonalMemories(event.self_id, { redis, now: now + automatic.PERSONAL_MEMORY_DELAY_MS + 1, aiRequest });
  assert.equal(requested, 0);
  assert.deepEqual(await mimic.loadMimicHistory(event, { redis }), []);
  assert.equal(await redis.hget(keys.jobs, handle.id), null);
});

test("中断的首轮拟态没有可提取对话，仍登记20分钟清理流程", async () => {
  const event = e(930024);
  const now = Date.now();
  const handle = await automatic.beginPersonalMemory(event, "Mimic", { redis, now });
  await mimic.saveMimicHistory(event, conversation("中断对话"), { redis, memoryTask: handle });
  await automatic.finishPersonalMemory(handle, null, { redis, now });
  const keys = automatic.getPersonalMemoryKeys(event.self_id);
  assert.equal(Object.keys(JSON.parse(await redis.hget(keys.jobs, handle.id)).history).length, 0);
  await automatic.runDuePersonalMemories(event.self_id, { redis, now: now + automatic.PERSONAL_MEMORY_DELAY_MS + 1,
    aiRequest: async () => { throw new Error("中断对话不应提取记忆"); },
  });
  assert.equal(await redis.exists(mimic.getMimicHistoryKey(event)), 0);
  assert.equal(await redis.hget(keys.jobs, handle.id), null);
});

test("重启接续旧版10分钟任务，延长到20分钟并保留历史至提取完成", async () => {
  const event = e(930025);
  const now = Date.now();
  const handle = await automatic.beginPersonalMemory(event, "Mimic", { redis, now });
  await mimic.saveMimicHistory(event, conversation(), { redis, memoryTask: handle });
  await automatic.finishPersonalMemory(handle, conversation(), { redis, now });
  const keys = automatic.getPersonalMemoryKeys(event.self_id);
  const job = JSON.parse(await redis.hget(keys.jobs, handle.id));
  delete job.idleTimeoutMs;
  job.dueAt = now + 10 * 60 * 1000;
  await redis.hset(keys.jobs, handle.id, JSON.stringify(job));
  await redis.zadd(keys.due, job.dueAt, handle.id);
  await redis.expire(mimic.getMimicHistoryKey(event), 1200);
  await redis.expire(keys.jobs, 86400);
  await redis.expire(keys.due, 86400);
  let requested = 0;
  const aiRequest = async () => { requested++; return { text: '{"memories":[]}' }; };
  await automatic.runDuePersonalMemories(event.self_id, { redis, now: job.dueAt + 1, aiRequest });
  assert.equal(requested, 0);
  assert.equal(JSON.parse(await redis.hget(keys.jobs, handle.id)).dueAt, now + automatic.PERSONAL_MEMORY_DELAY_MS);
  assert.equal(await redis.ttl(mimic.getMimicHistoryKey(event)), -1);
  assert.equal(await redis.ttl(keys.jobs), -1);
  await automatic.runDuePersonalMemories(event.self_id, { redis, now: now + automatic.PERSONAL_MEMORY_DELAY_MS + 1, aiRequest });
  assert.equal(requested, 1);
  assert.equal(await redis.exists(mimic.getMimicHistoryKey(event)), 0);
});

test("清空对话同时清理 Redis 拟态历史和延迟任务", async () => {
  const event = e(930011);
  await mimic.saveMimicHistory(event, conversation(), { redis });
  const handle = await automatic.beginPersonalMemory(event, "Mimic", { redis });
  await automatic.finishPersonalMemory(handle, conversation(), { redis });
  await historyStore.clearConversationHistory(event, "Mimic");
  assert.deepEqual(await mimic.loadMimicHistory(event, { redis }), []);
  assert.equal(await redis.hget(automatic.getPersonalMemoryKeys(event.self_id).jobs, handle.id), null);
  const normal = await automatic.beginPersonalMemory(event, "Mimic", { redis });
  await automatic.finishPersonalMemory(normal, conversation(), { redis });
  await historyStore.clearAllPrefixesForUser(event);
  assert.equal(await redis.hget(automatic.getPersonalMemoryKeys(event.self_id).jobs, normal.id), null);
});

test("小时任务不足100条不请求 AI，多账号同群同小时只采集一次", async () => {
  const now = new Date();
  const seconds = Math.floor(now.getTime() / 1000);
  memoryConfig = { Groups: [920012] };
  await append(920012, 99, seconds);
  const task = new AutomaticMemory();
  let count = 0;
  aiHandler = async (...args) => { count++; assert.equal(JSON.parse(args[2][0].text).length, 100); return { text: "没有值得保存的新信息" }; };
  await task.groupMemoryTask(now);
  assert.equal(count, 0);
  await append(920012, 1, seconds + 1, 1000);
  await task.groupMemoryTask(new Date(now.getTime() + 1000));
  assert.equal(count, 1);
  currentSelfId = 910002;
  await append(920012, 100, seconds);
  await task.groupMemoryTask(now);
  assert.equal(count, 1);
  assert.equal(forwardCalls.length, 0);
  currentSelfId = 910001;
  memoryConfig = {};
  aiHandler = null;
});

test("小时任务转发按类别标题与内容分节点，每人一个内容节点，重复记忆不展示", async () => {
  const now = new Date();
  const seconds = Math.floor(now.getTime() / 1000);
  memoryConfig = { Groups: [920016] };
  const start = forwardCalls.length;
  try {
    await append(920016, 99, seconds);
    await append(920016, 1, seconds, 1000, { userId: 930016, senderName: "小花" });
    let round = 0;
    aiHandler = async () => round++ === 0 ? { functionCalls: [
      { name: "Memory", args: { scope: "user", userId: "930016", content: "小花喜欢绘画" } },
      { name: "Memory", args: { scope: "group", content: "本群周六举行活动" } },
      { name: "Memory", args: { scope: "user", userId: "930003", content: "小夜喜欢猫" } },
      { name: "Memory", args: { scope: "user", userId: "930016", content: "小花希望使用小花这个称呼" } },
      { name: "Memory", args: { scope: "group", content: "本群周六举行活动" } },
    ] } : { text: "已完成，另一个并未保存的说法" };
    const task = new AutomaticMemory();
    await task.groupMemoryTask(now);
    assert.equal(forwardCalls.length, start + 1);
    const sent = forwardCalls.at(-1);
    assert.equal(sent.selfId, currentSelfId);
    assert.equal(sent.groupId, 920016);
    assert.equal(sent.source, "新增记忆");
    assert.deepEqual(sent.news, [{ text: "群记忆1条" }, { text: "个人记忆3条" }]);
    assert.deepEqual(sent.nodes.map((node) => node.data.nickname), ["群记忆", "群记忆内容", "个人记忆", "小花", "小夜"]);
    assert.ok(sent.nodes.every((node) => node.type === "node" && node.data.user_id === currentSelfId));
    assert.deepEqual(sent.nodes.map((node) => node.data.content[0].data.text), [
      "群记忆",
      "1. 本群周六举行活动",
      "个人记忆",
      "小花（QQ：930016）\n\n1. 小花喜欢绘画\n2. 小花希望使用小花这个称呼",
      "小夜（QQ：930003）\n\n1. 小夜喜欢猫",
    ]);
    await task.groupMemoryTask(now);
    assert.equal(forwardCalls.length, start + 1);
    assert.equal(round, 2);

    const nextHour = new Date(now.getTime() + 3600000);
    await append(920016, 100, seconds + 3600, 2000);
    round = 0;
    aiHandler = async () => round++ === 0 ? { functionCalls: [
      { name: "Memory", args: { scope: "group", content: "本群周六举行活动" } },
    ] } : { text: "已完成" };
    await task.groupMemoryTask(nextHour);
    assert.equal(forwardCalls.length, start + 1, "只有重复记忆时不发送空转发");
  } finally {
    memoryConfig = {};
    aiHandler = null;
  }
});

test("转发省略没有新增内容的类别标题与内容节点，空结果不生成节点", () => {
  const event = e(910001);
  const records = [{ userId: "930017", senderName: "小明" }];
  const userOnly = automatic.buildGroupMemoryForwardNodes(event, records, [
    { scope: "group", content: " " },
    { scope: "user", userId: "930017", content: "小明喜欢音乐" },
  ]);
  assert.deepEqual(userOnly.map((node) => node.data.nickname), ["个人记忆", "小明"]);
  assert.deepEqual(userOnly.map((node) => node.data.content[0].data.text), ["个人记忆", "小明（QQ：930017）\n\n1. 小明喜欢音乐"]);
  const groupOnly = automatic.buildGroupMemoryForwardNodes(event, records, [{ scope: "group", content: "本群的约定" }]);
  assert.deepEqual(groupOnly.map((node) => node.data.nickname), ["群记忆", "群记忆内容"]);
  assert.deepEqual(groupOnly.map((node) => node.data.content[0].data.text), ["群记忆", "1. 本群的约定"]);
  assert.deepEqual(automatic.buildGroupMemoryForwardNodes(event, records, []), []);
});

test("结果转发失败仍保留已写入记忆，同小时不重复采集或发送", async () => {
  const now = new Date();
  const seconds = Math.floor(now.getTime() / 1000);
  memoryConfig = { Groups: [920018] };
  const start = forwardCalls.length;
  try {
    await append(920018, 100, seconds);
    let round = 0;
    aiHandler = async () => round++ === 0 ? { functionCalls: [
      { name: "Memory", args: { scope: "group", content: "本群周日读书" } },
    ] } : { text: "已完成" };
    forwardError = new Error("测试发送失败");
    const task = new AutomaticMemory();
    await task.groupMemoryTask(now);
    assert.equal(document(e(910001, 920018), "group").memories[0].content, "本群周日读书");
    await task.groupMemoryTask(now);
    assert.equal(round, 2);
    assert.equal(forwardCalls.length, start + 1);
    assert.deepEqual(forwardCalls.at(-1).news, [{ text: "群记忆1条" }, { text: "个人记忆0条" }]);
  } finally {
    forwardError = null;
    memoryConfig = {};
    aiHandler = null;
  }
});

test("chat 按角色工具组登记个人记忆，独立遵循各前缀的历史保存配置", async () => {
  const event = { ...e(930013), self_id: 910013, reply: async () => {} };
  const chat = new AIChat();
  const keys = automatic.getPersonalMemoryKeys(event.self_id);
  for (const [prefix, history, toolGroup] of [["*", false, "记忆"], ["#", true, "记忆"], ["!", true, "关闭记忆"]]) {
    const profile = { route: "test", Prompt: "角色提示", prefixes: [prefix], history, toolGroup };
    await chat.doChat(event, profile, "我喜欢简洁");
    assert.equal(agentToolGroups.at(-1), toolGroup);
    const id = automatic.getPersonalMemoryJobId(event, `chat:${prefix}`);
    const raw = await redis.hget(keys.jobs, id);
    if (toolGroup === "记忆") {
      const job = JSON.parse(raw);
      assert.equal(job.toolGroup, toolGroup);
      assert.equal(job.cleanupOnly, false);
      assert.deepEqual(job.history, [
        { role: "user", parts: [{ text: "我喜欢简洁" }] }, { role: "model", parts: [{ text: "正常回复" }] },
      ]);
      assert.ok(await redis.zscore(keys.due, id));
    } else {
      assert.equal(raw, null);
      assert.equal(await redis.zscore(keys.due, id), null);
    }
    const saved = await historyStore.loadConversationHistory(event, prefix);
    assert.deepEqual(saved, history ? [
      { role: "user", parts: [{ text: "我喜欢简洁" }] }, { role: "model", parts: [{ text: "正常回复" }] },
    ] : []);
  }
  let requested = 0;
  await automatic.runDuePersonalMemories(event.self_id, { redis, now: Date.now() + automatic.PERSONAL_MEMORY_DELAY_MS + 1,
    aiRequest: async () => {
      requested++;
      return { text: '{"memories":[{"content":"用户喜欢简洁"}]}' };
    },
  });
  assert.equal(requested, 2);
  assert.deepEqual(document(event).memories.map((item) => item.content), ["用户喜欢简洁"]);
  assert.equal((await historyStore.loadConversationHistory(event, "#")).length, 2);
  assert.equal(await redis.hlen(keys.jobs), 0);
  const failed = { ...e(930014), self_id: event.self_id, reply: async () => {} };
  agentStatus = "model_error";
  try {
    await chat.doChat(failed, { route: "test", Prompt: "角色提示", prefixes: ["*"], history: false, toolGroup: "记忆" }, "失败请求");
    assert.equal(await redis.hget(keys.jobs, automatic.getPersonalMemoryJobId(failed, "chat:*")), null);
  } finally {
    agentStatus = "completed";
  }
});

test("旧chat任务按当前工具配置判断，未开启记忆时移除任务且保留其他拟态会话", async () => {
  const event = { ...e(930016), self_id: 910016 };
  const now = Date.now();
  const keys = automatic.getPersonalMemoryKeys(event.self_id);
  assert.equal(await automatic.beginPersonalMemory(event, "chat:*", { redis, now }), null);
  const handle = await automatic.beginPersonalMemory(event, "Mimic", { redis, now });
  const input = conversation("拟态中的个人事实");
  await mimic.saveMimicHistory(event, input, { redis, memoryTask: handle });
  await automatic.finishPersonalMemory(handle, input, { redis, now });
  const before = await redis.hget(keys.jobs, handle.id);
  const legacyId = automatic.getPersonalMemoryJobId(event, "chat:*");
  const legacy = { ...JSON.parse(before), source: "chat:*", token: "旧版角色任务", dueAt: now - 1, history: conversation("角色虚构事实") };
  delete legacy.toolGroup;
  await redis.hset(keys.jobs, legacyId, JSON.stringify(legacy));
  await redis.zadd(keys.due, legacy.dueAt, legacyId);
  await automatic.runDuePersonalMemories(event.self_id, { redis, now,
    aiRequest: async () => { throw new Error("旧chat任务不应调用AI"); },
  });
  assert.equal(await redis.hget(keys.jobs, legacyId), null);
  assert.equal(await redis.zscore(keys.due, legacyId), null);
  assert.equal(await redis.hget(keys.jobs, handle.id), before);
  assert.deepEqual(await mimic.loadMimicHistory(event, { redis }), input);
  assert.equal(document(event).memories.length, 0);
  await historyStore.clearAllPrefixesForUser(event);
});

test("排队期间关闭记忆工具，chat和拟态都跳过提取，拟态仍清理历史", async () => {
  const now = Date.now();
  const event = { ...e(930017), self_id: 910017 };
  const keys = automatic.getPersonalMemoryKeys(event.self_id);
  const handles = [];
  for (const source of ["chat:test", "Mimic"]) {
    const handle = await automatic.beginPersonalMemory(event, source, { redis, now, toolGroup: "记忆" });
    if (source === "Mimic") await mimic.saveMimicHistory(event, conversation(), { redis, memoryTask: handle });
    await automatic.finishPersonalMemory(handle, conversation(), { redis, now });
    handles.push(handle);
  }
  const original = toolGroups;
  toolGroups = [{ name: "记忆", tools: [] }, { name: "关闭记忆", tools: [] }];
  let requested = 0;
  try {
    await automatic.runDuePersonalMemories(event.self_id, { redis, now: now + automatic.PERSONAL_MEMORY_DELAY_MS + 1,
      aiRequest: async () => { requested++; throw new Error("关闭工具后不应请求AI"); },
    });
    assert.equal(requested, 0);
    for (const handle of handles) assert.equal(await redis.hget(keys.jobs, handle.id), null);
    assert.deepEqual(await mimic.loadMimicHistory(event, { redis }), []);
    assert.equal(document(event).memories.length, 0);
  } finally {
    toolGroups = original;
    await automatic.cancelPersonalMemory(event, null, { redis });
  }
});

test("拟态入口承接完整 Redis 连续历史，随机插话保持独立且不续期", async () => {
  const event = { ...e(930015), isMaster: true, getInfo: async () => ({}), reply: async () => {} };
  const instance = new Mimic();
  const config = { route: "test", Prompt: "角色提示", splitMessage: false, toolGroup: "记忆" };
  event._mimicPreflight = { config, query: "第一轮", mustReply: true };
  await instance.doMimic(event);
  event._mimicPreflight.query = "第二轮";
  await instance.doMimic(event);
  assert.equal(agentHistoryLengths.at(-1), 2);
  assert.equal((await mimic.loadMimicHistory(event, { redis })).length, 4);
  const keys = automatic.getPersonalMemoryKeys(event.self_id);
  const id = automatic.getPersonalMemoryJobId(event, "Mimic");
  const beforeJob = await redis.hget(keys.jobs, id);
  assert.equal(JSON.parse(beforeJob).toolGroup, "记忆");
  assert.equal(JSON.parse(beforeJob).cleanupOnly, false);
  assert.equal(await redis.ttl(mimic.getMimicHistoryKey(event)), -1);
  assert.ok(JSON.parse(beforeJob).dueAt - Date.now() >= automatic.PERSONAL_MEMORY_DELAY_MS - 1000);
  await redis.expire(mimic.getMimicHistoryKey(event), 5);
  event._mimicPreflight = { config, query: "随机插话", mustReply: false };
  await instance.doMimic(event);
  assert.equal(agentHistoryLengths.at(-1), 0);
  assert.ok(await redis.ttl(mimic.getMimicHistoryKey(event)) <= 5);
  assert.equal(await redis.hget(keys.jobs, id), beforeJob);
  await historyStore.clearAllPrefixesForUser(event);
});
