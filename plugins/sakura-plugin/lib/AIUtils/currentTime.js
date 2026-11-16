// AI 看到的时间统一按北京时间，不依赖服务器时区。

const TIME_ZONE = "Asia/Shanghai";

function partsOf(date, options) {
  const parts = new Intl.DateTimeFormat("zh-CN", { timeZone: TIME_ZONE, hourCycle: "h23", ...options })
    .formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

/** 例如 "2026年11月16日 星期一 20:38" */
export function formatBeijingDateTime(date = new Date()) {
  const p = partsOf(date, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${p.year}年${p.month}月${p.day}日 ${p.weekday} ${p.hour}:${p.minute}`;
}

/** 秒级时间戳 → "20:38:12"，群聊上下文里每条消息的时间 */
export function formatBeijingClock(timestampSeconds) {
  const p = partsOf(new Date(Number(timestampSeconds) * 1000), {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return `${p.hour}:${p.minute}:${p.second}`;
}

/** 调用方要求时由 getAI 追加在系统提示词末尾的当前时间（放末尾，不影响前面人设部分的提示词缓存） */
export function buildCurrentTimeLine(date = new Date()) {
  return `当前时间：${formatBeijingDateTime(date)}（北京时间）。涉及“今天”“最近”“最新”等相对时间时以此为准。`;
}
