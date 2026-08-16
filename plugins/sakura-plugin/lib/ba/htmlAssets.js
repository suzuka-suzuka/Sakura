/**
 * HTML 渲染共用的素材与配色。
 *
 * setContent 的基地址是 about:blank，相对路径解析不了，所以图片和字体
 * 一律转成 base64 内嵌；转换结果按文件缓存，同一局只算一次。
 */
import fs from "node:fs"
import path from "node:path"

import { pluginresources } from "../path.js"

const ASSET_DIR = path.join(pluginresources, "ba", "characters")
const SUMMON_DIR = path.join(pluginresources, "ba", "summons")
const STATUS_DIR = path.join(pluginresources, "ba", "status")
const FONT_FILE = path.join(pluginresources, "sign", "font", "FZFWZhuZiAYuanJWD.ttf")

const cache = new Map()

function dataUri(file, mime) {
  if (cache.has(file)) return cache.get(file)
  let uri = ""
  try {
    if (fs.existsSync(file)) uri = `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`
  } catch { /* 缺图退化成占位块 */ }
  cache.set(file, uri)
  return uri
}

/** @param {"portrait"|"chibi"|"icon"} part */
export const artOf = (id, part) => dataUri(path.join(ASSET_DIR, id, `${part}.png`), "image/png")
/** 召唤物只有 Q 版一张图，跟角色素材分目录放 */
export const summonArtOf = (id) => dataUri(path.join(SUMMON_DIR, String(id), "chibi.png"), "image/png")
/** 原作状态格图标。缺图时返回空串，调用方退回 SVG */
export const statusIconOf = (name) => dataUri(path.join(STATUS_DIR, `${name}.png`), "image/png")
export const fontUri = () => dataUri(FONT_FILE, "font/ttf")

export const fontFace = () => {
  const f = fontUri()
  return f ? `@font-face{font-family:BaRound;src:url("${f}") format("truetype");font-display:block}` : ""
}
export const FONT_STACK = `BaRound,"Microsoft YaHei","Noto Sans SC",sans-serif`

/** 攻击属性色，深色底用 */
export const ATTACK = {
  爆发: "#F05B5B", 贯通: "#F0C547", 神秘: "#4E9FE8", 振动: "#A969DA", 变化: "#6FCF8B",
}
/** 装甲色，血条与徽标用 */
export const ARMOR = {
  轻装: "#E75A64", 重装: "#F0C44E", 特殊: "#559DE4", 弹力: "#A875DE", 复合: "#7FB069",
}
export const ARMOR_LABEL = {
  轻装: "轻装甲", 重装: "重装甲", 特殊: "特殊装甲", 弹力: "弹力装甲", 复合: "复合装甲",
}
/** 属性色偏亮，直接放白底上对比度不够（贯通的 #F0C547 几乎看不见），文字一律走压暗版 */
export function inkOf(hex) {
  const n = Number.parseInt(String(hex).replace("#", ""), 16)
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  const t = [0x1f, 0x32, 0x47]
  return `#${c.map((v, i) => Math.round(v * 0.45 + t[i] * 0.55).toString(16).padStart(2, "0")).join("")}`
}

export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
