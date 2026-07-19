const DELETE_IF_VALUE_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  end
  return 0
`;

const EXTEND_TTL_SCRIPT = `
  local ttl = redis.call("TTL", KEYS[1])
  if ttl > 0 then
    local nextTtl = ttl + tonumber(ARGV[1])
    redis.call("EXPIRE", KEYS[1], nextTtl)
    return nextTtl
  end
  return ttl
`;

const COMPLETE_FISHING_ATTEMPT_SCRIPT = `
  redis.call("SET", KEYS[1], ARGV[1], "EX", tonumber(ARGV[2]))
  local count = redis.call("INCR", KEYS[2])
  if count == 1 or redis.call("TTL", KEYS[2]) < 0 then
    redis.call("EXPIRE", KEYS[2], tonumber(ARGV[3]))
  end
  return count
`;

export async function acquireRedisLock(client, key, token, ttlSeconds) {
  const result = await client.set(key, token, "EX", ttlSeconds, "NX");
  return result === "OK";
}

export async function releaseRedisLock(client, key, token) {
  return await deleteIfValue(client, key, token);
}

export async function deleteIfValue(client, key, expectedValue) {
  return Number(await client.eval(DELETE_IF_VALUE_SCRIPT, 1, key, expectedValue)) === 1;
}

export async function extendExistingTtl(client, key, extraSeconds) {
  return Number(await client.eval(EXTEND_TTL_SCRIPT, 1, key, String(extraSeconds)));
}

export async function completeFishingAttempt(
  client,
  { cooldownKey, dailyKey, nowSeconds, cooldownSeconds, dailyTtlSeconds },
) {
  return Number(await client.eval(
    COMPLETE_FISHING_ATTEMPT_SCRIPT,
    2,
    cooldownKey,
    dailyKey,
    String(nowSeconds),
    String(cooldownSeconds),
    String(dailyTtlSeconds),
  ));
}
