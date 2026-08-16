/**
 * 角色素材下载器
 *
 * 四类素材各有来源：
 *   portrait  立绘   SchaleDB  images/student/portrait/{sid}.webp   透明，约 540~673×1024
 *   chibi     Q版    kivo.wiki images/students/{中文全名}/sd_model.png  透明，454×452
 *   icon      头像   SchaleDB  images/student/icon/{sid}.webp       透明，120×120，已裁到脸
 *   status    状态格 原作 Buff/Debuff/CC + 战场用到的 Special（形态转换 / 不死）
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
const STATUS_OUT = path.join(HERE, "..", "resources", "ba", "status")
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

/**
 * 原作战斗状态图标。wiki 上的文件就是游戏里那套：
 * 红底增益 / 蓝底减益 / 紫底控制 / 黄底特殊（形态转换、不死）。
 * 图标自带底色，战场格直接贴图，别再垫一层我们自己的色块。
 *
 * 从 fandom 一次性拉齐 Buff / Debuff / CC，外加战场上会画的两张 Special。
 * 本地短名只给代码里会查的那些；其余按 wiki 文件名转成 kebab，以后用得到就在。
 *
 * 两处容易搞混：
 *   HEAL = 治疗力（施术者奶多少）    REC = 受治疗量（白热化那格减疗）
 *   形态转换只有一张 Special_-_Form_Change → form.png
 *   别再存一份 form-change.png，那是同一张黄底手枪的重复文件名。
 */
const WIKI_API = "https://bluearchive.fandom.com/api.php"
const WIKI_UA = { headers: { "User-Agent": "Mozilla/5.0 SakuraBot/1.0" } }
const SPECIAL_KEEP = new Set(["Special_-_Form_Change.png", "Special_-_Immortal.png"])
/** wiki 文件名 → 代码里 statusIconOf() 用的短名 */
const STATUS_ALIAS = {
  "Buff_-_ATK.png": "atk",
  "Debuff_-_ATK.png": "atk-down",
  "Buff_-_DEF.png": "dfs",
  "Debuff_-_DEF.png": "dfs-down",
  "Buff_-_ATK_SPD.png": "aa",
  "Debuff_-_ATK_SPD.png": "aa-down",
  "Buff_-_ACC.png": "acc",
  "Debuff_-_ACC.png": "acc-down",
  "Buff_-_EVA.png": "dodge",
  "Debuff_-_EVA.png": "dodge-down",
  "Buff_-_HEAL.png": "heal",
  "Debuff_-_HEAL.png": "heal-down",
  "Buff_-_REC.png": "rec",
  "Debuff_-_REC.png": "rec-down",
  "Buff_-_CRIT.R.png": "crit",
  "Debuff_-_CRIT.R.png": "crit-down",
  "Buff_-_CRIT.DMG.png": "crit_dmg",
  "Debuff_-_CRIT.DMG.png": "crit_dmg-down",
  "Buff_-_CRIT.RES.png": "crit_res",
  "Debuff_-_CRIT.RES.png": "crit_res-down",
  "Buff_-_CRIT.DMG.RES.png": "crit_dmg_res",
  "Debuff_-_CRIT.DMG.RES.png": "crit_dmg_res-down",
  "Buff_-_DMG_Ratio.png": "dmg_deal",
  "Buff_-_DMG_Reduced.png": "dmg_take",
  "Debuff_-_DMG_Increased.png": "dmg_take-down",
  "Special_-_Form_Change.png": "form",
  "Special_-_Immortal.png": "immortal",
  "Buff_-_Cost_Decrease.png": "ex-discount",
  "Buff_-_Cost_Regen.png": "cost-regen",
  "Debuff_-_Cost_Regen.png": "cost-regen-down",
  "CC_-_Stunned.png": "stun",
  "CC_-_Fear.png": "fear",
  "CC_-_Provoke.png": "provoke",
  "Debuff_-_Barrage.png": "focus",
  "Debuff_-_Burn.png": "burn",
  "Buff_-_DotHeal.png": "regen",
  "Buff_-_Shield.png": "shield",
}

