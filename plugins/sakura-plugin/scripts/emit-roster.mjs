/**
 * SchaleDB → roster.js 生成器
 * 改 IDS 就能扩充角色池；所有折算规则集中在本文件顶部常数。
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, "..", "lib", "ba", "roster.js")

const arr = (() => {
  const d = JSON.parse(fs.readFileSync(path.join(HERE, "students.json"), "utf8"))
  return Array.isArray(d) ? d : Object.values(d)
})()
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, "cfg.json"), "utf8"))
const summonData = (() => {
  const d = JSON.parse(fs.readFileSync(path.join(HERE, "summons.json"), "utf8"))
  return Array.isArray(d) ? d : Object.values(d)
})()

const FORCE_STAR = 3, LEVEL = 1, SKILL_LV = 0, ROUND_SEC = 5
/**
 * 有爱用品的角色，普通技能取爱用品强化版（`Skills.GearPublic`，272 人里 66 人有）。
 *
 * 只吃技能强化，**不吃爱用品的属性加成**：那些是 `_Base` 定值、按满级面板标定，
 * 套到 LEVEL=1 上中位会放大到角色本体攻击的 288%（野宫 263 → 763，×2.9）。
 * 技能强化则是 Scale（万分比）与 Coefficient（百分比），与等级无关，
 * 36 件带伤害的倍率提升中位只有 ×1.20，量纲干净。
 */
const USE_GEAR_SKILL = true
/** 原作 PvP 的时间参数：一局 4 分钟，剩余不足 1 分钟进白热化 */
const BATTLE_SEC = 240, FEVER_LEFT_SEC = 60
const TRANS = [[0, 1000, 1200, 1400, 1700], [0, 500, 700, 900, 1400], [0, 750, 1000, 1200, 1500]]
const AOE_T1 = 126000, AOE_T2 = 300000

/**
 * 角色池。按**上线顺序**（SchaleDB 的 `DefaultOrder`）取可生成的前 15 位，再加芹香。
 *
 * 可生成 = EX 与普通技能都不含 Summon / Special / Accumulation（那几类要手写逻辑），
 * 且没有未映射的 Buff 属性，且名字不带括号（`findUnit` 精确匹配，变体名玩家难打）。
 * 272 人里满足这三条的只有 108 人。
 *
 * 芹香排第 19 位，本来进不了前 16，但她已经在池里、且是唯一的 11 段角色，
 * 保留她挤掉了第 16 位的佳代子（辅助）。
 *
 * 代号取 SchaleDB 的 `PathName` 转大写，会成为 resources/ba/characters/ 的目录名。
 */
const IDS = [
  [10000, "ARU"], [10001, "EIMI"], [10002, "HARUNA"], [10003, "HIFUMI"], [10004, "HINA"],
  [10005, "HOSHINO"], [10006, "IORI"], [10007, "MAKI"], [10009, "IZUMI"],
  [10010, "SHIROKO"], [10012, "SUMIRE"], [10013, "TSURUGI"], [13000, "AKANE"],
  [13001, "CHISE"], [13002, "AKARI"], [13003, "HASUMI"], [13004, "NONOMI"],
  [13005, "KAYOKO"], [13006, "MUTSUKI"], [13008, "SERIKA"],
]

const BULLET_CN = { Explosion: "爆发", Pierce: "贯通", Mystic: "神秘", Sonic: "振动", Chemical: "变化" }
// 短名与 BaBattleImageGenerator 的 ARMOR_VISUAL 键一致（该表的 label 里存全称）
const ARMOR_CN = { LightArmor: "轻装", HeavyArmor: "重装", Unarmed: "特殊", ElasticArmor: "弹力", CompositeArmor: "复合" }
const ROLE_CN = { Tanker: "坦克", DamageDealer: "输出", Healer: "治疗", Supporter: "辅助", Vehicle: "载具" }

