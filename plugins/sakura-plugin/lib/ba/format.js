/**
 * 文本格式化工具。
 *
 * 实际战斗只发送战场图；这里的战况文本保留给规则测试和渲染失败时的人工诊断，
 * 图鉴文字则仍是角色卡生成失败时的降级内容。
 */

import { CFG, ROSTER, BY_ID, combatRoleOf } from "./roster.js"
import { ARMOR_LABEL } from "./htmlAssets.js"
import {
  tmplOf, nameOf, regenOf, aliveOf, exWaitOf, exRefreshPending, exCostOf, provokedBy, focusedOf,
  hitChance, critChance, defModOf, stabilityFloor, CC_TEXT,
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
function statusIcons(u, provoker) {
  if (!u.alive) return "💀"
  const s = []
  if (u.shield > 0) s.push(`🛡${Math.round(u.shield)}`)
  if (u.stun > 0) s.push(`💫晕${u.stun}`)
  // 嘲讽的状态挂在**被拉走的人**身上，写清是被谁拉的；集火才是挂在被点名的人自己头上
  if (provoker) s.push(`❗被${nameOf(provoker)}嘲讽`)
  if (focusedOf(u)) s.push("🎯被集火")
  if (u.regens.length) s.push(`💚持续治疗${u.regens.length > 1 ? u.regens.length : ""}`)
  if (u.immortal > 0) s.push(`❤️不死${u.immortal}`)
  if (u.exDiscount?.uses) s.push(`⏬EX减费${u.exDiscount.uses}次`)
  if (u.charge) s.push(`⚡形态转换${u.charge.turns ?? u.charge.shots}`)

  const summary = (stat) => {
    const bySource = new Map()
    for (const st of u.buffs) {
      if (st.stat !== stat) continue
      bySource.set(`${st.effectKind}:${st.sourceKey}`, st)
    }
    const layers = [...bySource.values()]
    return { value: layers.reduce((v, st) => v * (1 + st.value), 1) - 1, layers: layers.length }
  }
  const LABEL = { atk: "攻", dfs: "防", dmg_deal: "增伤", aa: "速", dmg_take: "受伤", crit: "暴击", crit_dmg: "暴伤", acc: "命中", dodge: "闪避", heal: "治疗" }
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
  // 泉奈按枪数攒，冷却恒为 0，只报「已经打了几枪」才有信息量。
  // 攻速会让一回合攒到不止一枪，所以带小数（见 tryAutoProc）
  if (tr.type === "on_auto" && tr.every) {
    const n = u.autoCount || 0
    return `${Number.isInteger(n) ? n : n.toFixed(1)}/${tr.every} 枪`
  }
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
    const st = statusIcons(u, provokedBy(state, u))
    lines.push(
      `${t.name}(${t.atkType}/${t.defType}) ${exCostOf(u)}费\n` +
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
    const label = `${tmplOf(u).name}(${exCostOf(u)}费)`
    const wait = exRefreshPending(state, s) ? 0 : exWaitOf(s, u)
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
      (state.fever ? `　🔥白热化（场上主力 Cost 回复 ×${CFG.FEVER_COST_MULT}，支援仍为 0.5，防御/闪避/受治疗 −${Math.round(CFG.FEVER_DEBUFF * 100)}%）` : ""),
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
  enemy_chain: "连发逐枪重锁",
  enemy_cycle: "从自己对位起按号位循环点名",
  ally_all: "己方全体",
  ally_adjacent: "指定友方+相邻",
  ally_single: "指定友方",
  ally_lowest: "己方最残",
  ally_hurt: "己方受伤的（就近）",
  ally_maxhp: "己方生命上限最高",
  self: "自身",
}

const STAT_TEXT = {
  atk: "攻击力", dfs: "防御力", heal: "治疗力", maxhp: "生命上限",
  crit: "暴击值", crit_dmg: "暴击伤害", acc: "命中值", dodge: "闪避值",
  dmg_deal: "造成伤害", dmg_take: "受到伤害", heal_taken: "受治疗量",
  aa: "攻速", cost_regen: "Cost回复",
  atk_flat: "攻击力", dfs_flat: "防御力", heal_flat: "治疗力",
  crit_res: "暴击抵抗", crit_dmg_res_flat: "暴伤抵抗", crit_dmg_res: "暴伤抵抗",
  // 属性增伤（爱用品）：按**攻击者自己的弹种**匹配，所以要写清是哪一种
  enh_Explosion: "爆发增伤", enh_Pierce: "贯通增伤", enh_Mystic: "神秘增伤", enh_Sonic: "振动增伤", enh_Chemical: "变化增伤",
}

/** 暴击伤害系的「固定值」单位是万分比（10000 = 100%），直接印原始数字玩家读不懂 */
const BP_FLAT = new Set(["crit_dmg_flat", "crit_dmg_res_flat"])
const flatText = (stat, v) => (BP_FLAT.has(stat) ? pct(v / 1e4) : String(v))

const TRIGGER_TEXT = (tr) => {
  if (!tr) return ""
  const uses = tr.maxUses ? `，每场限 ${tr.maxUses} 次` : ""
  if (tr.type === "hp_below") return `生命≤${Math.round(tr.value * 100)}% 时触发${uses}`
  if (tr.type === "on_auto") {
    // 泉奈是「每 N 枪」而不是「概率 + 冷却」，两种写法都走 on_auto
    if (tr.every) return `每 ${tr.every} 次普攻${uses}`
    return `普攻时 ${Math.round((tr.chance ?? 1) * 100)}% 概率（冷却 ${tr.turns} 回合）${uses}`
  }
  if (tr.type === "on_kill") {
    return tr.turns ? `自己击杀时（冷却 ${tr.turns} 回合）${uses}` : `自己击杀时${uses}`
  }
  // 开局就结算掉了，写「每场限 1 次」反而像是还能等它触发
  if (tr.type === "battle_start") return "战斗开始时"
  return `每 ${tr.turns} 回合${uses}`
}

export function describeEffect(sk) {
  if (!sk) return "无"
  const parts = []
  if (sk.trigger?.type === "on_auto") {
    parts.push(sk.trigger.every
      ? `每 ${sk.trigger.every} 次普攻`
      : `普攻时 ${Math.round((sk.trigger.chance ?? 1) * 100)}% 概率`)
  }
  if (sk.trigger?.type === "on_kill") {
    parts.push(sk.trigger.turns ? `自己击杀时（冷却 ${sk.trigger.turns} 回合）` : "自己击杀时")
  }
  const tg = sk.target === "ally_lowest" && (sk.count || 1) > 1
    ? `己方最残 ${sk.count} 人`
    : (TARGET_TEXT[sk.target] || sk.target)
  // 小春：一个圈丢出去，圈里是敌人就只有伤害、是队友就只有治疗。这条得排在倍率前面，
  // 不然卡面读起来像是「炸完还顺手奶一口」——那正是原来搞错的地方
  if (sk.circle) parts.push("一个圈，砸哪边就只有那边生效，指令里中间那个字选边")
  // 柚子 / 切里诺：「攻击力最高」只写在描述里。有伤害时这条是索敌，没伤害时是集火的选人条件
  if (sk.pick === "max_atk") {
    parts.push("以攻击力最高的敌人为目标（无视战场分割、身位和挡刀）")
  }
  if (sk.hits?.length) {
    const total = sk.hits.reduce((a, b) => a + b, 0)
    const scope = sk.target === "enemy_adjacent"
      ? (sk.depth === "through"
        ? (sk.count >= 3 ? `中间扩散共${sk.count}人（直线贯穿，不问身位）` : `同战场共${sk.count}人（直线贯穿，不问身位）`)
        : sk.count >= 3 ? `横向共${sk.count}人（同身位）`
          : sk.count > 1 ? `同战场共${sk.count}人（须同身位）`
            : tg)
      : tg
    // 连发是「N 枪各锁各的目标」，写成「合计 X% 分 N 段」会让人以为全砸在一个人身上
    if (sk.target === "enemy_chain") {
      parts.push(`连发 ${sk.hits.length} 枪，每枪 ${(total / sk.hits.length).toFixed(0)}%攻击力；只有第一枪听指挥，之后按普攻规则重锁（人偶/前排会吃掉后几枪）`)
    } else if (sk.target === "enemy_cycle") {
      // 循环点名的落点由她自己的号位定死，玩家指不了 —— 这条比倍率更需要说清楚
      parts.push(`点名 ${sk.hits.length} 次，每次 ${(total / sk.hits.length).toFixed(0)}%攻击力；` +
        `从跟自己对位的号位起按号位循环（4 人时有一个吃两下，只剩 1 人就全落他身上），无法指定目标`)
    } else {
      // 小春的两半是互斥的，各挂一个「砸敌方 →」「砸己方 →」才读得出是二选一而不是一发两收。
      // 写「砸哪边」而不是写某个动词 —— 认的是意思，打/攻/揍… 八个字都是敌方
      parts.push(`${sk.circle ? "砸敌方 → " : ""}${scope} ${total.toFixed(0)}%攻击力${sk.hits.length > 1 ? ` 分${sk.hits.length}段` : ""}`)
    }
    // 条件追伤：不写的话卡面上只有最低那一档，玩家看不出这个 EX 为什么值这个费
    for (const a of sk.altHits || []) {
      parts.push(a.state === "fury"
        ? `Fury 状态下改为 ${a.total.toFixed(0)}%`
        : `能量${a.min >= 2 ? "满充" : "半充"}时改为 ${a.total.toFixed(0)}%`)
    }
    if (sk.splashHits?.length) {
      parts.push(`扩散仅同战场同身位，只吃 ${sk.splashHits.reduce((a, b) => a + b, 0).toFixed(0)}%`)
    }
    if (sk.falloff) {
      parts.push(`每多打 1 人衰减 ${Math.round(sk.falloff.rate * 100)}%（最多 ${Math.round(sk.falloff.max * 100)}%）`)
    }
    if (sk.hpRate) {
      const a = sk.hpRate
      parts.push(a.atLo > a.atHi
        ? `目标越残伤害越高（满血 ×${a.atHi}，空血 ×${a.atLo}）`
        : `目标血越满伤害越高（空血 ×${a.atLo}，满血 ×${a.atHi}）`)
    }
  }
  for (const e of sk.effects || []) {
    // 技能 1 级时数值为 0 的效果根本不存在 —— 与其写「无效」不如不写
    if (e.inactive) continue
    const n0 = parts.length
    const who = e.scope === "self" ? "自身"
      : e.scope === "ally_all" ? "己方全体"
        : e.scope === "ally_named" ? `${BY_ID[e.ally]?.name || e.ally}（不在场则不生效）`
          : e.scope === "circle_ally" ? "砸己方 → 同战场同身位 2 人"
            : e.scope === "ally_target"
              ? (sk.target === "ally_adjacent" && (sk.count || 1) > 1 ? `同战场同身位 ${sk.count} 人`
                : sk.target === "ally_lowest" && (sk.count || 1) > 1 ? `最残 ${sk.count} 人`
                  : "该队友")
              : "目标"
    switch (e.type) {
      case "buff":
        parts.push(`${who}${STAT_TEXT[e.stat] || e.stat} ${e.value > 0 ? "+" : ""}${/_flat$/.test(e.stat) ? flatText(e.stat, e.value) : pct(e.value)}（${e.turns}回合）`)
        break
      case "heal": parts.push(`${who}治疗 ${pct(e.scale)}治疗力`); break
      case "ward":
        parts.push(`${who}获得急救（生命≤${Math.round(e.hpMax * 100)}%时消耗，治疗 ${pct(e.scale)}治疗力${e.once ? "，每场限 1 次" : ""}）`)
        break
      case "regen":
        parts.push(`${who}持续治疗 ${pct(e.scale)}治疗力` +
          (e.lostHpRate ? ` + 已损生命 ${pct(e.lostHpRate)}` : "") +
          `（${e.turns}回合，每${e.period}回合）`)
        break
      case "shield": parts.push(`${who}护盾 ${pct(e.scale)}治疗力（${e.turns}回合）`); break
      case "dot":
        // 场地是地上的圈，不是贴在人身上的减益，别写成「灼烧 / 减益」
        if (e.icon === "Zone") {
          parts.push(`场地持续伤害 ${pct(e.scale)}攻击力（${e.turns}回合，盖住同战场两路，不问身位）`)
        } else {
          parts.push(`${who}持续伤害 ${pct(e.scale)}攻击力（${e.turns}回合）`)
        }
        break
      // 技能 1 级时控制时长是 0，效果根本不存在 —— 与其写「无效」不如不写
      case "cc":
        if (e.inactive || !e.turns) break
        parts.push(`${who}${CC_TEXT[e.icon] || "控制"} ${e.turns} 回合${e.chance < 1 ? `（${pct(e.chance)}）` : ""}`)
        break
      case "charge": {
        const total = (e.hits || []).reduce((a, b) => a + b, 0)
        parts.push(
          (e.shots ? `换弹强化：接下来 ${e.shots} 发` : `强化形态：${e.turns} 回合内`) +
          `普攻 ${total.toFixed(0)}%攻击力` + (e.hits?.length > 1 ? ` 分${e.hits.length}段` : "") +
          (e.count > 1 ? `、打 ${e.count} 人（须同战场同身位）` : "") +
          // 索敌变更是这个 EX 最贵的部分，别缩写成「改变索敌」四个字
          (e.targeting === "max_atk" ? "，索敌改为攻击力最高的敌人（只有嘲讽拉得走）" : "")
        )
        break
      }
      case "cleanse": parts.push(`${who}清除减益`); break
      // 自身状态：本身不改面板，价值全在「它让 EX 换一组倍率」上，所以要连着后果一起说
      case "state":
        // 三种自身状态各说各的。少一个分支就会掉进 else 串到别人的文案上 ——
        // 真白的追伤概率曾经被说成「能量充能 +0.125 档」
        parts.push(e.key === "fury"
          ? `进入 Fury（${e.turns}回合）`
          : e.key === "bonusChance"
            ? `下次 EX 的追伤概率 +${(e.step * 100).toFixed(1)}%（最多叠到 +${(e.max * 100).toFixed(1)}%，放完 EX 清零）`
            : e.step ? `能量充能 +${e.step} 档（最高 ${e.max} 档）` : "能量充能清空")
        break
      // 位移换来的是战场分割与对位，不是一段距离 —— 说成「移动」玩家会以为有坐标
      case "reposition":
        parts.push(`与相邻${e.range > 1 ? `${e.range} 格内` : "一格"}的队友交换站位`
          + `（指令写「ex换<队友名>」，不指定就不动；站在中间两格时这一跳能跨过战场分界）`)
        break
      // 嘲讽和集火是两个机制，说法不能混：一个是把敌人拉过来，一个是把火力锁在某个敌人身上
      case "taunt":
        parts.push(e.kind === "focus"
          ? `目标被集火 ${e.turns} 回合（己方攻击都锁它）`
          : `嘲讽：${e.turns} 回合内敌方全体只打自己、且放不出 EX`)
        break
      case "cost": parts.push(`Cost ${e.value > 0 ? "+" : ""}${e.value}`); break
      case "immortal": parts.push(`${who}进入不死状态，生命掉不到 0（${e.turns}回合）`); break
      case "ex_discount":
        parts.push(`${who}EX 费用${e.mode === "pct" ? `减 ${pct(e.value)}` : `减 ${e.value} 点`}（接下来 ${e.uses} 次 EX）`)
        break
      // 自伤是这发 AoE 的代价，得写在效果里 —— 只写伤害会显得她凭空多出一个 746%
      case "hp_cost": parts.push(`代价：自身失去当前生命的 ${pct(e.rate)}`); break
    }
    // 编队条件（绿 ⇄ 桃）：不写的话玩家会以为这条 DoT 是无条件的
    if (e.ifAlly) {
      const who2 = BY_ID[e.ifAlly]?.name || e.ifAlly
      for (let i = n0; i < parts.length; i++) parts[i] += `（仅当${who2}同队时）`
    }
  }
  if (sk.thenAutoAttack) parts.push("换弹后本回合仍普攻")
  return parts.join("，") || "无效果"
}

/** 攻击属性的展示顺序，照原作（爆発 → 貫通 → 神秘 → 振動 → 変化），不按 ROSTER 里的遇见顺序 */
const ATK_ORDER = ["爆发", "贯通", "神秘", "振动", "变化"]

/**
 * 图鉴的分组口径：按攻击属性排原作顺序，组内保持 ROSTER 顺序。
 *
 * 总览图和文字节点**必须共用这一个函数** —— 图是后面几条文字的索引，
 * 两边的属性顺序对不上，玩家从图里挑中的人就得翻着找。
 * @returns {[string, object[]][]}
 */
/** 图鉴先分主力 / 支援两段，段内再按攻击属性分节点。总览图与文字节点共用这个顺序 */
export const SQUADS = ["主力", "支援"]
export const squadOf = (t) => t.squad || "主力"

export function rosterByAtkType(squad) {
  const groups = new Map()
  for (const t of ROSTER) {
    if (squad && squadOf(t) !== squad) continue
    if (!groups.has(t.atkType)) groups.set(t.atkType, [])
    groups.get(t.atkType).push(t)
  }
  const rank = (a) => (ATK_ORDER.indexOf(a) + 1 || ATK_ORDER.length + 1)
  return [...groups].sort(([a], [b]) => rank(a) - rank(b))
}

/**
 * 精简图鉴：按攻击属性分组，一个属性一段文本（调用方一段发一条消息）。
 *
 * 配队时真正要比的是属性对位和技能效果，数值面板反而是噪音；
 * 要看完整数值就单独查 `档案图鉴 星野`，那才发角色卡图。
 */
export function renderRosterByType() {
  return SQUADS.flatMap((sq) => rosterByAtkType(sq).map(([atk, list]) => {
    const body = list.map((t) => [
      `${t.name}　${combatRoleOf(t)}　${atk}攻击 / ${ARMOR_LABEL[t.defType] || t.defType}`,
      `　普技「${t.skill?.name || "无"}」${describeEffect(t.skill)}`,
      `　EX「${t.ex.name}」${t.ex.cost}费　${describeEffect(t.ex)}`,
    ].join("\n"))
    // 支援那几段加一句提要：它们不站在场上，配队时是完全不同的一格
    const note = sq === "支援" ? "\n（支援位不站在场上、打不到，只放普通技能和 EX；基础生命/攻击的 10%、防御/治疗力的 5% 分给主力）" : ""
    return `◤ ${sq} · ${atk}攻击 ◢　${list.length} 人${note}\n\n${body.join("\n\n")}`
  }))
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
      // 支援位原数据里就没有 `Skills.Normal`，`autoAttack` 是 null —— 它们压根没有普攻这回事
      (t.autoAttack
        ? `   [普攻] ${t.autoAttack.hits.reduce((a, b) => a + b, 0).toFixed(0)}% 分${t.autoAttack.hits.length}段\n`
        : "   [支援] 不站在场上、打不到，也没有普攻；基础生命/攻击的 10%、防御/治疗力的 5% 分给主力\n") +
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
    (t.autoAttack
      ? `[普攻] ${t.autoAttack.hits.reduce((a, b) => a + b, 0).toFixed(0)}% 分 ${t.autoAttack.hits.length} 段\n\n`
      : "[支援] 不站在场上、打不到，也没有普攻；只放普通技能和 EX\n\n") +
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
