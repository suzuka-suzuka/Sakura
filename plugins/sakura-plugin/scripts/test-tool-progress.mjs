// node --test plugins/sakura-plugin/scripts/test-tool-progress.mjs
// 工具进度消息：慢阶段才发、同阶段不重发、切换时先发新再撤旧、结束时撤回。
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

globalThis.logger ??= { info() {}, warn() {}, error() {}, debug() {}, mark() {} };

const { ToolProgress, formatProgressText, createToolProgress } = await import(
  "../lib/AIUtils/toolProgress.js"
);

const DELAY = 20;
const WAIT = DELAY * 3;

function createFake({ failSend = false } = {}) {
  const log = [];
  let nextId = 1;
  const progress = new ToolProgress(null, {
    delayMs: DELAY,
    send: async (text) => {
      if (failSend) throw new Error("send failed");
      const id = nextId++;
      log.push(`send#${id}:${text}`);
      return id;
    },
    recall: async (id) => {
      log.push(`recall#${id}`);
    },
  });
  return { progress, log };
}

test("formatProgressText 去重、最多两项、空则返回空串", () => {
  assert.equal(formatProgressText(["搜索"]), "正在搜索…");
  assert.equal(formatProgressText(["搜索", null, "搜索", "绘画", "找歌"]), "正在搜索、绘画…");
  assert.equal(formatProgressText([null, undefined, ""]), "");
  assert.equal(formatProgressText([]), "");
});

test("阶段在延迟内结束时不发消息", async () => {
  const { progress, log } = createFake();
  progress.enter("正在搜索…");
  progress.leave();
  await sleep(WAIT);
  await progress.dispose();
  assert.deepEqual(log, []);
});

test("慢阶段发状态，结束时撤回", async () => {
  const { progress, log } = createFake();
  progress.enter("正在搜索…");
  await sleep(WAIT);
  progress.leave();
  await progress.dispose();
  assert.deepEqual(log, ["send#1:正在搜索…", "recall#1"]);
});

test("同一阶段连续多轮只发一次", async () => {
  const { progress, log } = createFake();
  for (let i = 0; i < 3; i++) {
    progress.enter("正在搜索…");
    await sleep(WAIT);
    progress.leave();
  }
  await progress.dispose();
  assert.deepEqual(log, ["send#1:正在搜索…", "recall#1"]);
});

test("切换阶段时先发新状态再撤回旧状态", async () => {
  const { progress, log } = createFake();
  progress.enter("正在搜索…");
  await sleep(WAIT);
  progress.leave();
  progress.enter("正在绘画…");
  await sleep(WAIT);
  progress.leave();
  await progress.dispose();
  assert.deepEqual(log, [
    "send#1:正在搜索…",
    "send#2:正在绘画…",
    "recall#1",
    "recall#2",
  ]);
});

test("不需要显示的阶段（空文字）保留已显示的状态", async () => {
  const { progress, log } = createFake();
  progress.enter("正在搜索…");
  await sleep(WAIT);
  progress.leave();
  progress.enter("");
  await sleep(WAIT);
  progress.leave();
  assert.deepEqual(log, ["send#1:正在搜索…"]);
  await progress.dispose();
  assert.deepEqual(log, ["send#1:正在搜索…", "recall#1"]);
});

test("快速切到的新阶段不替换旧状态", async () => {
  const { progress, log } = createFake();
  progress.enter("正在搜索…");
  await sleep(WAIT);
  progress.leave();
  progress.enter("正在查看内容…");
  progress.leave();
  await sleep(WAIT);
  await progress.dispose();
  assert.deepEqual(log, ["send#1:正在搜索…", "recall#1"]);
});

test("dispose 之后的 enter 被忽略，计时中的状态也不再发", async () => {
  const { progress, log } = createFake();
  progress.enter("正在搜索…");
  await progress.dispose();
  progress.enter("正在绘画…");
  await sleep(WAIT);
  assert.deepEqual(log, []);
});

test("发送失败不抛出，dispose 正常结束", async () => {
  const { progress, log } = createFake({ failSend: true });
  progress.enter("正在搜索…");
  await sleep(WAIT);
  await progress.dispose();
  assert.deepEqual(log, []);
});

test("事件对象缺少 reply/recall 时不创建进度", () => {
  assert.equal(createToolProgress(null), null);
  assert.equal(createToolProgress({ reply() {} }), null);
  assert.ok(createToolProgress({ reply() {}, recall() {} }) instanceof ToolProgress);
});