const interp = (s1, s100, lv, tr = 1) => {
  const ls = Number(((lv - 1) / 99).toFixed(4))
  return Math.ceil(Number((Math.round(Number((s1 + (s100 - s1) * ls).toFixed(4))) * tr).toFixed(4)))
}
const starMul = (g) => {
  let a = 1, h = 1, e = 1
  for (let i = 0; i < g; i++) { a += TRANS[0][i] / 1e4; h += TRANS[1][i] / 1e4; e += TRANS[2][i] / 1e4 }
  return { atk: a, hp: h, heal: e }
}
/**
 * 秒 → `turns`。原作双方是同时打的，蓝回合与红回合是同一段 5 秒的两次呈现，
 * 各自跑完一遍四人普攻循环（实测 4.0~6.6 秒），所以时间刻度是**轮**不是回合。
 * 引擎里冷却与时长都只在自己方的回合跳，一轮正好跳一次，故除数就是 ROUND_SEC。
 */
const msToTurns = (ms) => (ms ? Math.max(1, Math.ceil(ms / (ROUND_SEC * 1000))) : null)
const secToTurns = (s) => Math.max(1, Math.ceil(s / ROUND_SEC))

const shapeArea = (r) => {
  switch (r.Type) {
    case "Circle": case "Bounce": return Math.PI * r.Radius ** 2
    case "Fan": return Math.PI * r.Radius ** 2 * (r.Degree / 360)
    case "Obb": return r.Width * r.Height
    case "Donut": return Math.PI * (r.Radius ** 2 - (r.ExcludeRadius || 0) ** 2) * ((r.Degree || 360) / 360)
  }
  return 0
}

/** 几何 → 目标语义。回合制没有坐标，只保留「打几个」。 */
function resolveTarget(sk, effTargets) {
  // 伤害效果在原数据里不写 Target，隐含打敌方（跟 RIDES_DAMAGE 同一个约定）。
  // 只看 Target 列表会把「造成伤害 + 给自己上 Buff」的技能整个判成打自己 ——
  // 真纪的 EX 就会 744% 砸在自己脸上。全 272 人里有 14 个技能踩这条。
  const hasDamage = (sk.Effects || []).some((e) => e.Type === "Damage")
  const ally = !hasDamage && effTargets.some((t) => /Ally/.test(t))
  const selfOnly = !hasDamage && effTargets.length > 0 && effTargets.every((t) => t === "Self")
  if (!sk.Radius) {
    if (selfOnly) return { target: "self", count: 1 }
    if (ally) return { target: "ally_all", count: 4 }
    return { target: "enemy_single", count: 1 }
  }
  if (sk.Radius[0].Type === "Bounce") return { target: "enemy_random", count: 1 }
  const a = sk.Radius.reduce((s, r) => s + shapeArea(r), 0)
  const count = a <= AOE_T1 ? 2 : a <= AOE_T2 ? 3 : 4
  if (ally) return { target: count >= 4 ? "ally_all" : "ally_adjacent", count }
  return { target: count >= 4 ? "enemy_all" : "enemy_adjacent", count, area: Math.round(a) }
}

/** BA 的 Buff.Stat → 引擎内部属性名。回合制无对应物的直接丢弃。 */
const STAT_MAP = {
  AttackPower_Coefficient: "atk", AttackPower_Base: "atk_flat",
  DefensePower_Coefficient: "dfs", DefensePower_Base: "dfs_flat",
  MaxHP_Coefficient: "maxhp", MaxHP_Base: "maxhp_flat",
  HealPower_Coefficient: "heal", HealPower_Base: "heal_flat",
  CriticalPoint_Coefficient: "crit", CriticalDamageRate_Coefficient: "crit_dmg",
  CriticalDamageRate_Base: "crit_dmg_flat",
  AccuracyPoint_Coefficient: "acc", DodgePoint_Coefficient: "dodge",
  // 爱用品强化技能会给这两项抵抗上增益，引擎侧 critResOf / critDmgResOf 有对应的层
  CriticalDamageResistRate_Base: "crit_dmg_res_flat",
  CriticalChanceResistPoint_Coefficient: "crit_res",
  // 攻速在回合制里等价于 DPS 提升，折成增伤
  AttackSpeed_Coefficient: "dmg_deal",
  DamagedRatio2_Coefficient: "dmg_take", HealEffectivenessRate_Coefficient: "heal_taken",
}
const DROP_STAT = /Range|MoveSpeed|IgnoreDelay|Oppression|BlockRate/

