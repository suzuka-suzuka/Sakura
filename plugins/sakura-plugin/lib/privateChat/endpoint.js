import dns from "dns/promises";
import net from "net";

// 接口地址是用户填的，请求从服务器发出：只允许公网 HTTPS，防止被拿来探测或访问内网服务。
// 主要防线是只允许 HTTPS 并校验证书（内网服务拿不出用户域名的有效证书，DNS 重绑定也过不去）；
// 每次请求前再解析域名、拒绝内网和本机地址，作为额外一层。
// 198.18.0.0/15 不拦：Clash 等代理的 fake-ip 模式把所有域名都解析到这个网段，拦了就什么接口都用不了。

const blockedV4 = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
]) {
  blockedV4.addSubnet(address, prefix, "ipv4");
}

const blockedV6 = new net.BlockList();
for (const [address, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
]) {
  blockedV6.addSubnet(address, prefix, "ipv6");
}

export function isPublicAddress(ip) {
  const address = String(ip || "").replace(/^\[|\]$/g, "").toLowerCase();
  const family = net.isIP(address);
  if (family === 4) return !blockedV4.check(address, "ipv4");
  if (family !== 6) return false;
  // ::ffff:127.0.0.1 这类 IPv4 映射地址按里面的 IPv4 判断
  const mapped = address.match(/^(?:0{0,4}:){0,5}ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return !blockedV4.check(mapped[1], "ipv4");
  if (/^(?:0{0,4}:){0,5}ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(address)) return false;
  return !blockedV6.check(address, "ipv6");
}

async function assertPublicHost(hostname) {
  const host = String(hostname || "").replace(/^\[|\]$/g, "");
  if (!host) throw new Error("接口地址缺少域名");
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw new Error("接口地址不能指向内网或本机");
    return;
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new Error("接口地址不能指向内网或本机");
  }
  let results;
  try {
    results = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`解析不到域名 ${host}`);
  }
  if (!results.length || results.some((item) => !isPublicAddress(item.address))) {
    throw new Error("接口地址不能指向内网或本机");
  }
}

/** 整理用户填的接口地址：去掉末尾斜杠，校验格式。不合法时抛出带中文说明的错误。 */
export function normalizeBaseURL(input) {
  const text = String(input || "").trim();
  if (!text) throw new Error("请填写接口地址");
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("接口地址格式不对，应类似 https://api.example.com/v1");
  }
  if (url.protocol !== "https:") throw new Error("接口地址必须以 https:// 开头");
  if (url.username || url.password) throw new Error("接口地址里不能带用户名或密码");
  if (url.search || url.hash) throw new Error("接口地址里不能带 ? 或 # 参数");
  return url.toString().replace(/\/+$/, "");
}

/** 保存前检查接口地址能否使用（格式 + 域名解析到公网） */
export async function validateBaseURL(input) {
  const baseURL = normalizeBaseURL(input);
  await assertPublicHost(new URL(baseURL).hostname);
  return baseURL;
}

/** 交给 OpenAI SDK 的 fetch：每次请求前校验目标，不跟随重定向 */
export async function guardedFetch(input, init = {}) {
  const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (target.protocol !== "https:") throw new Error("只允许请求 HTTPS 接口");
  await assertPublicHost(target.hostname);
  return fetch(input, { ...init, redirect: "error" });
}
