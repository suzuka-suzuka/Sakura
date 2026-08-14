/**
 * 文本格式化工具。
 *
 * 实际战斗只发送战场图；这里的战况文本保留给规则测试和渲染失败时的人工诊断，
 * 图鉴文字则仍是角色卡生成失败时的降级内容。
 */

import { CFG, ROSTER, BY_INDEX, combatRoleOf } from "./roster.js"
import { tmplOf, nameOf, atkOf, regenOf, aliveOf, exHandOf } from "./engine.js"

const SIDE_NAME = ["蓝方", "红方"]
const SIDE_MARK = ["🔵", "🔴"]

/** 10 格血条 */
function hpBar(u) {
  if (!u.alive) return "▬▬▬▬▬▬▬▬▬▬"
  const n = Math.max(1, Math.round((u.hp / u.maxhp) * 10))
  return "█".repeat(n) + "░".repeat(10 - n)
}

/** 状态图标：只显示会影响下一步决策的那几种 */
function statusIcons(u) {
  const s = []
  if (!u.alive) return "💀"
  if (u.shield > 0) s.push(`🛡${Math.round(u.shield)}`)
  if (u.stun > 0) s.push("💫晕")
  if (u.taunt > 0) s.push("🎯嘲讽")
  if (u.reflect > 0) s.push("⟲反伤")
  if (u.dots.length) {
    const dotLayers = new Set(u.dots.map((dot) => dot.sourceKey))
    s.push(`🔥灼烧${dotLayers.size > 1 ? dotLayers.size : ""}`)
  }
  const summary = (stat) => {
    const bySource = new Map()
    for (const status of u.buffs) {
      if (status.stat !== stat) continue
      bySource.set(`${status.effectKind}:${status.sourceKey}`, status)
    }
    const layers = [...bySource.values()]
    const factor = layers.reduce((value, status) => value * (1 + status.value), 1)
    return { value: factor - 1, layers: layers.length }
  }
  const atkMod = summary("atk")
  const dfsMod = summary("dfs")
  const dmgUp = summary("dmg_deal")
  const dmgTake = summary("dmg_take")
  const layerLabel = (label, data) => `${label}${data.layers > 1 ? data.layers : ""}`
  if (atkMod.layers) s.push(`${layerLabel("攻", atkMod)}${atkMod.value > 0 ? "+" : ""}${Math.round(atkMod.value * 100)}%`)
  if (dfsMod.layers) s.push(`${layerLabel("防", dfsMod)}${dfsMod.value > 0 ? "+" : ""}${Math.round(dfsMod.value * 100)}%`)
  if (dmgUp.layers) s.push(`${layerLabel("增伤", dmgUp)}${dmgUp.value > 0 ? "+" : ""}${Math.round(dmgUp.value * 100)}%`)
  if (dmgTake.layers) s.push(`${layerLabel("受伤", dmgTake)}${dmgTake.value > 0 ? "+" : ""}${Math.round(dmgTake.value * 100)}%`)
  return s.join(" ")
}

/** 单侧的四个格子 */
function sideBlock(state, side) {
  const s = state.sides[side]
  const lines = [
    `${SIDE_MARK[side]} ${SIDE_NAME[side]}　Cost ${s.cost}/${CFG.COST_MAX}　回复 +${regenOf(s)}`,
    `🎴 ${renderExWindow(state, side)}`,
  ]
  for (const u of s.units) {
    const t = tmplOf(u)
    const cd = u.alive
      ? `⚡${u.skillCd <= 0 ? "就绪" : u.skillCd}`
      : ""
    const st = statusIcons(u)
    lines.push(
      `${u.idx + 1}.${t.name}(${t.atkType}/${t.defType}) ${t.ex.cost}费\n` +
      `   ${hpBar(u)} ${Math.round(u.hp)}/${u.maxhp}${cd ? " " + cd : ""}` +
      (st ? `\n   ${st}` : "")
    )
  }
  return lines.join("\n")
}

/** 当前可释放的两张 EX 技能牌。 */
export function renderExWindow(state, side) {
  const cards = exHandOf(state, side).map((pos) => {
    const u = state.sides[side].units[pos]
    return `${pos + 1}.${tmplOf(u).name}(${tmplOf(u).ex.cost}费)`
  })
  return `EX窗口　${cards.join(" / ") || "无"}`
}

/** 战场态势：双方八格 */
export function renderField(state) {
  return [
    sideBlock(state, 0),
    "　",
    sideBlock(state, 1),
    "　",
    `第 ${state.round} 轮` +
      (state.round >= CFG.SD_START
        ? `　🔥白热化 x${state.round - CFG.SD_START + 1}（全场受伤 +${Math.round((state.round - CFG.SD_START + 1) * CFG.SD_DMG_STEP * 100)}%）`
        : ""),
  ].join("\n")
}