/** 从中文描述里抠出触发规则（BA 数据没有结构化的触发字段）。 */
function parseTrigger(desc) {
  if (!desc) return { type: "cooldown", turns: 5 }
  const once = /仅可触发\s*(\d+)\s*次/.exec(desc)
  const hp = /生命值不高于\s*([\d.]+)%/.exec(desc)
  const sec = /每\s*([\d.]+)\s*秒/.exec(desc)
  if (hp) return { type: "hp_below", value: Number(hp[1]) / 100, maxUses: once ? Number(once[1]) : 1 }
  if (sec) return { type: "cooldown", turns: secToTurns(Number(sec[1])), ...(once ? { maxUses: Number(once[1]) } : {}) }
  return { type: "cooldown", turns: 5, ...(once ? { maxUses: Number(once[1]) } : {}) }
}

/** 一个 Damage 效果 → 分段倍率数组。每段独立判定命中/暴击，所以不能合并成一个总倍率。 */
function hitsOf(dmg) {
  const total = dmg.Scale[SKILL_LV]
  const split = dmg.Hits || [10000]
  // 「固定场地」类技能（全 272 人里 5 个）Hits 只写一段，真正跳几次在 HitFrames 里。
  // 回合制没有场地，按跳数摊成等量分段一次性打完 —— 不然千世 4 费的 EX 只有 56%，
  // 比她自己的普通技能还弱。
  const ticks = dmg.HitFrames?.length > split.length ? dmg.HitFrames.length : 1
  const parts = ticks > 1 ? Array.from({ length: ticks }, () => split).flat() : split
  return parts.map((h) => Number(((total * h) / 1e4 / 100).toFixed(4)))
}

/**
 * 「对 1 名敌方单位造成伤害，再对以其为中心的范围造成伤害」——主目标两段都吃，扩散只吃第二段。
 *
 * **只认这一种措辞**。全 272 人里有 45 个技能带多段 Damage，但多数第二段是条件加伤
 * （爱丽丝「能量充能时 ×1.5」、睦月「叠满 6 层时追加」）或随机三选一（小雪），
 * 那些取第一段才是对的，一律摊开会凭空翻倍。
 */
const SPLASH_DESC = (d) => /对1名敌方单位/.test(d) && /为中心的[^。]*范围/.test(d)

/**
 * 贯穿 / 弹跳的逐目标衰减。跟触发条件一样，**只存在于中文描述里**，没有结构化字段。
 * 全 272 人里 3 个：晴奈的贯穿（每个 −10%，最多 −30%）、泉（泳装）的弹跳、响。
 */
function parseFalloff(desc) {
  const d = String(desc || "")
  const step = /衰减\s*([\d.]+)\s*%/.exec(d)
  if (!step) return null
  const cap = /最多衰减\s*([\d.]+)\s*%/.exec(d)
  return { rate: Number(step[1]) / 100, max: cap ? Number(cap[1]) / 100 : 1 }
}

/** summons.json 的 Name 是日文，中文名手工补 */
const SUMMON_CN = { 40002: "佩洛洛人偶" }
/** 实际被用到的召唤物，最后一并输出成 SUMMONS 表 */
const usedSummons = new Map()

function summonTmpl(id) {
  const s = summonData.find((x) => x.Id === id)
  if (!s) return null
  return {
    id, name: SUMMON_CN[id] || s.Name,
    defType: ARMOR_CN[s.ArmorType] || "轻装",
    role: "召唤",
    hp: interp(s.MaxHP1, s.MaxHP100, LEVEL, 1),
    dfs: interp(s.DefensePower1, s.DefensePower100, LEVEL, 1),
    dodge: s.DodgePoint, crit: s.CriticalPoint,
    critRes: 100, critDmgRes: 5000, stability: s.StabilityPoint,
  }
}

/**
 * 召唤物效果。**只放行没有攻击力的挡刀型**——会打人的（雷ちゃん 那种炮台）
 * 要给召唤物单独的行动逻辑，现在没有，放行就是生成一个不会动的空壳。
 */
