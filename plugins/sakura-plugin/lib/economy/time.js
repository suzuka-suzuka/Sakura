const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

function getShanghaiDateParts(timestamp) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SHANGHAI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));

  return Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

export function getShanghaiDateKey(timestamp = Date.now()) {
  const { year, month, day } = getShanghaiDateParts(timestamp);
  return `${year}-${month}-${day}`;
}

export function getShanghaiHour(timestamp = Date.now()) {
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone: SHANGHAI_TIME_ZONE,
    hour: "2-digit",
    hourCycle: "h23",
  }).format(new Date(timestamp));
  return Number(hour);
}

export function getStartOfShanghaiDay(timestamp = Date.now()) {
  return Date.parse(`${getShanghaiDateKey(timestamp)}T00:00:00+08:00`);
}

export function getStartOfShanghaiWeek(timestamp = Date.now()) {
  const { year, month, day } = getShanghaiDateParts(timestamp);
  const calendarDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const weekday = calendarDate.getUTCDay() || 7;
  return getStartOfShanghaiDay(timestamp) - (weekday - 1) * 24 * 60 * 60 * 1000;
}

export function secondsUntilNextShanghaiDay(timestamp = Date.now()) {
  const nextDay = getStartOfShanghaiDay(timestamp) + 24 * 60 * 60 * 1000;
  return Math.max(1, Math.ceil((nextDay - Number(timestamp)) / 1000));
}
