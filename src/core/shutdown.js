/**
 * 进程退出前的异步收尾。
 *
 * process.on("exit") 回调里只能跑同步代码：在那里调用 browser.close() 之类的异步关闭，
 * 进程会在关闭完成前就退出，常驻的 Chromium、MCP 子进程因此被遗留。
 * 需要 await 才能关干净的资源在这里登记，由 shutdown() 依次等待完成后再退出。
 *
 * 本文件会被独立脚本间接引用（如钓鱼图片生成脚本），不要在顶层引入 logger 等有副作用的模块。
 */

/** 单个收尾阶段的等待上限；退出总时长受父进程 5 秒强杀限制 */
const STEP_TIMEOUT_MS = 3000;
/** 收尾完成后留给日志落盘、socket 发出关闭帧的时间 */
const EXIT_DELAY_MS = 500;

const hooks = new Set();
let exiting = null;

function log(level, message) {
  const target = globalThis.logger ?? console;
  (target[level] ?? target.info).call(target, message);
}

/**
 * 登记一个退出收尾任务。
 * 同一 order 的任务并行执行，order 小的先执行：断开连接用负数，Redis 等存储放在最后用正数。
 * 插件热重载后旧模块登记的任务仍会执行，用来关闭旧实例持有的资源。
 * @param {string} name 日志里显示的名称
 * @param {() => unknown | Promise<unknown>} fn
 * @param {{ order?: number }} [options]
 * @returns {() => void} 取消登记
 */
export function onShutdown(name, fn, { order = 0 } = {}) {
  const hook = { name, fn, order };
  hooks.add(hook);
  return () => hooks.delete(hook);
}

async function runStep(step) {
  let timer;
  const tasks = step.map(async ({ name, fn }) => {
    try {
      await fn();
    } catch (error) {
      log("warn", `[退出] ${name} 收尾失败: ${error?.message || error}`);
    }
  });
  const timedOut = await Promise.race([
    Promise.all(tasks).then(() => false),
    new Promise((resolve) => { timer = setTimeout(() => resolve(true), STEP_TIMEOUT_MS); }),
  ]);
  clearTimeout(timer);
  if (timedOut) {
    log("warn", `[退出] ${step.map((h) => h.name).join("、")} 收尾超过 ${STEP_TIMEOUT_MS}ms，跳过等待`);
  }
}

/** 按 order 分批执行所有已登记的收尾任务（只执行一次） */
export async function runShutdownHooks() {
  const pending = [...hooks].sort((a, b) => a.order - b.order);
  hooks.clear();

  const steps = [];
  for (const hook of pending) {
    const last = steps.at(-1);
    if (last && last[0].order === hook.order) last.push(hook);
    else steps.push([hook]);
  }
  for (const step of steps) {
    await runStep(step);
  }
}

/**
 * 优雅退出：等所有收尾任务完成后再结束进程。重复调用返回同一个 Promise。
 * 需要父进程重新拉起时，先 process.send("restart") 再调用本函数。
 * @param {string} reason 日志里显示的退出原因
 * @param {number} [exitCode]
 */
export function shutdown(reason, exitCode = 0) {
  if (!exiting) {
    exiting = (async () => {
      log("info", `收到 ${reason}，正在优雅关闭...`);
      try {
        await runShutdownHooks();
      } catch (error) {
        log("error", `关闭过程出错: ${error?.message || error}`);
      }
      await new Promise((resolve) => setTimeout(resolve, EXIT_DELAY_MS));
      process.exit(exitCode);
    })();
  }
  return exiting;
}

export function isShuttingDown() {
  return exiting !== null;
}