/** 开局揭晓：对位连线一目了然 */
export function renderReveal(state) {
  const line = (side) =>
    state.sides[side].units
      .map((u, i) => `${i + 1}.${tmplOf(u).name}(${tmplOf(u).atkType}/${tmplOf(u).defType})`)
      .join("  ")
  return [
    "⚔️ 阵容揭晓",
    "",
    `${SIDE_MARK[1]} ${state.sides[1].name}`,
    `   ${line(1)}`,
    "    ┆　　┆　　┆　　┆   ← 对位",
    `   ${line(0)}`,
    `${SIDE_MARK[0]} ${state.sides[0].name}`,
    "",
    `${SIDE_NAME[state.first]}先手 Cost ${CFG.COST_START}，${SIDE_NAME[1 - state.first]}后手 Cost ${CFG.COST_START + CFG.SECOND_BONUS}`,
    "这是回复开始前的开局值；进入回合后按存活人数正常回复",
  ].join("\n")
}

/**
 * 一个回合的战报节点数组。
 * @param {object} state 打完之后的状态
 * @param {string[]} log 引擎日志
 * @param {number} side 行动方
 * @param {{round?:number, costBefore:number, gained:number, skillGained?:number, spent:number, includeField?:boolean}} meta 内核回报的本回合轮数与 Cost 流水
 */
export function renderTurn(state, log, side, meta = {}) {
  const nodes = []
  const s = state.sides[side]
  const { round = state.round, costBefore = s.cost, gained = 0, skillGained = 0, spent = 0, includeField = true } = meta
  // 把「回了多少、花了多少」摊开写，否则回 2 花 2 会显示成没变过
  const flow =
    `Cost ${costBefore}` +
    (gained ? ` +${gained}` : "") +
    (spent ? ` −${spent}` : "") +
    (skillGained ? ` +${skillGained}（小技能）` : "") +
    ` = ${s.cost}`
  nodes.push(
    `${SIDE_MARK[side]} 第 ${round} 轮 · ${SIDE_NAME[side]}回合（${s.name}）\n${flow}`
  )
  // 引擎首行是「--- X方回合（Cost n）---」，渲染时已有更好的抬头，去掉
  const body = log.filter((l) => !l.startsWith("---")).join("\n")
  nodes.push(body || "（无事发生）")
  if (includeField) nodes.push(renderField(state))
  return nodes
}

/** 结算 */
export function renderResult(state) {
  const lines = []
  if (state.winner === -1) {
    lines.push("🏳️ 平局")
  } else {
    const w = state.sides[state.winner]
    lines.push(`🏆 ${SIDE_MARK[state.winner]} ${SIDE_NAME[state.winner]}（${w.name}）胜利！`)
    lines.push(`共 ${state.round} 轮，剩余 ${aliveOf(w).length} 人`)
  }
  lines.push("")
  for (const side of [0, 1]) {
    const s = state.sides[side]
    const hp = s.units.reduce((x, u) => x + u.hp, 0)
    const max = s.units.reduce((x, u) => x + u.maxhp, 0)
    lines.push(`${SIDE_MARK[side]} ${s.name}　剩余总血量 ${((hp / max) * 100).toFixed(1)}%`)
    lines.push(
      "   " + s.units.map((u) => `${tmplOf(u).name}${u.alive ? Math.round(u.hp) : "✝"}`).join(" ")
    )
  }
  lines.push("")
  lines.push(`战斗种子 ${state.seed}（可复现）`)
  return lines.join("\n")
}

