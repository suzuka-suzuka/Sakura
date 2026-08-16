/**
 * 角色素材下载器
 *
 * 三类素材各有来源：
 *   portrait  立绘   SchaleDB  images/student/portrait/{sid}.webp   透明，约 540~673×1024
 *   chibi     Q版    kivo.wiki images/students/{中文全名}/sd_model.png  透明，454×452
 *   icon      头像   SchaleDB  images/student/icon/{sid}.webp       透明，120×120，已裁到脸
 *
 * kivo 的路径按「姓 名」组织（中间一个半角空格），姓名取自 SchaleDB 的 FamilyName/PersonalName。
 *
 * 用法：node scripts/fetch-art.mjs [--force]
 * 只下载 roster 里已有的角色；已存在的文件默认跳过。
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import sharp from "sharp"

import { ROSTER, SUMMONS } from "../lib/ba/roster.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(HERE, "..", "resources", "ba", "characters")
const SUMMON_OUT = path.join(HERE, "..", "resources", "ba", "summons")
const STUDENTS = JSON.parse(fs.readFileSync(path.join(HERE, "students.json"), "utf8"))
const ALL = Array.isArray(STUDENTS) ? STUDENTS : Object.values(STUDENTS)
const FORCE = process.argv.includes("--force")

/**
 * kivo 与 SchaleDB 的中文译名对不上的角色。键是 SchaleDB 的「姓 名」，值是 kivo 那边的写法。
 * 症状就是 chibi 单独 404 而 portrait / icon 正常 —— 遇到新的照着补一行，
 * 用 HEAD 试出正确写法即可（`fetch(url, {method:"HEAD"})`）。
 */
const KIVO_ALIAS = {
  "陆八魔 爱露": "陆八魔 阿露",
  // kivo 这条用的是日文汉字「瀬」，SchaleDB 的中文名是简体「濑」
  "早濑 优香": "早瀬 优香",
}

const SOURCES = {
  portrait: (s) => `https://schaledb.com/images/student/portrait/${s.Id}.webp`,
  icon: (s) => `https://schaledb.com/images/student/icon/${s.Id}.webp`,
  chibi: (s) => {
    const cn = `${s.FamilyName} ${s.PersonalName}`
    return `https://static.kivo.wiki/images/students/${encodeURIComponent(KIVO_ALIAS[cn] || cn)}/sd_model.png`
  },
}

async function download(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 512) throw new Error(`响应过小(${buf.length}B)，多半不是图片`)
  return buf
}

let ok = 0, skip = 0, fail = 0
for (const t of ROSTER) {
  const s = ALL.find((x) => x.Id === t.sid)
  if (!s) { console.log(`✗ ${t.name}: students.json 里找不到 Id=${t.sid}`); fail++; continue }
  const dir = path.join(OUT_DIR, t.id)
  fs.mkdirSync(dir, { recursive: true })

  for (const [part, urlOf] of Object.entries(SOURCES)) {
    const file = path.join(dir, `${part}.png`)
    if (fs.existsSync(file) && !FORCE) { skip++; continue }
    const url = urlOf(s)
    try {
      const buf = await download(url)
      // 统一转成带透明通道的 PNG，画布层就不用关心源格式
      await sharp(buf).png().toFile(file)
      const m = await sharp(file).metadata()
      console.log(`✓ ${t.name.padEnd(4)} ${part.padEnd(9)} ${m.width}×${m.height}`)
      ok++
    } catch (e) {
      console.log(`✗ ${t.name.padEnd(4)} ${part.padEnd(9)} ${e.message}  ${url}`)
      fail++
    }
  }
}
/**
 * 召唤物的 Q 版。**SchaleDB 没有召唤物的美术资源**——images/ 下所有路径都返回同一张
 * 1543 字节的占位图，别浪费时间试。kivo 把佩洛洛当角色收录了，走那条路。
 */
const SUMMON_ART = {
  40002: `https://static.kivo.wiki/images/students/${encodeURIComponent("佩洛洛")}/sd_model.png`,
}

for (const [id, url] of Object.entries(SUMMON_ART)) {
  if (!SUMMONS[id]) continue // 当前角色池没用到这个召唤物
  const dir = path.join(SUMMON_OUT, id)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "chibi.png")
  if (fs.existsSync(file) && !FORCE) { skip++; continue }
  try {
    await sharp(await download(url)).png().toFile(file)
    const m = await sharp(file).metadata()
    console.log(`✓ ${SUMMONS[id].name.padEnd(4)} ${"chibi".padEnd(9)} ${m.width}×${m.height}`)
    ok++
  } catch (e) {
    console.log(`✗ ${SUMMONS[id].name.padEnd(4)} ${"chibi".padEnd(9)} ${e.message}  ${url}`)
    fail++
  }
}

console.log(`\n完成：新增 ${ok} / 跳过 ${skip} / 失败 ${fail}`)
if (skip) console.log("（已存在的文件默认跳过，要重下加 --force）")
