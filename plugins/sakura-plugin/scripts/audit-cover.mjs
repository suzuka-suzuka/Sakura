/**
 * 当前角色池的「攻击 / 掩体」数据审计。
 *
 * 逐个核对：普通攻击、选中的普通技能（爱用品版优先）、EX。
 * 对照源是 students.json 的每一条 Damage.Block；核对目标是 roster.js 真正交给引擎的：
 *   - hitBlocks / splashHitBlocks
 *   - altHits[].hitBlocks
 *   - bonus.hitBlocks
 *   - skill.block（只代表主伤害段，用于无指名时的落点转移）
 *
 * 用法：
 *   node scripts/audit-cover.mjs
 *   node scripts/audit-cover.mjs --verbose   # 打印 56 人全部攻击入口
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ROSTER } from "../lib/ba/roster.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const rawData = JSON.parse(fs.readFileSync(path.join(HERE, "students.json"), "utf8"))
const STUDENTS = Array.isArray(rawData)
  ? Object.fromEntries(rawData.map((x) => [x.Id, x]))
  : rawData
const VERBOSE = process.argv.includes("--verbose")
const SKILL_LV = 0

const one = (x) => (Array.isArray(x) ? x[0] : x)
const damagesOf = (sk) => (sk?.Effects || []).filter((e) => e.Type === "Damage")
const bitsOf = (dmg) => (dmg?.Hits || [10000]).map(() => dmg.Block === 1)
const bitsText = (bits) => bits.map((b) => (b ? "1" : "0")).join("") || "—"
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const hasZone = (dmg) => (dmg?.HitFrames?.length || 0) > (dmg?.Hits || [10000]).length
const isSplash = (desc) => /对1名敌方单位/.test(desc || "") && /为中心的[^。]*范围/.test(desc || "")
const hasBonus = (desc) => /概率造成自身攻击力[^\n]*追加伤害/.test(desc || "")
const hasFury = (desc) => /<s:Fury>/.test(desc || "")
const hasEnergy = (desc) => /EnergyBatteryHalf|EnergyBatteryFull/.test(desc || "")
const isXLargeOnly = (dmg) => {
  const c = dmg?.Condition
  return c?.Type === "TargetProp" && c.Parameter === "Size" && c.Operand === "Equal" && c.Value === "XLarge"
}

let bad = 0
const lines = []
const summary = {
  units: ROSTER.length,
  entries: 0,
  aa: { total: 0, block: 0, bypass: 0 },
  skill: { total: 0, block: 0, bypass: 0 },
  ex: { total: 0, block: 0, bypass: 0 },
  zone: 0,
  mixed: 0,
  alt: 0,
  bonus: 0,
  unreachable: 0,
  charge: 0,
}

function fail(label, detail) {
  bad++
  console.error(`✗ ${label}\n    ${detail}`)
}

function assert(label, got, want) {
  if (!same(got, want)) fail(label, `实际 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`)
}

function assertBits(label, got, want) {
  if (!same(got, want)) fail(label, `实际 ${bitsText(got || [])}，期望 ${bitsText(want || [])}`)
}

function count(slot, primaryBlock) {
  const row = summary[slot]
  row.total++
  row[primaryBlock ? "block" : "bypass"]++
  summary.entries++
}

function record(ok, u, slot, raw, kind, detail) {
  lines.push(`${ok ? "✓" : "✗"} ${u.name} ${slot === "aa" ? "普攻" : slot === "skill" ? "普技" : "EX"}`
    + `${raw?.Name ? `「${raw.Name}」` : ""}｜${kind}｜${detail}`)
}

function auditAuto(u, student) {
  const raw = one(student.Skills?.Normal)
  const ds = damagesOf(raw)
  const label = `${u.name} 普攻`
  if (u.squad === "支援") {
    assert(`${label}：支援位没有普攻模板`, u.autoAttack, null)
    if (ds.length) fail(label, `支援位原数据意外出现 ${ds.length} 条 Damage`)
    return
  }
  if (ds.length !== 1) {
    fail(label, `主力普攻应正好有 1 条 Damage，实际 ${ds.length}`)
    return
  }
  const d = ds[0]
  if (![0, 1].includes(d.Block)) fail(label, `当前引擎不支持 Block=${d.Block}`)
  const want = bitsOf(d)
  count("aa", d.Block === 1)
  assertBits(`${label}：逐段 Block`, u.autoAttack?.hitBlocks, want)
  assert(`${label}：主段 block`, Boolean(u.autoAttack?.block), d.Block === 1)
  record(true, u, "aa", raw, "直接伤害", `Block ${bitsText(want)}`)
}

function auditSkill(u, slot, raw, gen) {
  const ds = damagesOf(raw)
  if (!ds.length) {
    if (gen?.hits || gen?.splashHits || gen?.altHits?.length || gen?.bonus) {
      fail(`${u.name} ${slot}`, "原数据没有 Damage，但生成结果存在伤害段")
    }
    return
  }

  const label = `${u.name} ${slot === "skill" ? "普技" : "EX"}「${raw.Name}」`
  for (const [i, d] of ds.entries()) {
    if (![0, 1].includes(d.Block)) fail(`${label} Damage#${i + 1}`, `当前角色池出现未实现的 Block=${d.Block}`)
  }
  count(slot, ds[0].Block === 1)
  assert(`${label}：主段 block`, Boolean(gen?.block), ds[0].Block === 1)

  const desc = String(raw.Desc || "")
  if (ds.length === 1 && hasZone(ds[0])) {
    summary.zone++
    assert(`${label}：场地伤害不生成即时 hits`, Boolean(gen?.hits), false)
    assert(`${label}：场地伤害存在 Zone`, Boolean(gen?.effects?.some((e) => e.type === "dot" && e.icon === "Zone")), true)
    // 当前场地技两条都是 Block=0；若以后出现 Block=1，必须设计「圈是否被掩体接走」，不能静默放行。
    assert(`${label}：场地伤害必须是 Block=0`, ds[0].Block, 0)
    record(true, u, slot, raw, "场地伤害", "Block 0，落地后持续跳伤，不进掩体格挡")
    return
  }

  if (isSplash(desc) && ds.length > 1) {
    summary.mixed++
    const all = ds.flatMap(bitsOf)
    const splash = ds.slice(1).flatMap(bitsOf)
    assertBits(`${label}：主目标全部伤害段`, gen?.hitBlocks, all)
    assertBits(`${label}：扩散伤害段`, gen?.splashHitBlocks, splash)
    record(true, u, slot, raw, "直击＋扩散", `主目标 ${bitsText(all)}，扩散 ${bitsText(splash)}`)
    return
  }

  if (hasFury(desc) && ds.length > 1) {
    summary.alt++
    assertBits(`${label}：基础形态`, gen?.hitBlocks, bitsOf(ds[0]))
    assert(`${label}：Fury 档数量`, gen?.altHits?.length, 1)
    assertBits(`${label}：Fury 形态`, gen?.altHits?.[0]?.hitBlocks, bitsOf(ds[1]))
    record(true, u, slot, raw, "条件替换", `基础 ${bitsText(bitsOf(ds[0]))}，Fury ${bitsText(bitsOf(ds[1]))}`)
    return
  }

  if (hasEnergy(desc) && ds.length > 1) {
    summary.alt++
    assertBits(`${label}：空充形态`, gen?.hitBlocks, bitsOf(ds[0]))
    for (const alt of gen?.altHits || []) {
      assertBits(`${label}：能量 ${alt.min} 档`, alt.hitBlocks, bitsOf(ds[alt.min]))
    }
    assert(`${label}：能量档数量`, gen?.altHits?.length, ds.length - 1)
    record(true, u, slot, raw, "条件替换", `空/半/满 ${ds.map((d) => bitsText(bitsOf(d))).join("/")}`)
    return
  }

  if (hasBonus(desc) && ds.length > 1) {
    summary.bonus++
    assertBits(`${label}：主伤害`, gen?.hitBlocks, bitsOf(ds[0]))
    assertBits(`${label}：概率追伤`, gen?.bonus?.hitBlocks, bitsOf(ds[1]))
    record(true, u, slot, raw, "概率追伤", `主伤害 ${bitsText(bitsOf(ds[0]))}，追伤 ${bitsText(bitsOf(ds[1]))}`)
    return
  }

  if (ds.length > 1 && ds.slice(1).every(isXLargeOnly)) {
    summary.unreachable++
    const currentSizes = new Set(ROSTER.map((x) => STUDENTS[x.sid]?.Size))
    assert(`${label}：当前 PvP 单位均非超大型`, [...currentSizes], ["Medium"])
    assertBits(`${label}：只保留常规目标主伤害`, gen?.hitBlocks, bitsOf(ds[0]))
    assert(`${label}：不生成无条件追伤`, Boolean(gen?.bonus || gen?.altHits?.length || gen?.splashHits), false)
    record(true, u, slot, raw, "不可达条件", `主伤害 ${bitsText(bitsOf(ds[0]))}；超大型追加在当前全 Medium 角色池不触发`)
    return
  }

  if (ds.length > 1) {
    fail(label, `存在 ${ds.length} 条 Damage，但未归类为扩散 / 条件替换 / 概率追伤 / 不可达条件`)
    record(false, u, slot, raw, "未归类", ds.map((d) => bitsText(bitsOf(d))).join("/"))
    return
  }

  // 单 Damage 的普通路径。目标数 / 圈数 / 连发会改变 hits 的形状，但这一条 Damage 内所有段 Block 相同。
  const want = ds[0].Block === 1
  const got = gen?.hitBlocks
  if (!Array.isArray(got) || !got.length || got.some((b) => Boolean(b) !== want)) {
    fail(`${label}：全部生成段继承 Damage.Block`, `实际 ${bitsText(got || [])}，期望全部为 ${want ? 1 : 0}`)
  }
  record(true, u, slot, raw, "直接伤害", `Block ${bitsText(got || [])}`)
}

function auditCharge(u, student) {
  const exRaw = one(student.Skills?.Ex)
  const form = (exRaw?.Effects || []).find((e) => e.Type === "Special" && e.Key === "FormChange")
  if (!form) return
  summary.charge++
  const fc = one(student.Skills?.Normal)?.FormChange
  const d = damagesOf(fc)[0]
  const eff = u.ex?.effects?.find((e) => e.type === "charge")
  const label = `${u.name} 强化普攻`
  if (!d) {
    fail(label, "EX 含 FormChange，但 Normal.FormChange 没有 Damage")
    return
  }
  if (![0, 1].includes(d.Block)) fail(label, `当前角色池出现未实现的 Block=${d.Block}`)
  assertBits(`${label}：读取 FormChange 自己的 Block`, eff?.hitBlocks, bitsOf(d))
  assert(`${label}：主段 block`, Boolean(eff?.block), d.Block === 1)
  lines.push(`✓ ${u.name} 强化普攻｜FormChange｜Block ${bitsText(bitsOf(d))}`)
}

for (const u of ROSTER) {
  const student = STUDENTS[u.sid]
  if (!student) {
    fail(u.name, `students.json 找不到 sid=${u.sid}`)
    continue
  }
  auditAuto(u, student)
  auditCharge(u, student)
  const publicRaw = one(u.gearSkill ? student.Skills?.GearPublic : student.Skills?.Public)
  const exRaw = one(student.Skills?.Ex)
  auditSkill(u, "skill", publicRaw, u.skill)
  auditSkill(u, "ex", exRaw, u.ex)
}

// 生成结果自身的不变量：凡是存在即时伤害数组，就必须有等长的分段掩体标记。
for (const u of ROSTER) {
  for (const [slot, sk] of [["普攻", u.autoAttack], ["普技", u.skill], ["EX", u.ex]]) {
    if (!sk) continue
    if (sk.hits) assert(`${u.name} ${slot}：hits / hitBlocks 等长`, sk.hitBlocks?.length, sk.hits.length)
    if (sk.splashHits) assert(`${u.name} ${slot}：splashHits / splashHitBlocks 等长`, sk.splashHitBlocks?.length, sk.splashHits.length)
    for (const [i, alt] of (sk.altHits || []).entries()) {
      assert(`${u.name} ${slot}：alt#${i + 1} hits / hitBlocks 等长`, alt.hitBlocks?.length, alt.hits.length)
    }
    if (sk.bonus) assert(`${u.name} ${slot}：bonus hits / hitBlocks 等长`, sk.bonus.hitBlocks?.length, sk.bonus.hits.length)
    for (const [i, eff] of (sk.effects || []).filter((e) => e.type === "charge").entries()) {
      assert(`${u.name} ${slot}：charge#${i + 1} hits / hitBlocks 等长`, eff.hitBlocks?.length, eff.hits.length)
    }
  }
}

console.log("=== BA 攻击 / 掩体数据审计 ===")
console.log(`角色：${summary.units} 人；攻击入口：${summary.entries} 项`)
console.log(`普攻：${summary.aa.total}（可挡 ${summary.aa.block} / 无视 ${summary.aa.bypass}）`)
console.log(`普技：${summary.skill.total}（主段可挡 ${summary.skill.block} / 主段无视 ${summary.skill.bypass}）`)
console.log(`EX：${summary.ex.total}（主段可挡 ${summary.ex.block} / 主段无视 ${summary.ex.bypass}）`)
console.log(`特殊映射：直击＋扩散 ${summary.mixed}，条件替换 ${summary.alt}，概率追伤 ${summary.bonus}，场地 ${summary.zone}，强化普攻 ${summary.charge}，当前不可达条件 ${summary.unreachable}`)
if (VERBOSE) {
  console.log("\n=== 逐项结果 ===")
  console.log(lines.join("\n"))
}
console.log(bad ? `\n✗ 审计失败：${bad} 项不符` : "\n✓ 全部攻击入口与原始 Damage.Block 一致")
process.exit(bad ? 1 : 0)
