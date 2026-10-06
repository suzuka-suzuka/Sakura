// 统一图片反代规则：填写域名时替换下载地址，留空时保留原站。
export function resolvePixivImageUrl(originalUrl, proxy = "") {
  const domain = proxy.trim()
  if (!domain) return originalUrl
  const url = new URL(originalUrl)
  url.hostname = domain
  return url.href
}
