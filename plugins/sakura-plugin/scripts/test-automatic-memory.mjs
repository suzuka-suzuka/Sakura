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
let aiHandler;
let agentStatus = "completed";
const agentHistoryLengths = [];
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
  getConfig(name) { return name === "Memory" ? memoryConfig : { utilityRoute: "test-utility" }; },
} });
mock.module(moduleUrl("../../../src/utils/redis.js"), { namedExports: { getRedis: () => redis } });
mock.module(moduleUrl("../../../src/api/client.js"), { namedExports: {
  getCurrentBotSelfId: () => currentSelfId,
  getBot: (selfId) => selfId ? {
    self_id: selfId,
    sendForwardMsg: async (nodes, groupId) => {
      forwardCalls.push({ selfId, groupId, nodes: structuredClone(nodes) });
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

mock.module(moduleUrl("../lib/AIUtils/AgentRunner.js"), { namedExports: { runAgentLoop: async ({ history, queryParts }) => {
  agentHistoryLengths.push(history.length);
  history.push({ role: "user", parts: queryParts }, { role: "model", parts: [{ text: "正常回复" }] });
  return { status: agentStatus, history, finalText: "正常回复" };
} } });
mock.module(moduleUrl("../lib/AIUtils/tools/tools.js"), { namedExports: { resolveToolConfirmation() {} } });
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
const automatic = await import("../lib/AIUtils/automaticMemory.js");
const mimic = await import("../lib/AIUtils/mimicHistory.js");
const historyStore = await import("../lib/AIUtils/ConversationHistory.js");
const messages = await import("../lib/AIUtils/groupMessageStore.js");
const { AutomaticMemory } = await import("../apps/AutomaticMemory.js");
const { AIChat } = await import("../apps/chat.js");
const { Mimic } = await import("../apps/Mimic.js");
const tool = new MemoryTool();
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

test("群任务只注入 Memory，可分别写群记忆和指定发言者的个人记忆", async () => {
  const event = e(910001, 920004);
  const records = Array.from({ length: 100 }, (_, index) => ({ messageId: String(index), userId: "930004", senderName: "小夜", content: "聊天", time: index, isBot: false }));
  let round = 0;
  const original = structuredClone(records);
  const success = await automatic.collectGroupMemories(event, records, { aiRequest: async (...args) => {
    assert.equal(args[4], false);
    assert.deepEqual(args[5], { memoryOnly: true, memoryTargets: ["930004"] });
    assert.equal(args[7].disableNativeWebSearch, true);
    if (round++ === 0) return { text: "", functionCalls: [
      { name: "Memory", args: { scope: "group", content: "本群每周六活动" } },
      { name: "Memory", args: { scope: "user", userId: "930004", content: "用户希望被称为小夜" } },
    ] };
    assert.equal(args[6].at(-1).role, "function");
    return { text: "已完成" };
  } });
  assert.equal(success, true);
  assert.equal(document(event, "group").memories[0].content, "本群每周六活动");
  assert.equal(document(e(930004, 920004)).memories[0].content, "用户希望被称为小夜");
  assert.equal(document(event).memories.length, 0);
  assert.deepEqual(records, original);
  assert.match(await tool.func({ scope: "user", content: "错误目标", userId: "999999" }, event, { memoryTargets: ["930004"] }), /发送者 QQ/);
  await assert.rejects(automatic.collectGroupMemories(event, records, { aiRequest: async () => ({ functionCalls: [{ name: "RunCommand", args: {} }] }) }), /只允许/);
});

test("个人10分钟空闲触发，新对话重新计时，旧完成回调不能覆盖新任务", async () => {
  const event = e(930005);
  const now = Date.now();
  const first = await automatic.beginPersonalMemory(event, "chat:test", { redis, now });
  await automatic.finishPersonalMemory(first, conversation(), { redis, now });
  let calls = 0;
  await automatic.runDuePersonalMemories(event.self_id, { redis, now: now + 599999, aiRequest: () => { calls++; } });
  assert.equal(calls, 0);
  const second = await automatic.beginPersonalMemory(event, "chat:test", { redis, now: now + 540000 });
  assert.equal(await automatic.finishPersonalMemory(first, conversation("旧结果"), { redis, now }), false);
  const input = conversation("我喜欢简洁的界面");
  input[0].parts.push({ inlineData: { data: "图片" } });
  input.push({ role: "function", parts: [{ functionResponse: { name: "test" } }] });
  await automatic.finishPersonalMemory(second, input, { redis, now: now + 540000 });
  await automatic.runDuePersonalMemories(event.self_id, { redis, now: now + 600001, aiRequest: () => { calls++; } });
  assert.equal(calls, 0);
  await automatic.runDuePersonalMemories(event.self_id, { redis, now: now + 1140001, aiRequest: async (...args) => {
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
  await automatic.finishPersonalMemory(handle, conversation(), { redis, now });
  let newer;
  await automatic.runDuePersonalMemories(event.self_id, { redis, now: now + 600001, aiRequest: async () => {
    newer = await automatic.beginPersonalMemory(event, "Mimic", { redis, now: now + 600001 });
    return { text: '{"memories":[{"content":"过期提取结果"}]}' };
  } });
  assert.equal(document(event).memories.length, 0);
  const job = JSON.parse(await redis.hget(automatic.getPersonalMemoryKeys(event.self_id).jobs, handle.id));
  assert.equal(job.token, newer.token);
  await automatic.finishPersonalMemory(newer, null, { redis, now: now + 600001 });
  await automatic.cancelPersonalMemory(event, "Mimic", { redis });
});

test("个人格式错误保留任务并退避，空数组成功完成且不增加计数", async () => {
  const event = e(930007);
  const now = Date.now();
  const handle = await automatic.beginPersonalMemory(event, "chat:test", { redis, now });
  await automatic.finishPersonalMemory(handle, conversation(), { redis, now });
  await automatic.runDuePersonalMemories(event.self_id, { redis, now: now + 600001, aiRequest: async () => ({ text: '{"memories":[{"content":"不允许", "scope":"group"}]}' }) });
  const keys = automatic.getPersonalMemoryKeys(event.self_id);
  const job = JSON.parse(await redis.hget(keys.jobs, handle.id));
  assert.equal(job.attempts, 1);
  assert.ok(job.dueAt > now + 600001);
  assert.equal(document(event).revision, 0);
  await automatic.runDuePersonalMemories(event.self_id, { redis, now: job.dueAt + 1, aiRequest: async () => ({ text: '{"memories":[]}' }) });
  assert.equal(await redis.hget(keys.jobs, handle.id), null);
  assert.equal(document(event).revision, 0);
  assert.throws(() => automatic.parsePersonalMemoryResponse('{"memories":[{"content":"事实", "userId":"别的用户"}]}'));
});

test("失败对话不留下空任务，角色、用户、群和账号分别计时", async () => {
  const event = e(930008);
  const first = await automatic.beginPersonalMemory(event, "chat:a", { redis });
  await automatic.finishPersonalMemory(first, null, { redis });
  assert.equal(await redis.hget(automatic.getPersonalMemoryKeys(event.self_id).jobs, first.id), null);
  assert.notEqual(automatic.getPersonalMemoryJobId(event, "chat:a"), automatic.getPersonalMemoryJobId(event, "chat:b"));
  assert.notEqual(automatic.getPersonalMemoryJobId(event, "chat:a"), automatic.getPersonalMemoryJobId(e(930009), "chat:a"));
  assert.notEqual(automatic.getPersonalMemoryJobId(event, "chat:a"), automatic.getPersonalMemoryJobId(e(930008, 920009), "chat:a"));
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

test("Mimic 不按轮数裁剪，真实聊天续期20分钟，后台读取不续期", async () => {
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

test("清空对话同时清理 Redis 拟态历史和延迟任务", async () => {
  const event = e(930011);
  await mimic.saveMimicHistory(event, conversation(), { redis });
  const handle = await automatic.beginPersonalMemory(event, "Mimic", { redis });
  await automatic.finishPersonalMemory(handle, conversation(), { redis });
  await historyStore.clearConversationHistory(event, "Mimic");
  assert.deepEqual(await mimic.loadMimicHistory(event, { redis }), []);
  assert.equal(await redis.hget(automatic.getPersonalMemoryKeys(event.self_id).jobs, handle.id), null);
  const normal = await automatic.beginPersonalMemory(event, "chat:test", { redis });
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

test("小时任务转发实际新增记忆，群节点在前，每人一个节点，重复记忆不展示", async () => {
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
    assert.deepEqual(sent.nodes.map((node) => node.data.nickname), ["群记忆", "个人记忆 · 小花", "个人记忆 · 小夜"]);
    assert.ok(sent.nodes.every((node) => node.type === "node" && node.data.user_id === currentSelfId));
    assert.deepEqual(sent.nodes.map((node) => node.data.content[0].data.text), [
      "群记忆\n\n1. 本群周六举行活动",
      "个人记忆：小花（QQ：930016）\n\n1. 小花喜欢绘画\n2. 小花希望使用小花这个称呼",
      "个人记忆：小夜（QQ：930003）\n\n1. 小夜喜欢猫",
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

test("转发省略没有新增内容的群节点或个人节点，空结果不生成节点", () => {
  const event = e(910001);
  const records = [{ userId: "930017", senderName: "小明" }];
  const userOnly = automatic.buildGroupMemoryForwardNodes(event, records, [
    { scope: "group", content: " " },
    { scope: "user", userId: "930017", content: "小明喜欢音乐" },
  ]);
  assert.deepEqual(userOnly.map((node) => node.data.nickname), ["个人记忆 · 小明"]);
  const groupOnly = automatic.buildGroupMemoryForwardNodes(event, records, [{ scope: "group", content: "本群的约定" }]);
  assert.deepEqual(groupOnly.map((node) => node.data.nickname), ["群记忆"]);
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
  } finally {
    forwardError = null;
    memoryConfig = {};
    aiHandler = null;
  }
});

test("真实聊天入口登记延迟任务；关闭历史的角色仍能提取本轮，失败不登记新记忆", async () => {
  const event = { ...e(930013), reply: async () => {} };
  const chat = new AIChat();
  const profile = { route: "test", Prompt: "角色提示", prefixes: ["*"], history: false };
  await chat.doChat(event, profile, "我喜欢简洁");
  const keys = automatic.getPersonalMemoryKeys(event.self_id);
  const id = automatic.getPersonalMemoryJobId(event, "chat:*");
  const job = JSON.parse(await redis.hget(keys.jobs, id));
  assert.equal(job.busy, false);
  assert.deepEqual(job.history, [
    { role: "user", parts: [{ text: "我喜欢简洁" }] }, { role: "model", parts: [{ text: "正常回复" }] },
  ]);
  const failed = { ...e(930014), reply: async () => {} };
  agentStatus = "model_error";
  await chat.doChat(failed, profile, "失败请求");
  assert.equal(await redis.hget(keys.jobs, automatic.getPersonalMemoryJobId(failed, "chat:*")), null);
  agentStatus = "completed";
  await automatic.cancelPersonalMemory(event, null, { redis });
});

test("拟态入口承接完整 Redis 连续历史，随机插话保持独立且不续期", async () => {
  const event = { ...e(930015), isMaster: true, getInfo: async () => ({}), reply: async () => {} };
  const instance = new Mimic();
  const config = { route: "test", Prompt: "角色提示", splitMessage: false };
  event._mimicPreflight = { config, query: "第一轮", mustReply: true };
  await instance.doMimic(event);
  event._mimicPreflight.query = "第二轮";
  await instance.doMimic(event);
  assert.equal(agentHistoryLengths.at(-1), 2);
  assert.equal((await mimic.loadMimicHistory(event, { redis })).length, 4);
  const keys = automatic.getPersonalMemoryKeys(event.self_id);
  const id = automatic.getPersonalMemoryJobId(event, "Mimic");
  const beforeJob = await redis.hget(keys.jobs, id);
  await redis.expire(mimic.getMimicHistoryKey(event), 5);
  event._mimicPreflight = { config, query: "随机插话", mustReply: false };
  await instance.doMimic(event);
  assert.equal(agentHistoryLengths.at(-1), 0);
  assert.ok(await redis.ttl(mimic.getMimicHistoryKey(event)) <= 5);
  assert.equal(await redis.hget(keys.jobs, id), beforeJob);
  await historyStore.clearAllPrefixesForUser(event);
});