function buildSummon(e) {
  const s = summonData.find((x) => x.Id === e.SummonId)
  if (!s || s.AttackPower1 > 0 || s.AttackPower100 > 0) return null
  // 入场技能里的 Provoke → 嘲讽。别走 CrowdControl 的通用分支，那条会变成眩晕
  const cc = (s.Skills || []).flatMap((k) => k.Effects || []).find((x) => x.Type === "CrowdControl")
  const taunt = cc && /Provoke/i.test(cc.Icon || "") ? msToTurns(cc.Scale?.[SKILL_LV]) ?? 1 : 0
  return {
    type: "summon", summonId: e.SummonId,
    // 血量 = 召唤物自身 + 施放者生命值 × Value（日富美是 160.06%）
    hpRate: e.Stat === "MaxHP_Base" && e.CasterStat === "MaxHP"
      ? Number(((e.Value?.[0]?.[SKILL_LV] ?? 0) / 1e4).toFixed(4)) : 0,
    turns: msToTurns(e.Duration) ?? 6,
    taunt,
  }
}

/**
 * N 次**独立**打击 → 打 N 个目标，不是一个目标吃 N 段。
 *
 * 判据是「N 个独立的爆炸源」这种措辞，**不能只看 `Hits` 求和 = N×10000**：
 * 日和（泳装）「发射5发子弹…※合计5发子弹的伤害」求和也是 50000，但明写了 5 发全打第 1 名。
 * 也刻意不匹配伊织「发射3发子弹，每发子弹各对其锁定的敌方单位…」—— 那是 3 发打同一批人。
 */
const INSTANCE_DESC = /对\s*(\d+)\s*个[^，。]*?范围|部署\s*(\d+)\s*个地雷|飞射\s*(\d+)\s*枚/

function instanceCount(sk, dmg) {
  if (!dmg?.Hits || dmg.Hits.length < 2) return 0
  const sum = dmg.Hits.reduce((a, b) => a + b, 0)
  const n = Math.round(sum / 1e4)
  if (n < 2 || Math.abs(sum - n * 1e4) > 50) return 0 // 不是整数倍 = 只是取整误差
  const m = INSTANCE_DESC.exec(String(sk.Desc || ""))
  if (!m) return 0
  const declared = Number(m[1] || m[2] || m[3])
  return declared === n ? n : 0
}

