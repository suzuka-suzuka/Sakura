/**
 * 文本格式化工具。
 *
 * 实际战斗只发送战场图；这里的战况文本保留给规则测试和渲染失败时的人工诊断，
 * 图鉴文字则仍是角色卡生成失败时的降级内容。
 */

import { CFG, ROSTER, combatRoleOf } from "./roster.js"
import { ARMOR_LABEL } from "./htmlAssets.js"
import {
  tmplOf, nameOf, regenOf, aliveOf, exWaitOf,
  hitChance, critChance, defModOf, stabilityFloor,
} from "./engine.js"

const SIDE_NAME = ["蓝方", "红方"]
const SIDE_MARK = ["🔵", "🔴"]

const pct = (v) => `${(v * 100).toFixed(1)}%`

/** 10 格血条 */
function hpBar(u) {
  if (!u.alive) return "▬▬▬▬▬▬▬▬▬▬"
  const n = Math.max(1, Math.round((u.hp / u.maxhp) * 10))
  return "█".repeat(n) + "░".repeat(10 - n)
}

/** 状态图标：只显示会影响下一步决策的那几种 */
function statusIcons(u) {
  if (!u.alive) return "💀"
  const s = []
  if (u.shield > 0) s.push(`🛡${Math.round(u.shield)}`)
  if (u.stun > 0) s.push(`💫晕${u.stun}`)
  if (u.taunt > 0) s.push("🎯嘲讽")
  if (u.regens.length) s.push(`💚持续治疗${u.regens.length > 1 ? u.regens.length : ""}`)

  const summary = (stat) => {
    const bySource = new Map()
    for (const st of u.buffs) {
      if (st.stat !== stat) continue
      bySource.set(`${st.effectKind}:${st.sourceKey}`, st)
    }
    const layers = [...bySource.values()]
    return { value: layers.reduce((v, st) => v * (1 + st.value), 1) - 1, layers: layers.length }
  }
  const LABEL = { atk: "攻", dfs: "防", dmg_deal: "增伤", dmg_take: "受伤", crit: "暴击", crit_dmg: "暴伤", acc: "命中", dodge: "闪避", heal: "治疗" }
  for (const [stat, label] of Object.entries(LABEL)) {
    const m = summary(stat)
    if (!m.layers) continue
    s.push(`${label}${m.layers > 1 ? m.layers : ""}${m.value > 0 ? "+" : ""}${Math.round(m.value * 100)}%`)
  }
  return s.join(" ")
}

/** 普通技能的当前状态：用完 / 条件未满足 / 冷却中 / 就绪 */
function skillState(u, tmpl) {
  const tr = tmpl.skill?.trigger
  if (!tr) return "无技能"
  if (tr.maxUses && u.skillUses >= tr.maxUses) return "已用完"
  if (tr.type === "hp_below") return `待触发(≤${Math.round(tr.value * 100)}%)`
  return u.skillCd <= 0 ? "就绪" : String(u.skillCd)
}

/** 单侧的四个格子 */
function sideBlock(state, side) {
  const s = state.sides[side]
  const lines = [
    `${SIDE_MARK[side]} ${SIDE_NAME[side]}　Cost ${s.cost}/${CFG.COST_MAX}　回复 +${regenOf(s, state)}`,
    `🎴 ${renderExWindow(state, side)}`,
  ]
  for (const u of s.units) {
    const t = tmplOf(u)
    const cd = u.alive ? `⚡${skillState(u, t)}` : ""
    const st = statusIcons(u)
    lines.push(
      `${t.name}(${t.atkType}/${t.defType}) ${t.ex.cost}费\n` +
      `   ${hpBar(u)} ${Math.round(u.hp)}/${u.maxhp}${cd ? " " + cd : ""}` +
      (st ? `\n   ${st}` : "")
    )
  }
  return lines.join("\n")
}

/** 当前能放的 EX；冷却中的一并列出还差几个。 */
export function renderExWindow(state, side) {
  const s = state.sides[side]
  const ready = [], cooling = []
  for (const u of s.units) {
    if (!u.alive) continue
    const label = `${tmplOf(u).name}(${tmplOf(u).ex.cost}费)`
    const wait = exWaitOf(s, u)
    if (wait) cooling.push(`${label}还需${wait}`)
    else ready.push(label)
  }
  return `可放 EX　${ready.join(" / ") || "无"}` +
    (cooling.length ? `\n冷却中　${cooling.join(" / ")}` : "")
}

