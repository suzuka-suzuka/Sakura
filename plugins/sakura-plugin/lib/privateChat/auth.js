import crypto from "crypto";

// 登录码和网页会话都只放 Redis，带过期时间。
// 用户在私聊里发 #设置 拿到登录码 → 网页用登录码换会话 → 会话令牌只认这个 QQ。
// 能在私聊里收到登录码就说明是这个 QQ 本人，所以不需要密码。

const PREFIX = "sakura:private-chat";
export const LOGIN_CODE_TTL_SECONDS = 10 * 60;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const LOGIN_FAIL_LIMIT = 20;
const LOGIN_FAIL_WINDOW_SECONDS = 10 * 60;

// 去掉 0/O、1/I/L 这类容易看错的字符；8 位约 6.5e11 种组合，配合失败次数限制无法穷举
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

function randomCode() {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

export function normalizeLoginCode(input) {
  return String(input || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** 生成新登录码，同一个人之前没用掉的登录码作废 */
export async function createLoginCode(userId) {
  const userKey = `${PREFIX}:login-user:${userId}`;
  const previous = await redis.get(userKey);
  if (previous) await redis.del(`${PREFIX}:login:${previous}`);

  const code = randomCode();
  const codeHash = hash(code);
  await redis.multi()
    .set(`${PREFIX}:login:${codeHash}`, String(userId), "EX", LOGIN_CODE_TTL_SECONDS)
    .set(userKey, codeHash, "EX", LOGIN_CODE_TTL_SECONDS)
    .exec();
  return code;
}

export async function isLoginRateLimited(clientKey) {
  const count = Number(await redis.get(`${PREFIX}:login-fail:${hash(clientKey)}`)) || 0;
  return count >= LOGIN_FAIL_LIMIT;
}

async function recordLoginFailure(clientKey) {
  const key = `${PREFIX}:login-fail:${hash(clientKey)}`;
  // 每次失败都顺延窗口：一直在试就一直被挡着
  const [[, count]] = await redis.multi().incr(key).expire(key, LOGIN_FAIL_WINDOW_SECONDS).exec();
  return count;
}

/** 用登录码换会话令牌。登录码只能用一次。失败返回 null。 */
export async function exchangeLoginCode(input, clientKey) {
  const code = normalizeLoginCode(input);
  if (code.length !== CODE_LENGTH) {
    await recordLoginFailure(clientKey);
    return null;
  }
  const codeKey = `${PREFIX}:login:${hash(code)}`;
  const [[, userId]] = await redis.multi().get(codeKey).del(codeKey).exec();
  if (!userId) {
    await recordLoginFailure(clientKey);
    return null;
  }
  await redis.del(`${PREFIX}:login-user:${userId}`);

  const token = crypto.randomBytes(32).toString("base64url");
  await redis.set(`${PREFIX}:session:${hash(token)}`, userId, "EX", SESSION_TTL_SECONDS);
  return { token, userId };
}

/** 校验会话令牌，有效时顺延有效期并返回 QQ 号 */
export async function verifySession(token) {
  if (!token || typeof token !== "string" || token.length > 200) return null;
  const key = `${PREFIX}:session:${hash(token)}`;
  const userId = await redis.get(key);
  if (!userId) return null;
  await redis.expire(key, SESSION_TTL_SECONDS);
  return userId;
}

export async function destroySession(token) {
  if (!token) return;
  await redis.del(`${PREFIX}:session:${hash(token)}`);
}

/** 没设置好就发消息时的提醒，每人一段时间内只提醒一次 */
export async function shouldSendSetupHint(userId, ttlSeconds = 30 * 60) {
  const result = await redis.set(`${PREFIX}:setup-hint:${userId}`, "1", "EX", ttlSeconds, "NX");
  return result === "OK";
}