function buildSkill(sk, { isEx, student }) {
  if (!sk) return null
  const dmgs = (sk.Effects || []).filter((e) => e.Type === "Damage")
  const allTargets = (sk.Effects || []).flatMap((e) => (Array.isArray(e.Target) ? e.Target : e.Target ? [e.Target] : []))
  const tg = resolveTarget(sk, allTargets)
  const out = { name: sk.Name, ...tg, effects: [] }
  if (isEx) out.cost = sk.Cost[SKILL_LV]
  else out.trigger = parseTrigger(sk.Desc)

  // 「发射 N 发子弹，每发子弹各对其锁定的敌方单位」—— 每发单独锁目标、逐发换人。
  // 全 272 人里只有伊织一个（日和（泳装）也是「发射5发子弹」，但明写了 5 发全打第 1 名）。
  const chain = /发射\s*(\d+)\s*发子弹[^。]*?每发子弹各对其锁定的/.exec(String(sk.Desc || ""))
  const inst = chain ? 0 : instanceCount(sk, dmgs[0])
  if (chain && dmgs.length) {
    out.hits = hitsOf(dmgs[0])
    out.target = "enemy_chain"
    out.count = Number(chain[1])
  } else if (inst) {
    // N 个爆炸源 → 打 N 个人，每人吃一份。不拆的话睦月的 EX 会变成 2 个人各吃 1229%
    out.hits = [hitsOf(dmgs[0])[0]]
    out.count = inst
    out.target = inst >= 4 ? "enemy_all" : "enemy_adjacent"
  } else if (dmgs.length) {
    out.hits = hitsOf(dmgs[0])
    // 扩散段只在 enemy_adjacent 上成立 —— 那是唯一能保证 targets[0] 就是主目标的分支
    if (dmgs.length > 1 && out.target === "enemy_adjacent" && SPLASH_DESC(String(sk.Desc || ""))) {
      out.splashHits = dmgs.slice(1).flatMap(hitsOf)
      out.hits = out.hits.concat(out.splashHits)
    }
    // 只在 AoE 上成立：弹射（enemy_random）逐段抽目标，没有「第几个」的概念
    const fo = parseFalloff(sk.Desc)
    if (fo && /adjacent|all/.test(out.target)) out.falloff = fo
  }

  // 附带在伤害上的效果（控制/减益/击退）原数据不写 Target，隐含跟随伤害目标
  const RIDES_DAMAGE = new Set(["CrowdControl", "DamageDebuff", "Knockback", "ConcentratedTarget"])
  for (const e of sk.Effects || []) {
    if (e.Type === "Damage") continue
    const dflt = RIDES_DAMAGE.has(e.Type) ? ["Enemy"] : ["Self"]
    const t = Array.isArray(e.Target) ? e.Target : e.Target ? [e.Target] : dflt
    const scope = t.every((x) => x === "Self") ? "self" : t.some((x) => /Ally/.test(x)) ? "ally_all" : "enemy"
    const turns = msToTurns(e.Duration)
    switch (e.Type) {
      case "Buff": {
        if (DROP_STAT.test(e.Stat || "")) { out.effects.push({ type: "dropped", raw: e.Stat, why: "回合制无对应物" }); break }
        const stat = STAT_MAP[e.Stat]
        if (!stat) { out.effects.push({ type: "unmapped", raw: e.Stat }); break }
        const v = e.Value?.[0]?.[SKILL_LV] ?? 0
        out.effects.push({
          type: "buff", scope, stat,
          value: /_Base$/.test(e.Stat) ? v : Number((v / 1e4).toFixed(4)),
          turns: turns ?? 2,
        })
        break
      }
      case "Heal":
        out.effects.push({ type: "heal", scope, scale: Number((e.Scale[SKILL_LV] / 1e4).toFixed(4)), source: "heal" })
        break
      case "Regen": {
        const rg = {
          type: "regen", scope, scale: Number((e.Scale[SKILL_LV] / 1e4).toFixed(4)), source: "heal",
          turns: turns ?? 2, period: msToTurns(e.Period) ?? 1,
        }
        // 艾米的 EX 是全 272 人里唯一带 ExtraStatSource 的：
        // 每跳 = 治愈力 × Scale ＋ 已损生命值 × ExtraStatRate。漏掉后半截她的奶量少一半。
        if (e.ExtraStatSource === "TargetLostHP" && e.ExtraStatRate) {
          rg.lostHpRate = Number((e.ExtraStatRate[SKILL_LV] / 1e4).toFixed(4))
        }
        out.effects.push(rg)
        break
      }
      case "Shield":
        out.effects.push({ type: "shield", scope, scale: Number((e.Scale[SKILL_LV] / 1e4).toFixed(4)), source: "heal", turns: turns ?? 2 })
        break
      case "CrowdControl": {
        const sc = Array.isArray(e.Scale) ? e.Scale[SKILL_LV] : 0
        out.effects.push({ type: "cc", scope, icon: e.Icon || "Stunned", chance: (e.Chance ?? 10000) / 1e4, turns: sc ? msToTurns(sc) : 0 })
        break
      }
      // 鹤城的「换弹强化」：立即换弹，接下来一梭子的普攻倍率提高、打成扇形。
      // 弹匣发数 = AmmoCount / AmmoCost（鹤城 4/2 = 2 发），倍率与扇形都只写在描述里。
      case "Special": {
        if (e.Key !== "FormChange") { out.effects.push({ type: "unmapped", raw: `Special:${e.Key}` }); break }
        const m = /倍率强化至\s*([\d.]+)\s*%/.exec(String(sk.Desc || ""))
        out.effects.push({
          type: "charge",
          shots: Math.max(1, Math.round((student?.AmmoCount || 2) / (student?.AmmoCost || 1))),
          mult: m ? Number(m[1]) / 100 : 1,
          count: tg.count || 1, // EX 自己的范围（扇形）决定强化普攻打几个
        })
        break
      }
      case "Summon": {
        const sm = buildSummon(e)
        if (sm) { out.effects.push(sm); usedSummons.set(sm.summonId, summonTmpl(e.SummonId)) }
        else out.effects.push({ type: "unmapped", raw: `Summon:${e.SummonId}` })
        break
      }
      case "Dispel": out.effects.push({ type: "cleanse", scope }); break
      case "CostChange": out.effects.push({ type: "cost", scope, value: (e.Value?.[0]?.[SKILL_LV] ?? e.Scale?.[SKILL_LV] ?? 0) / 1e4 }); break
      case "ConcentratedTarget": out.effects.push({ type: "taunt", scope, turns: turns ?? 1 }); break
      case "DamageDebuff": out.effects.push({ type: "buff", scope, stat: "dmg_deal", value: -((e.Scale?.[SKILL_LV] ?? 0) / 1e4), turns: turns ?? 2 }); break
      case "Knockback": out.effects.push({ type: "dropped", raw: "Knockback", why: "回合制无位置" }); break
      default: out.effects.push({ type: "unmapped", raw: e.Type })
    }
  }
  const charge = out.effects.find((e) => e.type === "charge")
  // 「立即换弹」在回合制里唯一有意义的翻译：上完效果立刻普攻一次。
  // 换弹强化也走这条 —— 换完弹当场就能开枪，那一发已经是强化过的，
  // 由 autoAttack() 从 u.charge 里扣掉，所以第 1 发落在施放回合、第 2 发落在下个回合。
  if (/立即换弹|马上换弹/.test(sk.Desc || "")) out.thenAutoAttack = true
  // 「换弹后失效」的增益没有 Duration 字段，让它跟强化射击同寿。
  // 进攻类 Buff 施放回合就算第 1 回合，而第 1 发也在施放回合，所以正好 = shots
  if (charge) for (const e of out.effects) if (e.type === "buff") e.turns = charge.shots
  return out
}

