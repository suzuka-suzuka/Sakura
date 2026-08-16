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
 * `Special` 里做掉了 `FormChange` 之后，鹤城和瞬也进得来了（原先按「EX 含 Special」一刀切挡掉）。
 * 纯子排第 21 位，接了不死 / EX 打折 / 自伤三样之后才上得来。
 * 椿 / 优香 / 春香排 23~25 位，池里坦克只有星野和艾米，补三个不同装甲的坦克。
 *
 * 代号取 SchaleDB 的 `PathName` 转大写，会成为 resources/ba/characters/ 的目录名。
 */
const IDS = [
  [10000, "ARU"], [10001, "EIMI"], [10002, "HARUNA"], [10003, "HIFUMI"], [10004, "HINA"],
  [10005, "HOSHINO"], [10006, "IORI"], [10007, "MAKI"], [10009, "IZUMI"],
  [10010, "SHIROKO"], [10011, "SHUN"], [10012, "SUMIRE"], [10013, "TSURUGI"], [13000, "AKANE"],
  [13001, "CHISE"], [13002, "AKARI"], [13003, "HASUMI"], [13004, "NONOMI"],
  [13005, "KAYOKO"], [13006, "MUTSUKI"], [13007, "JUNKO"], [13008, "SERIKA"],
  [13009, "TSUBAKI"], [13010, "YUUKA"], [16000, "HARUKA"],
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

/** 同一个槽位有时是数组有时是对象，统一取第一条 */
const one = (x) => (Array.isArray(x) ? x[0] : x)

/**
 * 技能描述。`<?N>` 是按技能等级取值的占位符（第 N 个 `Parameters` 数组），
 * 回填之后才能用正则抠数字 —— 瞬的「获得<?1>技能COST」不填就只剩一个尖括号。
 */
const descOf = (sk) =>
  String(sk?.Desc || "").replace(/<\?(\d+)>/g, (m, n) => sk.Parameters?.[Number(n) - 1]?.[SKILL_LV] ?? m)

/** 从中文描述里抠出触发规则（BA 数据没有结构化的触发字段）。 */
function parseTrigger(desc) {
  if (!desc) return { type: "cooldown", turns: 5 }
  const once = /仅可触发\s*(\d+)\s*次/.exec(desc)
  // 瞬：开局回费。这类技能在建局时就结算，不进 ③-a 技能阶段 ——
  // 拖到那里的话 Cost 会晚于玩家首轮的 EX 窗口，开局那 2 点等于没给。
  if (/战斗开始时/.test(desc)) return { type: "battle_start", maxUses: once ? Number(once[1]) : 1 }
  const hp = /生命值不高于\s*([\d.]+)%/.exec(desc)
  const sec = /每\s*([\d.]+)\s*秒/.exec(desc)
  const chance = /(\d+(?:\.\d+)?)\s*%\s*概率/.exec(desc)
  const icd = /冷却\s*([\d.]+)\s*秒/.exec(desc)
  // 鹤城 / 莲见：自己击杀掉才触发。别当成「每 5 回合必回血」。
  // 不认「击败 N 名 / 每击败」那种叠层计数（池外丽、纱织礼服）。
  if (/自身击败敌方单位时/.test(desc) && !/击败\s*\d+\s*名/.test(desc) && !/每击败/.test(desc)) {
    return {
      type: "on_kill",
      turns: icd ? secToTurns(Number(icd[1])) : 0,
      ...(once ? { maxUses: Number(once[1]) } : {}),
    }
  }
  // 泉 / 明里：普通技能挂在普攻上，不是「每 X 秒必放」。冷却写在括号里，只有触发成功才进 CD。
  const onAuto = /自身普通攻击时/.test(desc)
  if (onAuto) {
    return {
      type: "on_auto",
      chance: chance ? Number(chance[1]) / 100 : 1,
      turns: icd ? secToTurns(Number(icd[1])) : 2,
      ...(once ? { maxUses: Number(once[1]) } : {}),
    }
  }
  if (hp) return { type: "hp_below", value: Number(hp[1]) / 100, maxUses: once ? Number(once[1]) : 1 }
  if (sec) return { type: "cooldown", turns: secToTurns(Number(sec[1])), ...(once ? { maxUses: Number(once[1]) } : {}) }
  return { type: "cooldown", turns: 5, ...(once ? { maxUses: Number(once[1]) } : {}) }
}

/**
 * 时长也得按技能等级取 —— **`Effect.Duration` 存的是满级那一档**。
 *
 * 描述里写「持续<?2>」时，真正的时长在 `Parameters` 里是一张按级表
 * （优香的护盾 15/15/20/20/25 秒），而 `Effect.Duration` 固定 25000。
 * 本项目 `SKILL_LV = 0`，倍率和 Cost 都取第 1 档，时长没道理单独取满级。
 * 全 272 人里 13 个技能踩这条（果穗、爱丽丝（女仆）、一花、御坂美琴、千明、光、优香）。
 *
 * **只在「Duration 正好等于按级表最后一档」时才改写** —— 一个技能可能挂着几个不同时长的
 * 效果，不核对就会张冠李戴。
 * @returns {number|null} 毫秒；不该改写时返回 null
 */
function levelDuration(sk, e) {
  if (!e.Duration) return null
  const sec = (x) => {
    const m = /^\s*([\d.]+)\s*秒\s*$/.exec(String(x ?? ""))
    return m ? Number(m[1]) : null
  }
  for (const m of String(sk.Desc || "").matchAll(/持续\s*<\?(\d+)>/g)) {
    const tbl = sk.Parameters?.[Number(m[1]) - 1]
    if (!tbl?.length || sec(tbl[tbl.length - 1]) !== e.Duration / 1000) continue
    const own = sec(tbl[Math.min(SKILL_LV, tbl.length - 1)])
    if (own != null) return own * 1000
  }
  return null
}

/** 一个 Damage 效果 → 分段倍率数组。每段独立判定命中/暴击，所以不能合并成一个总倍率。 */
function hitsOf(dmg) {
  const total = dmg.Scale[SKILL_LV]
  const split = dmg.Hits || [10000]
  return split.map((h) => Number(((total * h) / 1e4 / 100).toFixed(4)))
}

/**
 * 「固定场地」类技能（全 272 人里 5 个：惠、千世、纱绫×2、切里诺）：
 * 在地上留一片区域，站在里面的人**持续挨打**，施放者死了场地也还在。
 *
 * `Hits` 只写一段，真正的跳数在 `HitFrames` 里（帧号，30fps）。**最后一帧就是场地存续时间**
 * ——千世的 `HitFrames` 收在 300 帧 = 10 秒 = 2 轮，跟技能描述的「持续10秒」对得上。
 *
 * 折成回合制不能一次性打完（那是 616% 的瞬间爆发，跟「持续」的语义完全相反），
 * 而是摊到存续的每一轮上：总伤害 ÷ 轮数。
 * @returns {object|null} 场地持续伤害效果，非场地技能返回 null
 */
function zoneDot(dmg) {
  const frames = dmg.HitFrames
  if (!(frames?.length > (dmg.Hits || [10000]).length)) return null
  const turns = msToTurns((Math.max(...frames) / 30) * 1000) ?? 2
  const totalPct = hitsOf(dmg).reduce((a, b) => a + b, 0) * frames.length
  return {
    type: "dot", scope: "enemy", icon: "Zone",
    scale: Number((totalPct / 100 / turns).toFixed(4)), turns, period: 1,
  }
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
  const desc = descOf(sk)
  const dmgs = (sk.Effects || []).filter((e) => e.Type === "Damage")
  const allTargets = (sk.Effects || []).flatMap((e) => (Array.isArray(e.Target) ? e.Target : e.Target ? [e.Target] : []))
  const tg = resolveTarget(sk, allTargets)
  const out = { name: sk.Name, ...tg, effects: [] }
  if (isEx) out.cost = sk.Cost[SKILL_LV]
  else out.trigger = parseTrigger(desc)

  // 「发射 N 发子弹，每发子弹各对其锁定的敌方单位」—— 每发单独锁目标、逐发换人。
  // 全 272 人里只有伊织一个（日和（泳装）也是「发射5发子弹」，但明写了 5 发全打第 1 名）。
  const chain = /发射\s*(\d+)\s*发子弹[^。]*?每发子弹各对其锁定的/.exec(desc)
  const zone = dmgs.length ? zoneDot(dmgs[0]) : null
  const inst = chain || zone ? 0 : instanceCount(sk, dmgs[0])
  if (zone) {
    // 场地技没有直接伤害，全部化成持续伤害挂在目标身上
    out.effects.push(zone)
  } else if (chain && dmgs.length) {
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
    if (dmgs.length > 1 && out.target === "enemy_adjacent" && SPLASH_DESC(desc)) {
      out.splashHits = dmgs.slice(1).flatMap(hitsOf)
      out.hits = out.hits.concat(out.splashHits)
    }
    // 只在 AoE 上成立：弹射（enemy_random）逐段抽目标，没有「第几个」的概念
    const fo = parseFalloff(desc)
    if (fo && /adjacent|all/.test(out.target)) out.falloff = fo
  }

  // 附带在伤害上的效果（控制/减益/击退）原数据不写 Target，隐含跟随伤害目标
  const RIDES_DAMAGE = new Set(["CrowdControl", "DamageDebuff", "Knockback", "ConcentratedTarget"])
  for (const e of sk.Effects || []) {
    if (e.Type === "Damage") continue
    const dflt = RIDES_DAMAGE.has(e.Type) ? ["Enemy"] : ["Self"]
    const t = Array.isArray(e.Target) ? e.Target : e.Target ? [e.Target] : dflt
    const scope = t.every((x) => x === "Self") ? "self" : t.some((x) => /Ally/.test(x)) ? "ally_all" : "enemy"
    const turns = msToTurns(levelDuration(sk, e) ?? e.Duration)
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
          // Channel 是原作的**槽位号**：同槽后来的顶掉先来的，不同槽才共存。
          // 一个 Channel 只装一种属性、且正负不混（全 272 人零例外），所以它本身就够唯一。
          ...(e.Channel != null ? { channel: e.Channel } : {}),
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
        // **Provoke 必须从 CrowdControl 里分出来**：其余控制在引擎里都写 `t.stun`（整回合不能动），
        // 而嘲讽只是把敌人的刀拉过来。椿的 EX 不分流就变成「全场敌人晕 1 轮」，比原作强太多。
        // 原数据把它写成「对敌方施加 Provoke」，但引擎的嘲讽标记挂在**施法者**身上
        // （谁带标记谁挨打），所以 scope 固定 self —— 跟召唤物那条（buildSummon）同一套。
        if (/Provoke/i.test(e.Icon || "")) {
          out.effects.push({ type: "taunt", kind: "provoke", scope: "self", turns: sc ? msToTurns(sc) : 1 })
          break
        }
        out.effects.push({ type: "cc", scope, icon: e.Icon || "Stunned", chance: (e.Chance ?? 10000) / 1e4, turns: sc ? msToTurns(sc) : 0 })
        break
      }
      /**
       * 强化形态（`Key: "FormChange"`）：接下来一段时间的普攻换成另一套参数。
       * 池内两个，存续口径不同 ——
       *   鹤城「立即换弹…换弹1次后失效」：按**发数**，弹匣 = AmmoCount / AmmoCost（4/2 = 2 发）
       *   瞬「持续30秒」：按**轮数**，30 ÷ 5 = 6 轮，在 endTurn 里跳
       *
       * 强化后的普攻本身是结构化的（`Skills.Normal.FormChange`），倍率和分段都照抄那里，
       * 比拿描述里取整过的「倍率强化至138%」乘基础普攻准（鹤城实际是 138.71% 分 2 段，
       * 而基础普攻是 6 段）。没有这一段数据时才退回描述里的倍率。
       */
      case "Special": {
        if (e.Key !== "FormChange") { out.effects.push({ type: "unmapped", raw: `Special:${e.Key}` }); break }
        const na = one(student?.Skills?.Normal)
        const fc = na?.FormChange
        const fcd = (fc?.Effects || []).find((x) => x.Type === "Damage")
        const nd = (na?.Effects || []).find((x) => x.Type === "Damage")
        const m = /倍率强化至\s*([\d.]+)\s*%/.exec(desc)
        const mult = m ? Number(m[1]) / 100 : 1
        const ch = {
          type: "charge",
          hits: fcd ? hitsOf(fcd)
            : nd ? hitsOf(nd).map((h) => Number((h * mult).toFixed(4)))
              : [100 * mult],
          // 扇形也在强化普攻自己身上（EX 的 Radius 描述的就是它），取不到才退回 EX 的范围
          count: (fc ? resolveTarget(fc, []).count : 0) || tg.count || 1,
        }
        const sec = /持续\s*([\d.]+)\s*秒/.exec(desc)
        if (sec && !/换弹[^)）]*后失效/.test(desc)) ch.turns = secToTurns(Number(sec[1]))
        else ch.shots = Math.max(1, Math.round((student?.AmmoCount || 2) / (student?.AmmoCost || 1)))
        // 瞬：「索敌机制改为优先攻击攻击力最高的敌方单位」。跟触发条件一样没有结构化字段，
        // 只能从描述里认。引擎侧 laneTarget 会因此绕开战场分割 / 坦克 / 挡刀，只有嘲讽拉得走。
        if (/索敌[^。]*攻击力最高/.test(desc)) ch.targeting = "max_atk"
        out.effects.push(ch)
        break
      }
      case "Summon": {
        const sm = buildSummon(e)
        if (sm) { out.effects.push(sm); usedSummons.set(sm.summonId, summonTmpl(e.SummonId)) }
        else out.effects.push({ type: "unmapped", raw: `Summon:${e.SummonId}` })
        break
      }
      case "Dispel": out.effects.push({ type: "cleanse", scope }); break
      /**
       * `CostChange` **不是往 Cost 池里加点**，全 272 人的 16 个无一例外都是「EX 费用打折」：
       *   `BaseAmount` + `Scale: -4` → 减 4 费（纯子 5 费变 1 费，描述里写「减少至1」）
       *   `Coefficient` + `Scale: -5000` → 减 50%（忧、圣娅、柚子（武装）…）
       *   `Uses` = 还能打几次折（纯子 2 次）
       * 往 Cost 池加点的技能反而**没有**结构化效果，只写在描述里（见 buildSkill 末尾的兜底）。
       * 曾经这里映射成 `{type:"cost", value: Scale/1e4}`，纯子会变成「Cost −0.0004」。
       */
      case "CostChange": {
        const sc = e.Scale?.[SKILL_LV] ?? 0
        const pct = e.ValueType === "Coefficient"
        out.effects.push({
          type: "ex_discount", scope,
          mode: pct ? "pct" : "flat",
          value: pct ? Number((-sc / 1e4).toFixed(4)) : -sc,
          uses: e.Uses ?? 1,
        })
        break
      }
      // 集火：把某个敌人点成「我方都打它」。跟 Provoke 是**两个不同的机制**，
      // 靠 kind 区分 —— 图标和底色都不一样（集火是蓝底减益，嘲讽是紫底），
      // 而且集火的标记落在被点的那个人身上，嘲讽的落在被拉走的人身上。目前池里没有集火角色。
      case "ConcentratedTarget": out.effects.push({ type: "taunt", kind: "focus", scope, turns: turns ?? 1 }); break
      // `DamageDebuff` **全都是持续伤害**（灼烧/中毒/冰冻/感电），不是「造成伤害降低」——
      // 全 272 人的 33 个无一例外都带 Icon 和 Period。当成 dmg_deal 减益的话，
      // 千世那条 54% 会变成 −54% 输出，方向都反了。
      case "DamageDebuff":
        out.effects.push({
          type: "dot", scope, icon: e.Icon || "Burn",
          scale: Number(((e.Scale?.[SKILL_LV] ?? 0) / 1e4).toFixed(4)),
          turns: turns ?? 4, period: msToTurns(e.Period) ?? 1,
        })
        break
      case "Knockback": out.effects.push({ type: "dropped", raw: "Knockback", why: "回合制无位置" }); break
      default: out.effects.push({ type: "unmapped", raw: e.Type })
    }
  }
  // 「获得 N 技能COST」（往 Cost 池加点，跟上面的 CostChange 打折是两回事）**没有结构化效果**
  // —— 瞬的普通技能 `Effects` 是个空数组（全 272 人里这样的技能有 9 个），数值只在描述里。
  if (!out.effects.some((e) => e.type === "cost")) {
    const gain = /获得\s*([\d.]+)\s*技能COST/.exec(desc)
    if (gain) out.effects.push({ type: "cost", scope: "self", value: Number(gain[1]) })
  }

  // 「不死」同样只在描述里（全 272 人 3 处：真里奈、纯子的 Public 与 GearPublic）。
  // 持续时间在两种位置都出现过 —— 纯子的 Public 写在「对自身造成以下效果(持续12.8秒)」、
  // GearPublic 写在「获得<s:Immortal>(持续12.8秒)」—— 所以整段找「持续 N 秒」。
  if (/<s:Immortal>/.test(desc)) {
    const d = /持续\s*([\d.]+)\s*秒/.exec(desc)
    out.effects.push({ type: "immortal", scope: "self", turns: d ? secToTurns(Number(d[1])) : 2 })
  }

  // 纯子 EX 的「失去25.7%的当前生命值」。跟艾米的 ExtraStatSource 一样是**全数据唯一一处**，
  // 没有结构化效果，也不会有第二个用例 —— 但漏了她就成了一个没有代价的 746% 直线 AoE。
  const hpCost = /失去\s*([\d.]+)\s*%\s*的当前生命值/.exec(desc)
  if (hpCost) out.effects.push({ type: "hp_cost", scope: "self", rate: Number(hpCost[1]) / 100 })

  // 不打人、效果又全落在自己身上 = 目标就是自己。`Effects` 为空时 resolveTarget 无从判断
  // （瞬的开局回费），会退成 enemy_single —— 那会让指令层按敌方去解析「打谁」。
  const real = out.effects.filter((e) => e.type !== "dropped" && e.type !== "unmapped")
  if (!out.hits?.length && real.length && real.every((e) => e.scope === "self")) {
    out.target = "self"
    out.count = 1
  }

  const charge = out.effects.find((e) => e.type === "charge")
  // 「立即换弹」在回合制里唯一有意义的翻译：上完效果立刻普攻一次。
  // 换弹强化也走这条 —— 换完弹当场就能开枪，那一发已经是强化过的，
  // 由 autoAttack() 从 u.charge 里扣掉，所以第 1 发落在施放回合、第 2 发落在下个回合。
  if (/立即换弹|马上换弹/.test(desc)) out.thenAutoAttack = true
  // 「换弹后失效」的增益没有 Duration 字段，让它跟强化射击同寿。
  // 进攻向 Buff 施放回合就算第 1 回合（那一回合他就要出手），而第 1 发也在施放回合，所以正好 = shots。
  // 按轮数存续的强化形态（瞬）不走这条：它的 Buff 自带 Duration，本来就跟强化同寿。
  if (charge?.shots) for (const e of out.effects) if (e.type === "buff") e.turns = charge.shots
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
    // 普攻也可能是范围的（全 272 人里 11 个带 Radius，池内只有千世）——
    // 只取 hits 不看 Radius 的话，她的圆形普攻会被当成单体
    autoAttack: {
      hits: nd ? nd.Hits.map((h) => Number(((nd.Scale[0] * h) / 1e4 / 100).toFixed(4))) : [1],
      ...(na?.Radius ? (({ target, count }) => ({ target, count }))(resolveTarget(na, [])) : {}),
    },
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
    // 既不打人也不上效果 = 生成出了一个什么都不做的技能。多半是原数据的 `Effects` 是空数组
    // （全 272 人里 9 个），数值只写在描述里，得单独抠 —— 不告警的话它会静默上线。
    if (!sk.hits?.length && !sk.effects.length) warn.push(`${u.name} / ${sk.name}: 空技能（既无伤害也无效果）`)
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