/** 战场态势：双方八格 */
export function renderField(state) {
  return [
    sideBlock(state, 0),
    "　",
    sideBlock(state, 1),
    "　",
    `第 ${state.round} 轮` +
      (state.fever ? `　🔥白热化（Cost 回复 ×${CFG.FEVER_COST_MULT}，防御/闪避/受治疗 −${Math.round(CFG.FEVER_DEBUFF * 100)}%）` : ""),
  ].join("\n")
}

/** 开局揭晓：对位连线一目了然 */
export function renderReveal(state) {
  const line = (side) =>
    state.sides[side].units
      .map((u) => `${tmplOf(u).name}(${tmplOf(u).atkType}/${tmplOf(u).defType})`)
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
    `Cost 在每个回合结束时才回复（存活人数 × ${CFG.COST_REGEN_PER_UNIT}），所以首轮双方都是拿开局值直接打`,
  ].join("\n")
}

/**
 * 逐行日志 → 合并转发的节点，**一次行动一个节点**。
 *
 * 引擎的日志是「[方] 谁干了什么」加若干条两空格缩进的明细，一行一个节点会把
 * 转发撑成十几条，点开全是碎片；按行动归并正好是玩家读战报的粒度（4 人满编约 5 条）。
 * 回合头和「过」并进第一个节点——它们不是行动，单独占一条纯属噪音。
 */
export function mergeTurnLog(log) {
  const nodes = []
  for (const line of log || []) {
    if (line == null || line === "") continue
    // 缩进行是上一条行动的明细；回合头与「过」不单独成节点
    const attach = /^\s{2}/.test(line) || /^\[[^\]]+\]\s*过$/.test(line)
    if (attach && nodes.length) nodes[nodes.length - 1] += `\n${line}`
    else nodes.push(line)
  }
  return nodes
}

/** 一个回合的战报节点数组。 */
export function renderTurn(state, log, side, meta = {}) {
  const nodes = []
  const s = state.sides[side]
  const { round = state.round, costBefore = s.cost, gained = 0, skillGained = 0, spent = 0, includeField = true } = meta
  const flow =
    `Cost ${costBefore}` +
    (gained ? ` +${gained}` : "") +
    (spent ? ` −${spent}` : "") +
    (skillGained ? ` ${skillGained > 0 ? "+" : ""}${skillGained}（技能）` : "") +
    ` = ${s.cost}`
  nodes.push(`${SIDE_MARK[side]} 第 ${round} 轮 · ${SIDE_NAME[side]}回合（${s.name}）\n${flow}`)
  const body = log.filter((l) => !l.startsWith("---")).join("\n")
  nodes.push(body || "（无事发生）")
  if (includeField) nodes.push(renderField(state))
  return nodes
}

/** 结算 */
export function renderResult(state) {
  const lines = []
  if (state.winner === -1) lines.push("🏳️ 平局")
  else {
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
    lines.push("   " + s.units.map((u) => `${tmplOf(u).name}${u.alive ? Math.round(u.hp) : "✝"}`).join(" "))
  }
  lines.push("")
  lines.push(`战斗种子 ${state.seed}（可复现）`)
  return lines.join("\n")
}

// ---------------- 技能描述 ----------------

const TARGET_TEXT = {
  enemy_single: "指定单体",
  enemy_adjacent: "指定目标+相邻",
  enemy_all: "敌方全体",
  enemy_random: "随机敌人",
  ally_all: "己方全体",
  ally_adjacent: "指定友方+相邻",
  ally_lowest: "己方最残",
  self: "自身",
}

const STAT_TEXT = {
  atk: "攻击力", dfs: "防御力", heal: "治疗力", maxhp: "生命上限",
  crit: "暴击值", crit_dmg: "暴击伤害", acc: "命中值", dodge: "闪避值",
  dmg_deal: "造成伤害", dmg_take: "受到伤害", heal_taken: "受治疗量",
  atk_flat: "攻击力", dfs_flat: "防御力", heal_flat: "治疗力",
}