/**
 * buildSkill 处理不了的效果类型：碰上就退回未强化版，别生成半个空技能。
 * `Special` 里只有 `FormChange` 一种做了（鹤城的换弹强化），其余 Key 仍然不认。
 */
const UNBUILDABLE = /^(Summon|Accumulation)$/
const unbuildable = (e) => UNBUILDABLE.test(e.Type) || (e.Type === "Special" && e.Key !== "FormChange")

/**
 * 普通技能取哪一条。`GearPublic` 与 `Public` 同结构，buildSkill 不用改。
 * 强化版含 Special / Summon（妮露、莲华、歌原）时退回 Public —— 那几类要手写逻辑。
 */
function pickPublicSkill(c) {
  const one = (x) => (Array.isArray(x) ? x[0] : x)
  const base = one(c.Skills.Public)
  if (!USE_GEAR_SKILL) return { sk: base, gear: false }
  const g = one(c.Skills.GearPublic)
  if (!g || (g.Effects || []).some(unbuildable)) return { sk: base, gear: false }
  return { sk: g, gear: true }
}

const units = IDS.map(([sid, code]) => {
  const c = arr.find((x) => x.Id === sid)
  const m = starMul(FORCE_STAR)
  const na = Array.isArray(c.Skills.Normal) ? c.Skills.Normal[0] : c.Skills.Normal
  const nd = (na?.Effects || []).find((e) => e.Type === "Damage")
  const pub = pickPublicSkill(c)
  return {
    id: code, sid, name: c.Name, star: FORCE_STAR, baseStar: c.StarGrade,
    atkType: BULLET_CN[c.BulletType], defType: ARMOR_CN[c.ArmorType], role: ROLE_CN[c.TacticRole],
    bullet: c.BulletType, armor: c.ArmorType,
    hp: interp(c.MaxHP1, c.MaxHP100, LEVEL, m.hp),
    atk: interp(c.AttackPower1, c.AttackPower100, LEVEL, m.atk),
    dfs: interp(c.DefensePower1, c.DefensePower100, LEVEL, 1),
    healPower: interp(c.HealPower1, c.HealPower100, LEVEL, m.heal),
    acc: c.AccuracyPoint, dodge: c.DodgePoint, crit: c.CriticalPoint,
    critDmg: c.CriticalDamageRate, critRes: 100, critDmgRes: 5000, stability: c.StabilityPoint,
    autoAttack: { hits: (nd ? nd.Hits.map((h) => Number(((nd.Scale[0] * h) / 1e4 / 100).toFixed(4))) : [1]) },
    gearSkill: pub.gear,
    skill: buildSkill(pub.sk, { isEx: false, student: c }),
    ex: buildSkill(Array.isArray(c.Skills.Ex) ? c.Skills.Ex[0] : c.Skills.Ex, { isEx: true, student: c }),
  }
})