/** 角色图鉴，配队时私聊发送 */
export function renderRoster() {
  const nodes = ["📖 角色图鉴　回复 4 个编号完成配队（顺序 = 1~4 号位）\n例：14 5 9 1　或　震荡 秘仪 秘仪 炎火"]
  const byCost = [...ROSTER].sort((a, b) => a.ex.cost - b.ex.cost)
  const idxOf = (t) => ROSTER.indexOf(t) + 1

  let chunk = []
  for (const t of byCost) {
    chunk.push(
      `${idxOf(t)}. ${t.name}　${t.atkType}/${t.defType}\n` +
      `   定位 ${combatRoleOf(t)}\n` +
      `   生命${t.hp} 攻击${t.atk} 防御${t.dfs} 暴击${Math.round(t.crit * 100)}%\n` +
      `   命中${t.acc} 闪避${t.dodge}\n` +
      `   [普技 CD${t.skill.cd}] ${describeEffect(t.skill)}\n` +
      `   [EX ${t.ex.cost}费] ${describeEffect(t.ex)}`
    )
    if (chunk.length === 4) { nodes.push(chunk.join("\n\n")); chunk = [] }
  }
  if (chunk.length) nodes.push(chunk.join("\n\n"))

  nodes.push(
    "克制关系（克制 ×1.35 / 被抵抗 ×0.75）\n" +
    "爆发 → 克轻装，被重装抵抗\n" +
    "贯通 → 克重装，被特殊抵抗\n" +
    "神秘 → 克特殊，被轻装抵抗\n" +
    "振动 → 克弹力，被特殊抵抗\n" +
    "\n" +
    `命中 vs 闪避\n` +
    `被闪避率 =（目标闪避 − 我方命中）÷ ${CFG.DODGE_K}，上限 ${Math.round(CFG.DODGE_CAP * 100)}%\n` +
    "即每 2 点差 1%，命中追平闪避就完全打不空。\n" +
    "每名角色只有一个命中值，普攻、普通技能和 EX 全部共用。\n" +
    "命中与攻击、攻防血量、闪避、技能 Cost/效果一起构成角色取舍，不按单项硬换算。"
  )
  return nodes
}

const TARGET_TEXT = {
  lane: "对线目标",
  lane_splash: "对位三格",
  enemy_all: "敌方全体",
  enemy_random: "随机敌人",
  enemy_single: "指定单体",
  ally_all: "己方全体",
  ally_lowest: "己方最残",
  self: "自身",
}

export function describeEffect(e) {
  const tg = TARGET_TEXT[e.target || "lane"]
  if ((e.kind || "damage") === "damage") {
    let s = `${tg} ${Math.round(e.mult * 100)}%`
    if (e.hits) s += ` ×${e.hits}`
    if (e.splash) s += `（两侧 ${Math.round(e.splash * 100)}%）`
    if (e.forceCrit) s += "，必定暴击"
    if (e.stun) s += "，眩晕 1 回合"
    if (e.execBonus) s += `，目标生命≤${Math.round(e.execBonus[0] * 100)}% 时 ×${e.execBonus[1]}`
    if (e.detonate) s += `，引爆灼烧追加 ${Math.round(e.detonate * 100)}%`
    if (e.dot) s += `，灼烧 ${Math.round(e.dot.value * 100)}%攻 ×后续${e.dot.turns}个自身回合（必中）`
    if (e.costGain) s += `，回复 ${e.costGain} Cost（不依赖命中）`
    for (const d of e.debuffs || []) {
      s += `，${d.stat === "dfs" ? "防御" : "攻击"} ${d.value > 0 ? "+" : ""}${Math.round(d.value * 100)}%/${d.turns}回合`
    }
    if (e.selfHeal) s += `，自愈 ${Math.round(e.selfHeal * 100)}%攻`
    for (const b of e.selfBuffs || []) {
      s += `，自身受伤 ${b.value > 0 ? "+" : ""}${Math.round(b.value * 100)}%/${b.turns}回合`
    }
    return s
  }
  const p = []
  if (e.heal) p.push(`治疗 ${Math.round(e.heal * 100)}%攻`)
  if (e.shield) p.push(`护盾 ${Math.round(e.shield * 100)}%攻/${e.shieldTurns ?? 2}回合`)
  if (e.taunt) p.push("嘲讽 1 回合")
  if (e.reflect) p.push(`反伤 ${Math.round(e.reflect * 100)}%`)
  if (e.cleanse) p.push("清除减益")
  for (const b of e.buffs || []) {
    const nm = { dmg_deal: "造成伤害", atk: "攻击力", dmg_take: "受到伤害" }[b.stat] || b.stat
    p.push(`${nm} ${b.value > 0 ? "+" : ""}${Math.round(b.value * 100)}%/${b.turns}回合`)
  }
  return `${tg}：${p.join("、")}`
}

/** 单个角色详情，#档案图鉴 炎火 */
export function renderOne(t) {
  const idx = ROSTER.indexOf(t) + 1
  return (
    `${idx}. ${t.name}　${t.atkType}/${t.defType}\n` +
    `定位 ${combatRoleOf(t)}\n` +
    `生命 ${t.hp}\n` +
    `攻击 ${t.atk}　防御 ${t.dfs}　暴击 ${Math.round(t.crit * 100)}%\n` +
    `命中 ${t.acc}（所有攻击共用）　闪避 ${t.dodge}\n\n` +
    `[普通技能 CD${t.skill.cd}]\n${describeEffect(t.skill)}\n\n` +
    `[EX ${t.ex.cost} 费]\n${describeEffect(t.ex)}`
  )
}

export { SIDE_NAME, SIDE_MARK }