const TRIGGER_TEXT = (tr) => {
  if (!tr) return ""
  const uses = tr.maxUses ? `，每场限 ${tr.maxUses} 次` : ""
  if (tr.type === "hp_below") return `生命≤${Math.round(tr.value * 100)}% 时触发${uses}`
  return `每 ${tr.turns} 回合${uses}`
}

export function describeEffect(sk) {
  if (!sk) return "无"
  const parts = []
  const tg = TARGET_TEXT[sk.target] || sk.target
  if (sk.hits?.length) {
    const total = sk.hits.reduce((a, b) => a + b, 0)
    const scope = sk.target === "enemy_adjacent" ? `${tg}共${sk.count}人` : tg
    parts.push(`${scope} ${total.toFixed(0)}%攻击力${sk.hits.length > 1 ? ` 分${sk.hits.length}段` : ""}`)
  }
  for (const e of sk.effects || []) {
    const who = e.scope === "self" ? "自身" : e.scope === "ally_all" ? "己方全体" : "目标"
    switch (e.type) {
      case "buff":
        parts.push(`${who}${STAT_TEXT[e.stat] || e.stat} ${e.value > 0 ? "+" : ""}${/_flat$/.test(e.stat) ? e.value : pct(e.value)}（${e.turns}回合）`)
        break
      case "heal": parts.push(`${who}治疗 ${pct(e.scale)}治疗力`); break
      case "regen": parts.push(`${who}持续治疗 ${pct(e.scale)}治疗力（${e.turns}回合，每${e.period}回合）`); break
      case "shield": parts.push(`${who}护盾 ${pct(e.scale)}治疗力（${e.turns}回合）`); break
      // 技能 1 级时控制时长是 0，效果根本不存在 —— 与其写「无效」不如不写
      case "cc":
        if (e.inactive || !e.turns) break
        parts.push(`${who}眩晕 ${e.turns} 回合${e.chance < 1 ? `（${pct(e.chance)}）` : ""}`)
        break
      case "cleanse": parts.push(`${who}清除减益`); break
      case "taunt": parts.push(`${who}嘲讽 ${e.turns} 回合`); break
      case "cost": parts.push(`Cost ${e.value > 0 ? "+" : ""}${e.value}`); break
    }
  }
  if (sk.thenAutoAttack) parts.push("立即普攻一次")
  return parts.join("，") || "无效果"
}

/**
 * 精简图鉴：按攻击属性分组，一个属性一段文本（调用方一段发一条消息）。
 *
 * 配队时真正要比的是属性对位和技能效果，数值面板反而是噪音；
 * 要看完整数值就单独查 `档案图鉴 星野`，那才发角色卡图。
 */
export function renderRosterByType() {
  const groups = new Map()
  for (const t of ROSTER) {
    if (!groups.has(t.atkType)) groups.set(t.atkType, [])
    groups.get(t.atkType).push(t)
  }
  return [...groups].map(([atk, list]) => {
    const body = list.map((t) => [
      `${t.name}　${combatRoleOf(t)}　${atk}攻击 / ${ARMOR_LABEL[t.defType] || t.defType}`,
      `　普技「${t.skill?.name || "无"}」${describeEffect(t.skill)}`,
      `　EX「${t.ex.name}」${t.ex.cost}费　${describeEffect(t.ex)}`,
    ].join("\n"))
    return `◤ ${atk}攻击 ◢　${list.length} 人\n\n${body.join("\n\n")}`
  })
}