// ---- 报告未映射/丢弃的效果，然后把占位项剔出最终数据 ----
const warn = []
for (const u of units)
  for (const sk of [u.skill, u.ex]) {
    if (!sk) continue
    for (const e of sk.effects)
      if (e.type === "unmapped") warn.push(`${u.name} / ${sk.name}: 未映射 ${e.raw}`)
      else if (e.type === "dropped") warn.push(`${u.name} / ${sk.name}: 丢弃 ${e.raw}（${e.why}）`)
    sk.effects = sk.effects.filter((e) => e.type !== "dropped" && e.type !== "unmapped")
    // 技能等级 1 时数值为 0 的效果保留结构但标记，方便日后升级技能等级。
    // 控制是时长为 0（星野的战术镇压），Buff 是数值为 0（泉的攻速增益）。
    for (const e of sk.effects) {
      if (e.type === "cc" && !e.turns) e.inactive = true
      if (e.type === "buff" && !e.value) e.inactive = true
    }
  }

const js = `/**
 * 碧蓝档案 · 回合制群战 —— 角色表（自 SchaleDB 官方数据生成）
 *
 * 本文件由 scripts/emit-roster.mjs 生成，不要手改。
 * 折算口径：等级 ${LEVEL} / 无装备 / 统一 ${FORCE_STAR}★ / 技能 ${SKILL_LV + 1} 级 / 1 轮 = ${ROUND_SEC} 秒
 * ${USE_GEAR_SKILL ? "有爱用品的角色用强化版普通技能（GearPublic）；爱用品的属性加成不取，那是按满级标定的定值" : "不取爱用品"}
 * 战斗公式与克制表均取自官方实现，见 CFG 注释。
 */

/** 官方克制表（万分比）：SchaleDB config.TypeEffectiveness */
export const TYPE_EFFECTIVENESS = ${JSON.stringify(cfg.TypeEffectiveness, null, 2)}

// 短名与全称都认，避免调用方写全称时静默退化成 1.0
const ARMOR_KEY = {
  轻装: "LightArmor", 重装: "HeavyArmor", 特殊: "Unarmed", 弹力: "ElasticArmor", 复合: "CompositeArmor",
  轻装甲: "LightArmor", 重装甲: "HeavyArmor", 特殊装甲: "Unarmed", 弹力装甲: "ElasticArmor", 复合装甲: "CompositeArmor",
}
const BULLET_KEY = { 爆发: "Explosion", 贯通: "Pierce", 神秘: "Mystic", 振动: "Sonic", 变化: "Chemical" }

/** 属性克制系数：克制 2.0 / 普通 1.0 / 被抵抗 0.5（振动打特殊为 1.5） */
export function affinity(atkType, defType) {
  const row = TYPE_EFFECTIVENESS[BULLET_KEY[atkType]]
  const key = ARMOR_KEY[defType]
  if (!row || !key) throw new Error(\`未知属性组合: \${atkType} / \${defType}\`)
  return (row[key] ?? 10000) / 10000
}

export const CFG = {
  // ---- 官方战斗公式常数（取自 SchaleDB common.js 实现）----
  DEF_C: 6000, DEF_BASE: 10000000,   // 防御系数 = DEF_BASE / (防御 × DEF_C + DEF_BASE)
  HIT_C: 3, HIT_BASE: 2000,          // 命中率  = HIT_BASE / (max(闪避−命中,0) × HIT_C + HIT_BASE)
  CRIT_C: 6000, CRIT_BASE: 4000000,  // 暴击率  = 1 − CRIT_BASE / (max(暴击−暴抵,0) × CRIT_C + CRIT_BASE)
  STAB_BASE: 1000,                   // 伤害下限 = 稳定值/(稳定值+STAB_BASE) + 稳定率/10000
  DEFAULT_STAB_RATE: 2000,
  ROUND_SECONDS: ${ROUND_SEC},       // 1 轮（双方各行动一次）= 5 秒，技能时长与冷却都按这把尺子折算

  // ---- 对战框架（非 BA 原生，为回合制 PvP 而设）----
  // Cost 在每个回合「结束时」回复，因此首轮双方都是开局值直接开打：
  // 先手首轮 0，后手首轮 2，之后后手恒定领先 2 点。
  COST_START: 0,
  COST_REGEN_PER_UNIT: 0.5,          // 满编 4 人 = 2/回合
  COST_MAX: 10,                      // 与 BA 的 Cost 上限一致
  EX_COOLDOWN_SLACK: 2,              // EX 冷却长度 = 存活人数 − 这个值
  SECOND_BONUS: 2,                   // 后手方开局补偿

  // ---- 白热化 / FEVER TIME（照搬原作，按 1 轮 = ${ROUND_SEC} 秒折算）----
  // 原作 PvP：总时长 ${BATTLE_SEC} 秒，剩余不足 ${FEVER_LEFT_SEC} 秒进入白热化，
  // 时间耗尽则比双方「当前血量 / 最大血量」的比值定胜负。
  FEVER_ROUND: ${(BATTLE_SEC - FEVER_LEFT_SEC) / ROUND_SEC},  // 第几轮进入白热化 = ${BATTLE_SEC - FEVER_LEFT_SEC} 秒
  FEVER_COST_MULT: 2,                // 白热化唯一的基础效果：Cost 攒得更快
  FEVER_DEBUFF: 0.5,                 // 赛季附加规则：防御 / 闪避 / 受治疗下降，设 0 可关掉
  MAX_ROUND: ${BATTLE_SEC / ROUND_SEC},                   // 时间耗尽 = ${BATTLE_SEC} 秒 = ${BATTLE_SEC / ROUND_SEC} 轮
}

/**
 * 召唤物模板。它们**不进 ROSTER**，也不占号位——只作为 side.summons 里的挡刀物存在，
 * 所以 aliveOf / sideDead / settle / EX 冷却全都天然不把它们算进去。
 */
export const SUMMONS = ${JSON.stringify(Object.fromEntries(usedSummons), null, 2)}

export const ROSTER = ${JSON.stringify(units, null, 2)}

export const BY_ID = Object.fromEntries(ROSTER.map((t) => [t.id, t]))

export function combatRoleOf(x) {
  const id = typeof x === "string" ? x : x?.id
  return BY_ID[id]?.role || null
}

/**
 * 按角色名或内部代号查角色。**不认编号** —— 配队和出招一律写名字，
 * 记「星野ex打白子」比记「ex 1>3」容易得多，角色也不再对外暴露序号。
 */
export function findUnit(token) {
  const s = String(token).trim()
  return BY_ID[s.toUpperCase()] || ROSTER.find((t) => t.name === s) || null
}

/** 召唤物按名字查，供「伊织ex打佩洛洛人偶」这种指令定位。允许省略「人偶」等后缀 */
export function findSummon(token) {
  const s = String(token).trim()
  if (!s) return null
  return Object.values(SUMMONS).find((t) => t.name === s || t.name.startsWith(s)) || null
}
`

fs.writeFileSync(OUT, js)
console.log("生成完毕 → lib/ba/roster.js")
console.log("角色:", units.map((u) => `${u.name}(${u.id})`).join(" "))
const gearUnits = units.filter((u) => u.gearSkill)
console.log(`爱用品强化普通技能：${gearUnits.length}/${units.length} 人` +
  (gearUnits.length ? ` —— ${gearUnits.map((u) => `${u.name}「${u.skill.name}」`).join("　")}` : ""))
console.log("\n=== 转换告警 ===")
console.log(warn.length ? warn.join("\n") : "无")
console.log("\n=== 技能结构预览 ===")
for (const u of units) {
  console.log(`\n${u.name} ${u.atkType}/${u.defType} ${u.role}`)
  console.log("  EX  ", JSON.stringify(u.ex))
  console.log("  普技", JSON.stringify(u.skill))
  console.log("  普攻", JSON.stringify(u.autoAttack))
}