function statusLocalName(wikiName) {
  if (STATUS_ALIAS[wikiName]) return STATUS_ALIAS[wikiName]
  return wikiName.replace(/\.png$/i, "").replace(/[._-]+/g, "-").toLowerCase()
}

async function listWikiStatus() {
  const files = []
  for (const prefix of ["Buff_-_", "Debuff_-_", "CC_-_", "Special_-_"]) {
    let cont = ""
    for (;;) {
      const url = `${WIKI_API}?action=query&list=allimages&aiprefix=${encodeURIComponent(prefix)}`
        + `&ailimit=500&aiprop=url|size&format=json${cont}`
      const res = await fetch(url, WIKI_UA)
      if (!res.ok) throw new Error(`wiki API HTTP ${res.status}`)
      const data = await res.json()
      for (const f of data.query?.allimages || []) {
        if (prefix === "Special_-_" && !SPECIAL_KEEP.has(f.name)) continue
        files.push(f)
      }
      if (!data.continue?.aicontinue) break
      cont = `&aicontinue=${encodeURIComponent(data.continue.aicontinue)}`
    }
  }
  return files
}

fs.mkdirSync(STATUS_OUT, { recursive: true })
// 上次改名留下的重复文件：和 form.png 是同一张黄底手枪
const staleForm = path.join(STATUS_OUT, "form-change.png")
if (fs.existsSync(staleForm)) {
  fs.unlinkSync(staleForm)
  console.log("· 删掉重复的 form-change.png（就是 form.png 那张）")
}
// wiki 文件名是 Buff_-_X，按 [._] 切会留下 buff---x；收成单横杠
for (const ent of fs.readdirSync(STATUS_OUT)) {
  if (!ent.includes("---")) continue
  const dest = ent.replace(/-+/g, "-")
  const from = path.join(STATUS_OUT, ent)
  const to = path.join(STATUS_OUT, dest)
  if (!fs.existsSync(to)) fs.renameSync(from, to)
  else fs.unlinkSync(from)
}

let wikiFiles = []
try {
  wikiFiles = await listWikiStatus()
} catch (e) {
  console.log(`✗ 状态   列目录失败  ${e.message}`)
  fail++
}

for (const f of wikiFiles) {
  const name = statusLocalName(f.name)
  const file = path.join(STATUS_OUT, `${name}.png`)
  if (fs.existsSync(file) && !FORCE) { skip++; continue }
  try {
    await sharp(await download(f.url)).png().toFile(file)
    const m = await sharp(file).metadata()
    console.log(`✓ 状态   ${name.padEnd(22)} ${m.width}×${m.height}`)
    ok++
  } catch (e) {
    console.log(`✗ 状态   ${name.padEnd(22)} ${e.message}`)
    fail++
  }
}

// wiki 偶发直接吐 WebP，早先有两张（atk / provoke）按 .png 落盘。
// Windows 资源管理器不认这种假 PNG 的透明通道，四周会垫一层黑底。
for (const ent of fs.readdirSync(STATUS_OUT).filter((n) => n.endsWith(".png"))) {
  const file = path.join(STATUS_OUT, ent)
  try {
    const buf = fs.readFileSync(file)
    const m = await sharp(buf).metadata()
    if (m.format === "png") continue
    const tmp = file + ".tmp"
    await sharp(buf).png().toFile(tmp)
    fs.unlinkSync(file)
    fs.renameSync(tmp, file)
    console.log(`· 转成真 PNG  ${ent}  （原来是 ${m.format}）`)
  } catch (e) {
    console.log(`✗ 转 PNG  ${ent}  ${e.message}`)
    fail++
  }
}

console.log(`\n完成：新增 ${ok} / 跳过 ${skip} / 失败 ${fail}`)
if (skip) console.log("（已存在的文件默认跳过，要重下加 --force）")