/** 角色图鉴，配队时私聊发送 */
export function renderRoster() {
  const nodes = [
    `📖 角色图鉴（${ROSTER.length} 人）　回复 4 个编号完成配队（顺序 = 1~4 号位）\n` +
    `例：1 2 3 4　或　星野 白子 野宫 芹香`,
  ]
  const byCost = [...ROSTER].sort((a, b) => a.ex.cost - b.ex.cost)
  const idxOf = (t) => ROSTER.indexOf(t) + 1

  let chunk = []
  for (const t of byCost) {
    chunk.push(
      `${idxOf(t)}. ${t.name}　${t.atkType}/${t.defType}　定位 ${combatRoleOf(t)}\n` +
      `   生命${t.hp} 攻击${t.atk} 防御${t.dfs} 治疗${t.healPower}\n` +
      `   命中${t.acc} 闪避${t.dodge} 暴击${t.crit} 暴伤${(t.critDmg / 10000).toFixed(1)}x 稳定${t.stability}\n` +
      `   [普攻] ${t.autoAttack.hits.reduce((a, b) => a + b, 0).toFixed(0)}% 分${t.autoAttack.hits.length}段\n` +
      `   [普通技能 ${TRIGGER_TEXT(t.skill?.trigger)}] ${t.skill?.name || "无"}\n` +
      `      ${describeEffect(t.skill)}\n` +
      `   [EX ${t.ex.cost}费] ${t.ex.name}\n` +
      `      ${describeEffect(t.ex)}`
    )
    if (chunk.length === 3) { nodes.push(chunk.join("\n\n")); chunk = [] }
  }
  if (chunk.length) nodes.push(chunk.join("\n\n"))

  nodes.push(
    "【属性克制】数值取自原作，非对称\n" +
    "爆发 → 轻装甲×2.0　重装甲×1.0　特殊×0.5　弹力×0.5\n" +
    "贯通 → 重装甲×2.0　轻装甲×0.5　特殊×1.0　弹力×1.0\n" +
    "神秘 → 特殊×2.0　重装甲×0.5　轻装甲×1.0　弹力×1.0\n" +
    "振动 → 弹力×2.0　特殊×1.5　重装甲×0.5　轻装甲×1.0"
  )
  nodes.push(
    "【战斗公式】全部照搬原作\n" +
    `命中率 = ${CFG.HIT_BASE} ÷ ((闪避−命中)×${CFG.HIT_C} + ${CFG.HIT_BASE})，命中≥闪避时必中\n` +
    `暴击率 = 1 − ${CFG.CRIT_BASE} ÷ ((暴击−暴抵)×${CFG.CRIT_C} + ${CFG.CRIT_BASE})，取不到100%\n` +
    `防御系数 = ${CFG.DEF_BASE} ÷ (防御×${CFG.DEF_C} + ${CFG.DEF_BASE})\n` +
    `伤害浮动 = [稳定值÷(稳定值+${CFG.STAB_BASE}) + 0.2, 1] 区间均匀分布\n` +
    "分段攻击的每一段独立判定命中与暴击，段数越多方差越小"
  )
  return nodes
}

/** 单个角色详情，#档案图鉴 星野 */
export function renderOne(t) {
  const idx = ROSTER.indexOf(t) + 1
  return (
    `${idx}. ${t.name}　${t.atkType}/${t.defType}　定位 ${combatRoleOf(t)}　${t.star}★\n\n` +
    `生命 ${t.hp}　攻击 ${t.atk}　防御 ${t.dfs}　治疗 ${t.healPower}\n` +
    `命中 ${t.acc}　闪避 ${t.dodge}　暴击 ${t.crit}　暴伤 ${(t.critDmg / 10000).toFixed(1)}x\n` +
    `稳定 ${t.stability}（伤害下限 ${pct(Math.min(1, t.stability / (t.stability + CFG.STAB_BASE) + 0.2))}）\n\n` +
    `[普攻] ${t.autoAttack.hits.reduce((a, b) => a + b, 0).toFixed(0)}% 分 ${t.autoAttack.hits.length} 段\n\n` +
    `[普通技能] ${t.skill?.name || "无"}　${TRIGGER_TEXT(t.skill?.trigger)}\n${describeEffect(t.skill)}\n\n` +
    `[EX ${t.ex.cost} 费] ${t.ex.name}\n${describeEffect(t.ex)}`
  )
}

/** 两个角色对位时的实际命中/暴击/减伤，用于验算 */
export function renderMatchup(aUnit, bUnit) {
  return [
    `${nameOf(aUnit)} → ${nameOf(bUnit)}`,
    `  命中率 ${pct(hitChance(aUnit, bUnit))}　暴击率 ${pct(critChance(aUnit, bUnit))}`,
    `  防御减伤 ${pct(1 - defModOf(bUnit))}　伤害下限 ${pct(stabilityFloor(aUnit))}`,
  ].join("\n")
}

export { SIDE_NAME, SIDE_MARK }
