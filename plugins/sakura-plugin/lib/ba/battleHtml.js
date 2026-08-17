/**
 * 战斗图的 HTML 模板层。
 *
 * 取代原来 1800 行的 canvas 手绘：布局交给 flex/grid，梯形卡片交给 clip-path，
 * 箭头交给内联 SVG。本模块是纯函数，产出完整 HTML 字符串，截图由 browser.js 负责。
 *
 * 配色走原作的亮色系（白面板 + 浅蓝底 + 深蓝字），与角色卡一致。属性色是按
 * 深色底挑的，落到文字/箭头上一律过 inkOf() 压暗，只有色块填充才用原色。
 *
 * 素材以 base64 内嵌 —— setContent 的基地址是 about:blank，相对路径解析不了；
 * 转换结果按角色缓存，同一局只算一次。
 */
import { CFG } from "./roster.js"
import { tmplOf, exWaitOf, turnCostOf, exRefreshPending, exCostOf, provokedBy, focusedOf, exLockedOf } from "./engine.js"
import { artOf, summonArtOf, statusIconOf, fontFace, FONT_STACK, ATTACK, ARMOR, inkOf, esc } from "./htmlAssets.js"

export const MAP_WIDTH = 1200
/** EX 卡从 4 张变成 6 张，塞不进一排（6×207 已经超出画布），拆成上下两排 */
const HUD_HEIGHT = 460
/**
 * 支援带：两个支援站在**自己半场角色的后方**（离交战线更远的那一侧），分散居中。
 * 它们不在 1~4 号位的战场分割里，所以刻意不跟主力排在同一行 —— 一眼就能看出「不在场上」。
 * 一条带 = 一个整格（Q 版 270 + 名字），主力那两行相应往中间挪同样的距离。
 */
const SUPPORT_GAP = 300
/** 阵列加高：前/中/后三层 + 抛出召唤物在敌方前排前面那一格 + 双方各一条支援带 */
const ARENA_H = 1200 + SUPPORT_GAP * 2
// 顶栏 130（含上下外边距）+ 阵列 + HUD；HUD 贴底绝对定位，三段正好接上
export const MAP_HEIGHT = 130 + ARENA_H + HUD_HEIGHT

const pctOf = (u) => Math.max(0, Math.min(100, (u.hp / u.maxhp) * 100))

/** 血条与盾条都切成四段：1/4 处压三道分隔线，掉了多少一眼能数出来 */
const SEGS = [25, 50, 75].map((p) => `<b class="seg" style="left:${p}%"></b>`).join("")

/** 特效层坐标系 = arena 内部坐标（arena 左右各留 34px 边距），不是整图坐标 */
const ARENA_MARGIN = 34
const ARENA_W = MAP_WIDTH - ARENA_MARGIN * 2
/** 四个号位是等分的 grid 列，中心落在 1/8、3/8、5/8、7/8 */
const LANE_X = [0, 1, 2, 3].map((i) => (ARENA_W * (i * 2 + 1)) / 8)
/**
 * 一行 CSS 上 `top:T` 时，锚点 y = T + 200（`.bars` 50 + `.art` 270 的经验中心）。
 * 主力两行让开一条支援带的高度，支援带贴在最外侧 —— 两处必须一起改，
 * 否则箭头会画到人以外的地方。
 */
const RED_Y = 200 + SUPPORT_GAP
const BLUE_Y = ARENA_H - 200 - SUPPORT_GAP
/**
 * 支援不占号位，所以**不压在任何一列上**：两个人站在两个战场的中线上 ——
 * 1·2 之间（1/4 处）和 3·4 之间（3/4 处）。压在 2、3 号位上会让人以为它们参与战场分割。
 */
const SUP_X = [ARENA_W / 4, (ARENA_W * 3) / 4]
const supportY = (side) => (side === 1 ? RED_Y - SUPPORT_GAP : BLUE_Y + SUPPORT_GAP)
/** 前排往交战线迈一个身位，中排半步，后排不动。深度是角色属性，不是格子。 */
const LINE_SHIFT = { 前: 96, 中: 48, 后: 0 }
/** 抛出型召唤物站在敌方前排再往前一个身位 */
const SUMMON_AHEAD = 200
function lineShiftOf(side, u) {
  const step = LINE_SHIFT[tmplOf(u).line] ?? 0
  return side === 1 ? step : -step
}
/**
 * 召唤物站在哪半场。两种来源，画法相反：
 *   **抛出型**（佩洛洛，日富美「打谁」）—— 扔到**敌方**半场，挡在对方前排前面
 *   **布置型**（掩体，静子「给谁」）—— 架在**自己**半场，挡在自家前排前面
 * 挡刀口径是同一条（按战场拦），只有画在哪半边不同 —— 画反了玩家会以为墙在替对面挡。
 */
function summonStandY(sm) {
  const half = sm.onAlly ? sm.side : 1 - sm.side
  const front = half === 1 ? RED_Y + LINE_SHIFT.前 : BLUE_Y - LINE_SHIFT.前
  return front + (half === 1 ? SUMMON_AHEAD : -SUMMON_AHEAD)
}

/**
 * 暴击框的爆炸轮廓。
 *
 * 长短半径交替成尖刺，外圈半径再按固定序列做长短不齐 —— 规则星形看着像徽章，
 * 不齐才像炸开。序列写死，保证同一份战报每次渲染完全一致。
 *
 * 尖刺长度按**暴击段占命中段的比例**缩放：每段独立判定，段数一多「至少一段暴击」
 * 就趋近必然（芹香 11 段有 88% 的局面会中至少一段），只看有没有暴击的话这个通道
 * 等于常亮，实际编码的是「段数多」而不是「这一发很痛」。
 *
 * 只动外圈半径，内圈不动 —— 坐标是百分比，框会在原有留白里自己缩小，
 * 下面 .fxlabel.crit 那圈给尖刺让位的 margin 按最大尖刺算，不用跟着改。
 */
const BURST_OUT = [50, 42, 50, 38, 47, 50, 40, 46, 50, 39, 48, 44]
const BURST_IN = [28, 24, 30, 25, 27, 23]
const BURST_BASE = 33 // 占比趋近 0 时的外圈：仍留得出缺口，不塌成圆

function burstPolygon(q) {
  const k = Math.max(0, Math.min(1, Number(q) || 0))
  const n = BURST_OUT.length * 2
  return Array.from({ length: n }, (_, i) => {
    const r = i % 2 === 0
      ? BURST_BASE + (BURST_OUT[i / 2] - BURST_BASE) * k
      : BURST_IN[((i - 1) / 2) % BURST_IN.length]
    const a = (Math.PI * 2 * i) / n - Math.PI / 2
    return `${(50 + r * Math.cos(a)).toFixed(1)}% ${(50 + r * Math.sin(a)).toFixed(1)}%`
  }).join(",")
}

// ---------------- 单位格 ----------------

/**
 * 状态格里的图标。全部画成 24×24 的图形，不写字 —— 22px 的方块里塞汉字读不出来。
 *
 * 图标只表达「是什么」，红底/蓝底表达「增益还是减益」，两者不重复编码，
 * 所以攻击力增减共用同一把剑，不做上下翻转。
 */
const SVG = (body) => `<svg viewBox="0 0 24 24" fill="currentColor">${body}</svg>`
const ICON = {
  // 剑：刃 + 护手 + 柄
  atk: SVG(`<path d="M12 2.2 14.7 7.6V13.4H9.3V7.6Z"/>
    <rect x="6.2" y="13.8" width="11.6" height="2.6" rx="1.3"/>
    <rect x="10.7" y="16.8" width="2.6" height="5" rx="1.3"/>`),
  dfs: SVG(`<path d="M12 2.2 20 5.4V12c0 4.9-3.4 8.3-8 9.8-4.6-1.5-8-4.9-8-9.8V5.4Z"/>`),
  heal: SVG(`<path d="M9.8 3.4h4.4v6.4h6.4v4.4h-6.4v6.4H9.8v-6.4H3.4V9.8h6.4Z"/>`),
  // 集火：同心圆靶。**这不是嘲讽的图标** —— 集火是「我方都打这个人」，
  // 标记落在被点名的那个人身上、蓝底减益。池内是切里诺的普技。
  focus: SVG(`<path d="M12 2.4a9.6 9.6 0 1 0 0 19.2 9.6 9.6 0 0 0 0-19.2Zm0 2.6a7 7 0 1 1 0 14 7 7 0 0 1 0-14Z"/>
    <circle cx="12" cy="12" r="3.4"/>`),
  // 眩晕：六角爆星
  stun: SVG(`<path d="M12 2.4 13.7 9.3 20.4 7.2 15.7 12l4.7 4.8-6.7-2.1L12 21.6l-1.7-6.9-6.7 2.1L8.3 12 3.6 7.2l6.7 2.1Z"/>`),
  // 闪避：两道速度线 + 前倾箭头
  dodge: SVG(`<path d="M11.4 3.2 20.4 12l-9 8.8-3-2.9L15.3 12 8.4 6.1Z"/>
    <rect x="2.6" y="7.4" width="4.6" height="2.5" rx="1.25"/>
    <rect x="2.6" y="14.1" width="4.6" height="2.5" rx="1.25"/>`),
  // 攻速：双折线快进。跟强化形态的上扬双层、闪避的单箭头都分得开
  aa: SVG(`<path d="M3.4 4.4 11.8 12 3.4 19.6Z"/><path d="M12.6 4.4 21 12 12.6 19.6Z"/>`),
  // 命中：准星
  acc: SVG(`<path d="M12 2.2a1.4 1.4 0 0 1 1.4 1.4v1.6a7 7 0 0 1 5.4 5.4h1.6a1.4 1.4 0 0 1 0 2.8h-1.6a7 7 0 0 1-5.4 5.4v1.6a1.4 1.4 0 0 1-2.8 0v-1.6a7 7 0 0 1-5.4-5.4H3.6a1.4 1.4 0 0 1 0-2.8h1.6a7 7 0 0 1 5.4-5.4V3.6A1.4 1.4 0 0 1 12 2.2Zm0 5.6a4.2 4.2 0 1 0 0 8.4 4.2 4.2 0 0 0 0-8.4Z"/>
    <circle cx="12" cy="12" r="2"/>`),
  // 持续伤害：火苗（灼烧/中毒/场地共用一个 —— 玩家要知道的是「在掉血」，不是掉血的花色）
  dot: SVG(`<path d="M12.6 2.2c.4 3.1-1.2 4.4-2.7 5.9C8.2 9.8 6.4 11.6 6.4 14.6a5.6 5.6 0 0 0 11.2 0
    c0-2.4-1-3.9-2.1-5.2-.5 1.3-1.3 2-2.2 2.3.8-3-.2-6.7-.7-9.5Z"/>`),
  // 暴击：大小两枚星芒（凹边四角星，跟眩晕的六角爆星、兜底的实心菱形都分得开）
  crit: SVG(`<path d="M10 2.2c.9 4.4 2.5 6 6.9 6.9-4.4.9-6 2.5-6.9 6.9-.9-4.4-2.5-6-6.9-6.9 4.4-.9 6-2.5 6.9-6.9Z"/>
    <path d="M17.4 13.6c.5 2.4 1.4 3.3 3.8 3.8-2.4.5-3.3 1.4-3.8 3.8-.5-2.4-1.4-3.3-3.8-3.8 2.4-.5 3.3-1.4 3.8-3.8Z"/>`),
  // 形态转换：四角闪光。原作是黄底特殊状态，跟红底加攻不是一类 ——
  // 鹤城 / 瞬有 `u.charge` 才出这一格，芹香只有攻击力增益，不要给她挂这个。
  charge: SVG(`<path d="M12 2.2 13.8 8.8 21 10.2l-5.4 3.2L17.4 21 12 16.6 6.6 21l1.8-7.6L3 10.2l7.2-1.4Z"/>`),
  // 不死：心形（治疗用的是十字，两者形状差得远，不会串）
  immortal: SVG(`<path d="M12 21.1 4.3 13.3a5.3 5.3 0 1 1 7.7-7.3 5.3 5.3 0 1 1 7.7 7.3Z"/>`),
  // EX 打折：落到底线上的下箭头。跟强化形态那个上扬双折线反着来，一眼分得开
  exDiscount: SVG(`<path d="M10.5 2.6h3v8.4l3.4-3.4 2.1 2.1-7 7-7-7 2.1-2.1 3.4 3.4Z"/>
    <rect x="4" y="19.2" width="16" height="2.6" rx="1.3"/>`),
  // 预警：感叹号
  warn: SVG(`<rect x="10.3" y="3.2" width="3.4" height="11" rx="1.7"/>
    <circle cx="12" cy="18.4" r="2.2"/>`),
  // 兜底：没画过的属性用中性菱形，总比拿剑冒充强
  other: SVG(`<path d="M12 2.6 21.4 12 12 21.4 2.6 12Z"/>`),
}
/** SVG 兜底：缺原作图时才用。治疗力和受治疗量原作是两套图，别再合成一个十字 */
const ICON_OF_STAT = {
  atk: "atk", dmg_deal: "atk", aa: "aa", dfs: "dfs", dmg_take: "dfs",
  heal: "heal", heal_taken: "heal", dodge: "dodge", acc: "acc",
  crit: "crit", crit_dmg: "crit", crit_dmg_flat: "crit",
  // 暴击/暴伤抵抗是挨打时才生效的，跟防御同一个盾图标
  crit_res: "dfs", crit_dmg_res_flat: "dfs", crit_dmg_res: "dfs",
}

/**
 * 属性 → 原作状态图文件名（不带正负）。减益用 `${name}-down`。
 *
 * HEAL 是治疗力（施术者奶多少），REC 是受治疗量。白热化的 −50% 减疗走 rec-down，
 * 不能去查 heal-down —— 那是另一张图，而且上一轮根本没拉下来。
 * 受伤增减也有自己的图（Buff DMG Reduced / Debuff DMG Increased），别再拿防御盾顶。
 */
const OFFICIAL_STAT = {
  atk: "atk", atk_flat: "atk",
  dfs: "dfs", dfs_flat: "dfs",
  dmg_take: "dmg_take",
  aa: "aa", acc: "acc", dodge: "dodge",
  heal: "heal",
  heal_taken: "rec",
  cost_regen: "cost-regen",
  crit: "crit", crit_dmg: "crit_dmg", crit_dmg_flat: "crit_dmg",
  crit_res: "crit_res", crit_dmg_res_flat: "crit_dmg_res", crit_dmg_res: "crit_dmg_res",
  dmg_deal: "dmg_deal",
}

/** 原作图标自带底色，缺图才退回我们画的 SVG */
function officialMark(name, extra = "") {
  const uri = statusIconOf(name)
  if (uri) return `<i class="mk official ${extra}"><img src="${uri}" alt=""></i>`
  return ""
}
function markOrSvg(name, svgKey, css, extra = "") {
  return officialMark(name, extra) ||
    `<i class="mk ${css} ${extra}">${ICON[svgKey] || ICON.other}</i>`
}

/**
 * 血条上方那一排状态格。
 *
 * 攻击力排第一（目前也只有它会出现），同属性多层合成一格标 ×N。
 * 增益红底、减益蓝底、技能预警黄底 —— 跟着原作走，不是「红=坏」那套。
 * 只剩 1 回合的效果整格变浅：本回合结束就没了，得先给出预告。
 */
function statusMarks(u, provoked) {
  if (!u.alive) return ""
  const marks = []

  // 同一 stat 的多层合并成一格；层数、总量、最短剩余回合都要
  const agg = new Map()
  for (const b of u.buffs || []) {
    const cur = agg.get(b.stat) || { v: 1, n: 0, turns: Infinity }
    cur.v *= 1 + b.value
    cur.n += 1
    cur.turns = Math.min(cur.turns, b.turns ?? Infinity)
    agg.set(b.stat, cur)
  }
  const rank = (s) => (s === "atk" ? 0 : s === "cost_regen" ? 1 : 2)
  const order = [...agg.keys()].sort((a, b) => rank(a) - rank(b))
  for (const stat of order) {
    const { v, n, turns } = agg.get(stat)
    const d = Math.round((v - 1) * 100)
    if (!d) continue
    const extra = `${turns <= 1 ? "fading" : ""}${n > 1 ? "" : ""}`
    const down = stat === "dmg_take" ? d > 0 : d < 0
    const file = OFFICIAL_STAT[stat]
    const tag = n > 1 ? `<s>×${n}</s>` : ""
    const official = file && officialMark(down ? `${file}-down` : file, extra)
    if (official) marks.push(official.replace("</i>", `${tag}</i>`))
    else {
      marks.push(`<i class="mk ${d > 0 ? "buff" : "debuff"} ${extra}">
      ${ICON[ICON_OF_STAT[stat]] || ICON.other}${tag}</i>`)
    }
  }
  if (u.regens?.length) marks.push(markOrSvg("regen", "heal", "buff"))
  // 灼烧/中毒这类**挂在身上的 debuff** 才出状态格。
  // 千世的 EX 是固定场地，不是 debuff，状态格不出图标 —— 地上的蓝圈已经表达了。
  // 她的 ExtraPassive 灼烧现在也没接（被动先不上），所以这条目前不会亮。
  const dotMarks = (u.dots || []).filter((d) => d.icon !== "Zone")
  if (dotMarks.length) {
    marks.push(`<i class="mk debuff ${Math.min(...dotMarks.map((d) => d.turns)) <= 1 ? "fading" : ""}">
      ${ICON.dot}${dotMarks.length > 1 ? `<s>×${dotMarks.length}</s>` : ""}</i>`)
  }
  // **嘲讽的减益标记落在被拉走的人身上，不是放嘲讽的那个人身上**（原作就是这么画的）：
  // 中了嘲讽的顶一个紫底感叹号，椿自己什么都不多。集火是另一回事，蓝底靶心画在被点名的人头上。
  if (provoked) marks.push(markOrSvg("provoke", "warn", "provoke"))
  if (focusedOf(u)) marks.push(markOrSvg("focus", "focus", "debuff"))
  if (u.stun > 0) {
    const cc = u.stunIcon === "Fear" ? "fear" : "stun"
    marks.push(markOrSvg(cc, "stun", "debuff"))
  }
  // 形态转换（`u.charge`）：鹤城换弹强化、瞬的强化索敌。原作是黄底特殊状态，
  // 不是红底增益 —— 芹香的加攻不要走这里。
  if (u.charge) {
    const left = u.charge.turns ?? u.charge.shots
    marks.push(markOrSvg("form", "charge", "special", left <= 1 ? "fading" : ""))
  }
  // 不死：残血 1 点却打不死，不出格的话对手会以为是自己算错了伤害
  if (u.immortal > 0) marks.push(markOrSvg("immortal", "immortal", "buff", u.immortal <= 1 ? "fading" : ""))
  // 急救（绫音爱用品）：残血才消耗回血，不出格对手看不出谁还留着一次救援
  if (u.ward) marks.push(markOrSvg("buff-aid", "heal", "buff"))
  // Fury（妮露）：期间她的 EX 威力翻倍，对手看得见才能决定要不要抢先手
  if (u.fury > 0) marks.push(markOrSvg("fury", "charge", "special", u.fury <= 1 ? "fading" : ""))
  // 能量充能（爱丽丝）：三档各一张官方图，**攒到满充她的 EX 就是两倍伤害**，
  // 这是她唯一的强度来源，不出格对手根本没法判断该不该在这一轮拆她
  if (u.energy > 0) marks.push(markOrSvg(`energy-${u.energy}`, "charge", "special"))
  // EX 打折：卡上的费用数字已经变了，这一格是给对手看的 —— 血条在谁头上就是谁便宜
  if (u.exDiscount?.uses) {
    const official = officialMark("ex-discount")
    const tag = u.exDiscount.uses > 1 ? `<s>×${u.exDiscount.uses}</s>` : ""
    marks.push(official
      ? official.replace("</i>", `${tag}</i>`)
      : `<i class="mk buff">${ICON.exDiscount}${tag}</i>`)
  }

  // 普通技能就绪 = 下个己方回合就会放，属于「预警」而不是状态
  const tr = tmplOf(u).skill?.trigger?.type
  if (u.skillCd <= 0 && (tr === "cooldown" || tr === "on_auto" || tr === "on_kill")) {
    marks.push(`<i class="mk warn">${ICON.warn}</i>`)
  }
  return marks.join("")
}

function unitCell(state, side, u, fx) {
  const t = tmplOf(u)
  const armor = ARMOR[t.defType] || "#8AA"
  const hp = pctOf(u)
  // 护盾按自己的上限算比例：刚上盾就是满格，被啃掉多少缩多少。拿 maxhp 当分母的话，
  // 一个小盾一上来就只有一小截，看不出它还剩几成
  const shieldPct = u.shield > 0 ? Math.min(100, (u.shield / (u.shieldMax || u.shield)) * 100) : 0
  const chibi = artOf(t.id, "chibi")
  const marks = statusMarks(u, Boolean(provokedBy(state, u)))
  const dy = lineShiftOf(side, u)
  return `
  <div class="unit ${u.alive ? "" : "dead"}"${dy ? ` style="transform:translateY(${dy}px)"` : ""}>
    <div class="bars">
      ${marks ? `<div class="marks">${marks}</div>` : ""}
      ${shieldPct > 0 ? `<div class="shieldbar"><s style="width:${shieldPct}%"></s>${SEGS}</div>` : ""}
      <div class="hpbar"><div class="hp" style="width:${hp}%;background:${armor}"></div>${SEGS}</div>
    </div>
    ${fx || ""}
    <div class="art">
      ${chibi ? `<img src="${chibi}" alt="">` : `<div class="ph" style="background:${ATTACK[t.atkType]}">${esc(t.name[0])}</div>`}
      <div class="shadow"></div>
    </div>
    ${u.alive ? "" : `<div class="ko">KO</div>`}
  </div>`
}

// ---------------- 伤害特效层 ----------------

/** 从 from 朝 to 的方向退回 d 像素，用来把线两端从角色身上让开 */
function pullBack(from, to, d) {
  const dx = to.x - from.x, dy = to.y - from.y
  const len = Math.hypot(dx, dy) || 1
  return { x: to.x - (dx / len) * d, y: to.y - (dy / len) * d }
}

/**
 * 出手方向的箭头。数字不在这一层 —— 它们挂在各自的承受方身上。
 *
 * 必须带箭头：光是虚线，两端长得一样，看不出是谁打谁。
 * marker 按颜色各建一个，不用 `context-stroke`（那个的浏览器支持没保证）。
 */
function arrowLayer(state, events) {
  // 支援不在 units 里，号位是 4/5 —— 箭头的颜色要读施法者的攻击属性，走这个才不会 undefined
  const actorOf = (ref) => (ref?.pos >= 4
    ? (state.sides[ref.side]?.supports || [])[ref.pos - 4]
    : state.sides[ref.side]?.units[ref.pos])
  const posOf = (ref) => {
    if (!ref) return null
    if (ref.summon) {
      const sm = (state.sides[ref.side]?.summons || []).find((s) => s.alive && s.idx === ref.pos)
      return { x: LANE_X[ref.pos], y: sm ? summonStandY(sm) : ARENA_H / 2 }
    }
    // 支援站在自己半场的最外侧，只占中间两列。身位偏移对它们不成立（它们不在前中后排里）
    if (ref.pos >= 4) return { x: SUP_X[ref.pos - 4] ?? ARENA_W / 2, y: supportY(ref.side) }
    const u = state.sides[ref.side]?.units[ref.pos]
    const base = ref.side === 1 ? RED_Y : BLUE_Y
    return { x: LANE_X[ref.pos], y: base + (u ? lineShiftOf(ref.side, u) : 0) }
  }
  const arrows = []
  const markers = new Map()
  for (const ev of events) {
    if (ev.type !== "action") continue
    const a = posOf(ev.source)
    if (!a) continue
    for (const tg of ev.targets || []) {
      // 自身增益/自疗的目标就是自己，画出来是一根退化的短棍，跳过
      if (tg.side === ev.source.side && tg.pos === ev.source.pos) continue
      const b = posOf(tg)
      if (!b) continue
      // 亮底上属性原色（尤其贯通的 #F0C547）几乎看不见，箭头走压暗版
      const src = actorOf(ev.source)
      const color = inkOf((src && ATTACK[tmplOf(src).atkType]) || "#8AF")
      if (!markers.has(color)) markers.set(color, `ah${markers.size}`)
      const mx = (a.x + b.x) / 2 + (a.x < b.x ? 40 : -40)
      const my = (a.y + b.y) / 2
      const mid = { x: mx, y: my }
      // 两端各退开一截：箭头扎进 Q 版小人里就白画了
      const s = pullBack(mid, a, 78)
      const e = pullBack(mid, b, 96)
      // 三种出手各一种笔触，见 css() 里的 .arrows>path 分支
      const kind = ev.action === "ex" ? "ex" : ev.action === "skill" ? "skill" : "auto"
      arrows.push(`<path class="${kind}" d="M${s.x},${s.y} Q${mx},${my} ${e.x},${e.y}" stroke="${color}" marker-end="url(#${markers.get(color)})" />`)
    }
  }
  const defs = [...markers].map(([color, id]) =>
    `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4.4" markerHeight="4.4" orient="auto">
      <path d="M0,0 L10,5 L0,10 Z" fill="${color}"/></marker>`).join("")
  return `<svg class="arrows" viewBox="0 0 ${ARENA_W} ${ARENA_H}"><defs>${defs}</defs>${arrows.join("")}</svg>`
}

/** 暴击只换外框形状，不换字号也不加 CRIT 字样；尖刺长度按暴击段占比走 */
/** 短横排到多少段就改印数字。12 段是琴里 40 段 / 妮露 60 段之前池内的最大值（芹香 11 段） */
const SEG_BARS_MAX = 12

/**
 * 多段的表达：**12 段以下画短横，亮的是命中段；12 段及以上直接印「20hits」**。
 *
 * 琴里的爱用品普技是 40 段、妮露的 EX 是 60 段 —— 一段一个 `<s>` 会把整个数字标签撑爆，
 * 而且四十个小格子本来也数不清。改成数字之后信息一点没少：全中就印总数，
 * 有闪避就印「命中/总数」，跟短横那一行传达的是同一件事。
 */
function segsHtml(segs) {
  if (!segs) return ""
  if (segs.total >= SEG_BARS_MAX) {
    const txt = segs.landed >= segs.total ? `${segs.total}hits` : `${segs.landed}/${segs.total}hits`
    return `<u class="segn">${txt}</u>`
  }
  return `<div class="segs">${Array.from({ length: segs.total }, (_, i) =>
    `<s class="${i < segs.landed ? "on" : ""}"></s>`).join("")}</div>`
}

function fxLabel(ev, wide) {
  const segs = Number(ev.hits) > 1
    ? { total: Number(ev.hits), landed: Math.max(0, Math.min(Number(ev.hits), Number(ev.landed ?? ev.hits))) }
    : null
  // critHits 是后加的字段：老对局（Redis 里存着的）没有，按满爆退化回原来的样子
  const landed = Number(ev.landed) || (segs ? segs.landed : 1) || 1
  const critQ = ev.critHits == null ? 1 : Math.min(1, Number(ev.critHits) / landed)
  // 持续伤害单独一种颜色：它没有施法者连线（施加者可能已阵亡），
  // 不换色的话玩家会以为是谁打的、然后去找那根不存在的线
  const kind = ev.type === "miss" ? "miss" : ev.type === "heal" ? "heal" : ev.dot ? "dot" : "dmg"
  // 全被掩体挡下时印 BLOCK 而不是 MISS —— 两件事的应对完全不同：
  // 一个要先拆墙 / 换个打得进去的角色，一个要堆命中
  const allBlocked = ev.type === "miss" && ev.blocked === ev.hits
  const text = ev.type === "miss" ? (allBlocked ? "BLOCK" : "MISS")
    : ev.type === "heal" ? `+${ev.amount}`
      : String(ev.totalAmount ?? ev.amount)
  /**
   * 小字这一格三选一，优先级 BLOCK > 克制：**部分段被掩体挡下**时印 `BLOCKn`。
   * 掩体格挡是一次独立判定（跟命中/闪避无关），玩家得看得出这一发是被墙吃掉的。
   */
  const qual = !allBlocked && ev.blocked ? `BLOCK${ev.blocked}`
    : ev.affinity === "weak" ? "WEAK" : ev.affinity === "resist" ? "RESIST" : ""
  const qualCls = !allBlocked && ev.blocked ? "block" : ev.affinity
  return `
    <div class="fxlabel ${kind} ${allBlocked ? "blocked" : ""} ${ev.crit ? "crit" : ""} ${wide ? "wide" : ""}">
      ${ev.crit ? `<span class="burst" style="--burst:polygon(${burstPolygon(critQ)})"></span>` : ""}
      <b>${esc(text)}</b>
      ${qual ? `<i class="${qualCls}">${qual}</i>` : ""}
      ${segsHtml(segs)}
    </div>`
}

/**
 * 数字按「承受方」分组：我打你，数字就出现在你血条下面，压在你的角色身上。
 * 挂进单位格而不是按坐标绝对定位 —— 血条位置由 flex 决定，写死坐标迟早对不上。
 *
 * 多人集火同一个目标时排成两列（左→右、上→下），不往下堆成一长条。事件顺序就是
 * 出手顺序，所以哪个数字是谁打的靠位次读，不用再去分辨箭头。
 * 护盾不出数字，只体现为血条上那条蓝色假血条。
 * @returns {Map<string,string>} `${side}:${pos}` → 该单位的整个数字区 HTML
 */
function fxByUnit(events) {
  const byUnit = new Map()
  for (const ev of events) {
    // cost 事件不出标签：目前没有靠技能回费的角色，真加了也只落在文字日志里
    if (!["damage", "miss", "heal"].includes(ev.type) || !ev.target) continue
    // 召唤物与同号位的角色必须分开挂，否则打人偶的数字会跑到队友血条下面
    const key = `${ev.target.side}:${ev.target.pos}${ev.target.summon ? ":s" : ""}`
    if (!byUnit.has(key)) byUnit.set(key, [])
    byUnit.get(key).push(ev)
  }
  const out = new Map()
  for (const [key, list] of byUnit) {
    const cols = list.length > 1 ? 2 : 1
    // 奇数个时最后一个独占整行，否则会孤零零挂在左列上
    const orphan = list.length > 1 && list.length % 2 === 1 ? list.length - 1 : -1
    const html = list.map((ev, i) => fxLabel(ev, i === orphan)).join("")
    out.set(key, `<div class="fxstack" style="grid-template-columns:repeat(${cols},auto)">${html}</div>`)
  }
  return out
}

// ---------------- 底部 HUD ----------------

/** 底部只留两样东西：四张 EX 卡 + Cost 条 */
function hud(state) {
  const side = state.activeSide
  const s = state.sides[side]
  const active = state.phase === "command"
  const avail = active ? turnCostOf(s) : Math.floor(s.cost)

  const card = (u) => {
    const t = tmplOf(u)
    const icon = artOf(t.id, "icon")
    const ac = ATTACK[t.atkType] || "#8AA"
    // 冷却只压灰，不写「还需 N」—— 具体还差几个属于文字战报的信息量，图上给不到
    // 减员刷新在交回合时落地；老对局若还没跑过，按「待刷新」把冷却卡画成可放
    const locked = Boolean(exLockedOf(state, u))
    const blocked = active && !exRefreshPending(state, s) && (exWaitOf(s, u) > 0 || locked)
    // 打过折的按折后价画：卡上写 1 费、放的时候说 Cost 不够，那是最糟的一种不一致
    const cost = exCostOf(u)
    const ready = active && !blocked && avail >= cost
    const progress = Math.max(0, Math.min(1, avail / Math.max(1, cost)))
    // 两种遮罩表达两件不同的事：冷却 / 嘲讽 / 恐惧是「现在放不出」，整张压灰盖平；
    // Cost 不够是「还在攒」，用扇形扫过去，扫掉多少就是攒了多少。
    // 嘲讽和恐惧的「为什么」画在角色头上（紫底感叹号 / 眩晕格），不在卡上再写一遍。
    // .frame 是比 .face 大 3px 的同形状底板 —— clip-path 会把 box-shadow 一起裁掉，
    // 平行四边形的描边只能靠垫一层实现。
    return `
    <div class="excard ${ready ? "ready" : ""} ${blocked ? "cd" : ""}" style="--ac:${ac};--ink:${inkOf(ac)}">
      <div class="frame">
        <div class="face">
          ${icon ? `<img src="${icon}" alt="">` : `<div class="ph">${esc(t.name[0])}</div>`}
          ${blocked ? `<div class="block"></div>`
        : ready ? "" : `<div class="sweep" style="--p:${(progress * 100).toFixed(1)}%"></div>`}
        </div>
      </div>
      <span class="cost ${cost < t.ex.cost ? "cut" : ""}">${cost}</span>
      <span class="nm">${esc(t.name)}</span>
    </div>`
  }
  // 6 张同尺寸的卡塞不进 1200 宽（6×207 + 间距已经超了），拆成上排 4 主力、下排 2 支援。
  // 支援永远不死，所以下排恒定两张 —— 它们也是主力全被嘲讽那一轮唯一放得出 EX 的人。
  const cards = s.units.filter((u) => u.alive).map(card).join("")
  const supCards = (s.supports || []).map(card).join("")

  // 条按小数填：side.cost 可以带小数（后手开局 1.5），没凑整的回复在 regenAcc 里，
  // 加起来才是真实进度 —— 4.5 就画成 4 格满 + 第 5 格半格
  const filled = Math.max(0, Math.min(CFG.COST_MAX, s.cost + (s.regenAcc || 0)))
  const cells = Array.from({ length: CFG.COST_MAX }, (_, i) => {
    const w = Math.max(0, Math.min(1, filled - i)) * 100
    return `<s>${w > 0 ? `<i style="width:${w.toFixed(1)}%"></i>` : ""}</s>`
  }).join("")

  return `
  <div class="hud ${side === 0 ? "blue" : "red"}">
    <div class="excards">
      <div class="exrow">${cards || '<div class="excard empty">无可用 EX</div>'}</div>
      ${supCards ? `<div class="exrow sup">${supCards}</div>` : ""}
    </div>
    <div class="cells">${cells}</div>
  </div>`
}

// ---------------- 顶栏 ----------------

/** 一行：红方血条 vs 蓝方血条，各自下面写群昵称。其余一概不放 */
function header(state) {
  const ratio = (i) => {
    const s = state.sides[i]
    const hp = s.units.reduce((a, u) => a + u.hp, 0)
    const mx = s.units.reduce((a, u) => a + u.maxhp, 0)
    return mx ? (hp / mx) * 100 : 0
  }
  const team = (i) => `
    <div class="team ${i === 0 ? "blue" : "red"}">
      <div class="bar"><s style="width:${ratio(i)}%"></s><em>${ratio(i).toFixed(0)}%</em></div>
      <div class="nm">${esc(state.sides[i].name)}</div>
    </div>`
  return `<div class="head">${team(1)}<span class="vs">VS</span>${team(0)}</div>`
}

// ---------------- 样式 ----------------

function css() {
  return `
${fontFace()}
*{margin:0;padding:0;box-sizing:border-box}
body{width:${MAP_WIDTH}px;height:${MAP_HEIGHT}px;font-family:${FONT_STACK};
  background:#E7F0F8;color:#22384F;-webkit-font-smoothing:antialiased}
#map{position:relative;width:${MAP_WIDTH}px;height:${MAP_HEIGHT}px;overflow:hidden;
  background:radial-gradient(120% 78% at 50% 6%,#FFFFFF 0%,rgba(255,255,255,0) 62%),
    linear-gradient(180deg,#EDF4FB 0%,#DFEAF5 46%,#D4E2F0 100%)}
#map::before{content:"";position:absolute;inset:0;opacity:.5;
  background:repeating-linear-gradient(115deg,rgba(78,147,232,.09) 0 2px,transparent 2px 74px)}

/* 顶栏：红条 VS 蓝条，昵称写在条下面，别的都不要 */
.head{display:flex;align-items:flex-start;gap:22px;margin:22px 34px 14px;padding:16px 28px;
  border-radius:18px;background:rgba(255,255,255,.94);border:1px solid rgba(70,120,175,.2);
  box-shadow:0 4px 14px rgba(40,80,125,.1)}
.head .team{flex:1;min-width:0}
.head .bar{position:relative;height:26px;border-radius:13px;background:rgba(40,80,125,.14);overflow:hidden}
.head .bar s{display:block;height:100%;border-radius:13px}
/* 百分比压在条内正中：底下可能是深红/深蓝，也可能是浅灰空槽，
   所以用深色字配白色外发光，两种底上都读得出来 */
.head .bar em{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  font-style:normal;font-size:15px;color:#1E3348;text-shadow:0 0 4px rgba(255,255,255,.95),0 0 2px rgba(255,255,255,.95)}
.head .red .bar s{background:linear-gradient(90deg,#F0838E,#D9485C)}
.head .blue .bar s{background:linear-gradient(90deg,#7CBBF2,#2E7FD4)}
/* 蓝方的条从右往左掉，两队对着中线对打 */
.head .blue .bar{display:flex;justify-content:flex-end}
.head .nm{margin-top:8px;font-size:21px;color:#1E3348;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.head .red .nm{text-align:left}
.head .blue .nm{text-align:right}
.head .vs{align-self:center;margin-top:-4px;font-size:22px;letter-spacing:2px;color:#8397AC}

/* 阵列：上下各染一层阵营色，交战线居中 */
.arena{position:relative;height:${ARENA_H}px;margin:0 34px;border-radius:24px;
  border:1px solid rgba(70,120,175,.16);
  background:linear-gradient(180deg,rgba(217,72,92,.08) 0%,rgba(255,255,255,.52) 27%,
    rgba(255,255,255,.52) 73%,rgba(46,127,212,.13) 100%)}
.laneRow{position:absolute;left:0;right:0;z-index:1;display:grid;grid-template-columns:repeat(4,1fr)}
/* 主力两行让开一条支援带；数值跟 RED_Y / BLUE_Y 是同一个 SUPPORT_GAP，改一处必须改两处 */
.laneRow.red{top:${SUPPORT_GAP}px}
.laneRow.blue{bottom:${SUPPORT_GAP}px}
/* 支援带是**两列**（不是主力那套四列）：格心天然落在 1/4 和 3/4，
   正好是 1·2 战场和 3·4 战场的中线，跟 SUP_X 对齐 */
.supRow{position:absolute;left:0;right:0;z-index:1;display:grid;grid-template-columns:repeat(2,1fr)}
.supRow.red{top:0}
.supRow.blue{bottom:0}
/* 支援不画血条：它们打不到，血量维度对玩家没有意义。名字挪到脚下，跟主力区分开 */
.unit.sup>.bars{height:26px}
.supnm{font-size:19px;color:#41586E;letter-spacing:.04em}
.unit{position:relative;display:flex;flex-direction:column;align-items:center;gap:6px}
/* 变灰只作用到角色本体，不能套在 .unit 上 —— 数字是 .unit 的子元素，
   一起淡掉会让「打死这一下」正好最看不清 */
.unit.dead>.bars,.unit.dead>.art,.unit.dead>.ko{opacity:.46;filter:grayscale(1)}
/* 固定高度 + 底对齐：状态格和盾条时有时无，靠这个保证血条在所有格子里都齐平 */
.bars{width:210px;height:50px;display:flex;flex-direction:column;justify-content:flex-end;gap:3px}
.marks{display:flex;gap:3px;margin-bottom:1px}
.mk{position:relative;width:22px;height:22px;border-radius:4px;flex:none;font-style:normal;color:#fff;
  display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(20,45,70,.28)}
.mk svg{width:15px;height:15px;display:block}
.mk.buff{background:#E0463F}
.mk.debuff{background:#2F6FD0}
.mk.warn{background:#F5B915;color:#4A3100}
/* 形态转换：原作「普通攻击/形态转换」是黄底特殊状态，跟红底增益、黄底技能就绪分开 */
.mk.special{background:#E8A40A;color:#fff}
/* 原作状态图自带圆角色底，别再垫一层，否则黄格套黄格 */
.mk.official{background:none;box-shadow:none;overflow:visible;width:22px;height:25px}
.mk.official img{width:22px;height:25px;display:block}
/* 被嘲讽：紫底感叹号，跟原作一致。它既不是增益也不是减益那两种底色，单独一档 */
.mk.provoke{background:#8B4FD6}
.mk.provoke svg{width:13px;height:13px}
.mk.warn svg{width:13px;height:13px}
/* 只剩 1 回合的效果整格变浅：本回合一结束就没了，要先给出预告 */
.mk.fading{opacity:.4}
.mk s{position:absolute;right:-4px;bottom:-5px;min-width:14px;padding:0 2px;border-radius:4px;
  background:#22384F;color:#fff;font-size:9px;line-height:12px;text-decoration:none}
.hpbar{position:relative;height:13px;border-radius:7px;background:rgba(40,80,125,.16);overflow:hidden}
.hpbar .hp{position:absolute;inset:0;border-radius:7px}
/* 护盾＝真血上面单独一条假血条（不是压在真血里）。
   这个蓝要和神秘/特殊装甲的天蓝 #559DE4 拉开，所以用更深更饱和的宝蓝 */
.shieldbar{position:relative;height:6px;border-radius:3px;overflow:hidden}
.shieldbar s{display:block;height:100%;border-radius:3px;background:#2A46D2}
.seg{position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;background:rgba(255,255,255,.9)}
.ko{margin-top:2px;padding:2px 10px;border-radius:6px;font-size:12px;letter-spacing:1px;
  background:rgba(60,80,100,.16);color:#3E5468}
.art{position:relative;width:250px;height:270px;display:flex;align-items:flex-end;justify-content:center}
.art img{max-width:100%;max-height:100%;object-fit:contain;filter:drop-shadow(0 8px 11px rgba(35,70,110,.28))}
.art .ph{width:150px;height:150px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  font-size:56px;color:#fff;margin-bottom:26px}
.art .shadow{position:absolute;bottom:6px;left:50%;transform:translateX(-50%);
  width:150px;height:26px;border-radius:50%;background:rgba(40,80,120,.22);filter:blur(5px)}
.engage{position:absolute;left:0;right:0;top:50%;height:1px;transform:translateY(-50%);
  background:linear-gradient(90deg,transparent,rgba(60,110,160,.3) 16%,rgba(60,110,160,.3) 84%,transparent)}

/* 场地：脚边一片普通蓝的立体圈（透视椭圆，躺在地上），压在立绘底下。
   浅蓝在战场底上看不清，描边和填充都走 UI 蓝 #2E7FD4。
   蓝方脚贴 arena 底边，圈身往中线收，别往下探被裁掉。 */
.zones{position:absolute;inset:0;width:100%;height:100%;z-index:0;
  pointer-events:none;overflow:visible}
.zones .pad{fill:url(#zoneFill)}
.zones .ring{fill:none;stroke:#2E7FD4;stroke-width:3}
.zones .inner{fill:none;stroke:rgba(46,127,212,.55);stroke-width:1.4}
.zones .near{fill:none;stroke:#2E7FD4;stroke-width:4.6;stroke-linecap:round}
.zones text{font-size:18px;fill:#1A5FA8;text-anchor:middle;dominant-baseline:middle;
  paint-order:stroke;stroke:#fff;stroke-width:4.5px}
.zones .fading{opacity:.45}

/* 召唤物：抛出型站在敌方半场、对方前排再往前一格。列仍是挡住的号位 */
.smRow{position:absolute;left:0;right:0;top:0;bottom:0;z-index:2;
  display:grid;grid-template-columns:repeat(4,1fr);align-items:center;pointer-events:none}
/* .sm 必须 position:relative —— .fxstack 是绝对定位的，不给锚点它会挂到 .smRow 上 */
.sm{position:relative;display:flex;flex-direction:column;align-items:center;gap:4px}
/* 站在红半场（挡红方）时数字往交战线甩；站在蓝半场同理 */
.sm.foe-red .fxstack{top:auto;bottom:118px}
/* 站在蓝方半场时数字往下甩，要让开血条下面那行名字（掩体架在自己这边，正好撞上） */
.sm.foe-blue .fxstack{top:158px;bottom:auto}
.smart{position:relative;width:104px;height:104px;display:flex;align-items:center;justify-content:center}
.smart img{width:104px;height:104px;object-fit:contain;
  filter:drop-shadow(0 4px 8px rgba(40,80,125,.28))}
/* 召唤物的血条**直接复用 .hpbar**，只改宽度：一样的高度、圆角、装甲色填充、四段白线。
   它照吃属性克制，凭什么用一条自成一派的细紫条 —— 玩家得能一眼看出拆墙该带什么属性。
   只有宽度收窄，因为它到底不是第 5 个队员 */
.smhp{width:130px}
/* 持续时间：血条下面一条橙色，按剩余回合缩，不再用数字 */
.smdur{width:130px;height:5px;border-radius:3px;background:rgba(40,80,125,.16);overflow:hidden}
.smdur s{display:block;height:100%;background:linear-gradient(90deg,#F3B14A,#E07A22)}
/* **必须是直接子选择器**：血条里的四段分隔线 .seg 也是 <b>，被这条命中就会顶着
   8px 圆角和 1px 8px 内边距变成三坨白药丸 —— 跟 .arrows path{fill:none} 干掉箭头
   是同一种错法：拿元素名当选择器，顺手把别人的元素也改了。
   （这段 CSS 整个活在模板字符串里，注释里也不能出现反引号） */
.sm > b{font-size:13px;color:#22384F;font-weight:600;
  background:rgba(255,255,255,.86);border-radius:8px;padding:1px 8px}

/* 特效层 */
.arrows{position:absolute;inset:0;width:100%;height:100%;z-index:3;pointer-events:none;overflow:visible}
/* 亮底上箭头比深底抢眼得多，压细压淡；白色外发光把它和角色分开 */
/* 必须是直接子选择器：marker 里的箭头也是 <path>，被 fill:none 命中就整个消失
   （CSS 声明压过 SVG 的 fill 表现属性） */
.arrows>path{fill:none;stroke-linecap:round;filter:drop-shadow(0 0 3px rgba(255,255,255,.95))}
/* 三种出手要一眼分得开：普攻最细最碎，普通技能中等长虚线，EX 最粗且实线 */
.arrows>path.auto{stroke-width:2.4;opacity:.5;stroke-dasharray:3 9}
.arrows>path.skill{stroke-width:3.4;opacity:.62;stroke-dasharray:15 10}
.arrows>path.ex{stroke-width:5;opacity:.72}
/* 数字叠在承受方血条正下方，压住角色是有意的 —— 挨打的是谁要一眼看出来 */
/* top 要留够暴击尖刺的 19px 负 inset，否则爆裂框会啃到 50px 高的状态区。
   列数由 fxByUnit 按数量内联下发：1 条居中，2 条以上排两列 */
.fxstack{position:absolute;top:74px;left:50%;transform:translateX(-50%);z-index:4;
  display:grid;justify-items:center;align-items:start;gap:6px 16px}
.fxstack .wide{grid-column:1 / -1}
.fxlabel{position:relative;min-width:56px;padding:7px 11px 8px;border-radius:11px;
  background:rgba(255,255,255,.96);border:1.5px solid #7FA8C4;text-align:center;line-height:1.05;
  box-shadow:0 3px 10px rgba(40,80,125,.18)}
.fxlabel b{display:block;font-size:20px}
.fxlabel i{display:block;font-style:normal;font-size:11px;margin-top:2px;color:#6E88A0}
/* 克制走小字本身换色，不换伤害数字：WEAK 红、RESIST 蓝 */
.fxlabel i.weak{color:#D9485C}
.fxlabel i.resist{color:#2E7FD4}
/* 掩体格挡走构造物那个中性灰，跟血条同一把尺子 —— 它不是克制关系，别混进红蓝那一档 */
.fxlabel i.block{color:#67748A;font-weight:700}
.fxlabel.miss.blocked{border-color:#67748A;color:#4C5A6E}
/* 伤害只用一个颜色 —— 克制与暴击各有自己的表达位（WEAK/RESIST 文字、爆裂外框），
   再拿颜色重复编码一遍只会让人以为那是第三种东西 */
.fxlabel.dmg,.fxlabel.crit{color:#C0342C}
.fxlabel.dmg{border-color:#E0574F}
.fxlabel.miss{border-color:#9BB0C2;color:#5D7488}
.fxlabel.heal{border-color:#37B87C;color:#1A8A55}
/* 持续伤害：橙色，跟普通伤害的红分开 —— 它是没有来源连线的那一类 */
.fxlabel.dot{border-color:#E9854F;color:#C2571B}
.fxlabel.dot::before{content:"";position:absolute;left:-5px;top:50%;transform:translateY(-50%);
  width:3px;height:60%;border-radius:2px;background:#E9854F}
.fxlabel .segs{display:flex;gap:1.5px;margin-top:4px;justify-content:center}
.fxlabel .segs s{flex:1;max-width:9px;height:3.5px;border-radius:2px;background:rgba(40,80,125,.22)}
.fxlabel .segs s.on{background:currentColor}
/* 12 段起改印数字（见 segsHtml）。跟短横占同一条基线、同一个色，别做成第二个数字 */
.fxlabel .segn{display:block;margin-top:2px;font-size:11px;line-height:1.1;font-weight:700;
  letter-spacing:.02em;opacity:.78;text-decoration:none;font-variant-numeric:tabular-nums}

/* 暴击：数字不放大、不加字，只把外框换成炸开的形状。尖刺会吃掉四周，留白比矩形框大一圈。
   margin 是给尖刺让位的 —— .burst 的 19px 负 inset 不占布局，同一目标连吃几发时
   相邻的爆裂框会咬在一起糊成一条 */
.fxlabel.crit{background:none;border:none;box-shadow:none;min-width:70px;padding:10px 16px 11px;margin:16px 15px}
.fxlabel.crit>b,.fxlabel.crit>i,.fxlabel.crit>.segs,.fxlabel.crit>.segn{position:relative}
/* 轮廓由行内 --burst 下发（按暴击段占比缩放）；::after 是 .burst 的伪元素，自动继承到 */
.fxlabel .burst{position:absolute;inset:-19px -22px;
  clip-path:var(--burst,polygon(${burstPolygon(1)}));background:linear-gradient(155deg,#FFC53D,#F26D2B);
  filter:drop-shadow(0 3px 8px rgba(190,90,20,.38))}
.fxlabel .burst::after{content:"";position:absolute;inset:4px;
  clip-path:var(--burst,polygon(${burstPolygon(1)}));background:linear-gradient(180deg,#FFFDF4,#FFEFD6)}
/* :not(.on) 不能省 —— 与上面 .fxlabel .segs s.on 同特异度，写在后面会把亮段一起盖掉 */
.fxlabel.crit .segs s:not(.on){background:rgba(194,51,26,.22)}

/* 底部：只有 EX 卡和 Cost 条 */
.hud{position:absolute;left:0;right:0;bottom:0;height:${HUD_HEIGHT}px;padding:26px 40px 20px;
  background:linear-gradient(180deg,#FFFFFF,#EFF5FB);border-top:3px solid;
  box-shadow:0 -6px 18px rgba(40,80,125,.1)}
.hud.red{border-color:#D9485C}
.hud.blue{border-color:#2E7FD4}
.excards{display:flex;flex-direction:column;gap:40px;align-items:center}
.exrow{display:flex;gap:26px;justify-content:center}
/* 下排是支援：缩小一圈，主力才是站在场上的那批，卡面大小顺带编码了这件事 */
.exrow.sup .excard{width:152px;height:125px}
.exrow.sup .excard .cost{width:34px;height:34px;top:-7px;left:15px;font-size:20px}
.exrow.sup .excard .nm{bottom:-22px;font-size:13px}
/* 等边平行四边形（与原作技能卡一致）：上下边长 = 斜边长，即 W − d = √(H² + d²)
   取 H=170、d=34 → W=207，四边均为 173，偏移比 d/W = 16.43% */
.excard{--pg:polygon(16.43% 0,100% 0,83.57% 100%,0 100%);position:relative;width:207px;height:170px}
.excard .frame{position:absolute;inset:0;clip-path:var(--pg);background:rgba(108,145,182,.55)}
.excard.ready .frame{background:var(--ac);filter:drop-shadow(0 4px 12px rgba(40,80,125,.28))}
/* 底色就是攻击属性色：头像是抠好的透明 PNG，脸周围露出来的就是属性色 */
.excard .face{position:absolute;inset:3px;clip-path:var(--pg);overflow:hidden;background:var(--ac)}
.excard .face img{width:100%;height:100%;object-fit:cover}
.excard .face .ph{width:100%;height:100%;display:flex;align-items:center;justify-content:center;
  font-size:56px;color:rgba(255,255,255,.8)}
/* 遮罩一：冷却 —— 整张压灰盖平，表示「现在轮不到你」，不写还差几个 */
.excard.cd .face{filter:grayscale(1) brightness(.9)}
.excard .block{position:absolute;inset:0;background:rgba(24,44,66,.5)}
/* 遮罩二：Cost 没攒够 —— 扇形扫过去，扫掉多少就是攒了多少 */
.excard .sweep{position:absolute;inset:0;
  background:conic-gradient(from 0deg,transparent 0 var(--p),rgba(18,36,58,.6) var(--p) 100%)}
.excard .cost{position:absolute;top:-9px;left:22px;width:44px;height:44px;border-radius:50%;
  background:#fff;border:2.5px solid rgba(70,120,175,.4);color:#5B7590;
  font-size:22px;line-height:39px;text-align:center}
.excard.ready .cost{border-color:var(--ac);color:var(--ink);box-shadow:0 3px 10px rgba(40,80,125,.22)}
/* 打过折的费用换成绿圈：数字本身已经是折后价，不额外写「原价 5」——
   一个信息一个通道，圈的颜色说明「这个数字比平时低」就够了 */
.excard .cost.cut{border-color:#37B87C;color:#1A8A55;background:#EDFBF4}
/* 不标号位：同队禁止重名，名字本身就唯一，指令写 ex 星野 即可 */
.excard .nm{position:absolute;left:0;right:0;bottom:-26px;text-align:center;font-size:15px;color:#41586E}
.excard.empty{display:flex;align-items:center;justify-content:center;color:#8397AC;font-size:14px;
  border:1px dashed rgba(70,120,175,.4);border-radius:12px}
.cells{display:flex;gap:7px;margin-top:42px}
.cells s{flex:1;height:26px;border-radius:5px;background:rgba(40,80,125,.12);
  transform:skewX(-14deg);overflow:hidden}
.cells s i{display:block;height:100%;background:linear-gradient(180deg,#8FD3FF,#2E86D8)}
`
}

/**
 * 场地技画在生效范围的脚边：一片普通蓝的立体圈。
 *
 * 正圆贴在脸上太大，也读不出「躺在地上」。压扁成透视椭圆（约 3.4:1），
 * 外圈 + 内圈 + 靠中线一侧加粗，才像地面上的范围指示。
 * 位置读 `side.fields`，人死了圈不缩、不换人。
 * 老对局里没有 `fields`，才退回从身上的 Zone 反推。
 */
function fieldsOf(side) {
  if (side.fields?.length) return side.fields
  const inZone = (side.units || []).filter((u) => (u.dots || []).some((d) => d.icon === "Zone"))
  if (!inZone.length) return []
  return [{
    lo: Math.min(...inZone.map((u) => u.idx)),
    hi: Math.max(...inZone.map((u) => u.idx)),
    turns: Math.max(...inZone.flatMap((u) => u.dots.filter((d) => d.icon === "Zone").map((d) => d.turns))),
  }]
}

function zoneLayer(state) {
  const laneW = ARENA_W / 4
  const rings = []
  for (const side of [0, 1]) {
    for (const f of fieldsOf(state.sides[side])) {
      const cx = ((f.lo + f.hi + 1) / 2) * laneW
      const lanes = f.hi - f.lo + 1
      const rx = Math.max(92, lanes * laneW * 0.40)
      const ry = Math.max(40, rx * 0.29)
      // 红方脚在 unit 底；蓝方脚贴 arena 底，圆心往中线收，避免下沿被裁
      const cy = side === 1
        ? RED_Y + LINE_SHIFT.前 + 36
        : BLUE_Y - LINE_SHIFT.前 - 36
      const ty = cy + (side === 1 ? 10 : -10)
      const left = (cx - rx).toFixed(1)
      const right = (cx + rx).toFixed(1)
      const sweep = side === 1 ? 0 : 1
      rings.push(`<g class="${f.turns <= 1 ? "fading" : ""}">
        <ellipse class="pad" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}"/>
        <ellipse class="ring" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}"/>
        <ellipse class="inner" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${(rx - 12).toFixed(1)}" ry="${(ry - 7).toFixed(1)}"/>
        <path class="near" d="M${left},${cy.toFixed(1)} A${rx.toFixed(1)} ${ry.toFixed(1)} 0 0 ${sweep} ${right},${cy.toFixed(1)}"/>
        <text x="${cx.toFixed(1)}" y="${ty.toFixed(1)}">${f.turns}</text>
      </g>`)
    }
  }
  if (!rings.length) return ""
  return `<svg class="zones" viewBox="0 0 ${ARENA_W} ${ARENA_H}">
    <defs>
      <radialGradient id="zoneFill" cx="50%" cy="42%" r="62%">
        <stop offset="0%" stop-color="rgba(46,127,212,.28)"/>
        <stop offset="68%" stop-color="rgba(46,127,212,.14)"/>
        <stop offset="100%" stop-color="rgba(46,127,212,.04)"/>
      </radialGradient>
    </defs>
    ${rings.join("")}
  </svg>`
}

/**
 * 抛出型召唤物画在敌方半场、对方前排再往前一个身位。
 * 列＝挡住的号位。归属仍是召唤者那一边（sides[caster]），只是人站在对面。
 */
function summonBand(state, fx) {
  const cells = []
  for (const side of [0, 1]) {
    for (const sm of state.sides[side].summons || []) {
      if (!sm.alive) continue
      const t = tmplOf(sm)
      const pct = Math.max(0, Math.min(100, (sm.hp / sm.maxhp) * 100))
      // 掩体是**永久**的（`turns == null`）：不画橙色时间条，它的存续就是血条本身。
      // 不判的话 null / null 会算出 NaN，条子直接不见
      const dur = sm.turns == null
        ? null
        : Math.max(0, Math.min(100, (sm.turns / (sm.turnsMax || sm.turns || 6)) * 100))
      const art = summonArtOf(sm.id)
      // 伤害数字往哪一侧甩，看它站在哪半场 —— 布置型（掩体）在自己这边，抛出型（人偶）在对面
      const half = sm.onAlly ? sm.side : 1 - sm.side
      const dy = summonStandY(sm) - ARENA_H / 2
      cells.push(`<div class="sm foe-${half === 1 ? "red" : "blue"}" style="grid-column:${sm.idx + 1};transform:translateY(${dy}px)">
        <div class="smart">
          ${art ? `<img src="${art}" alt="">` : ""}
        </div>
        <div class="hpbar smhp"><div class="hp" style="width:${pct}%;background:${ARMOR[t.defType] || "#8AA"}"></div>${SEGS}</div>
        ${dur == null ? "" : `<div class="smdur"><s style="width:${dur.toFixed(1)}%"></s></div>`}
        <b>${esc(t.name)}</b>
        ${fx.get(`${side}:${sm.idx}:s`) || ""}
      </div>`)
    }
  }
  return cells.length ? `<div class="smRow">${cells.join("")}</div>` : ""
}

/**
 * 支援带：自己半场角色后方的两个 Q 版，分散居中、和场上角色一样大。
 *
 * **不画血条** —— 支援打不到，血量维度对玩家没有意义，画了反而像是能被集火。
 * 只出「普通技能就绪」那一个黄底预警（跟主力头上同一个图标），因为那是唯一
 * 会改变下一回合结果、而玩家又看不到别处的信息。
 *
 * 连线沿用主力那一套（直线 + 箭头 + 三种笔触），锚点在 arrowLayer 的 `supportY`。
 */
function supportBand(state, side) {
  const list = state.sides[side].supports || []
  if (!list.length) return ""
  const cells = list.map((u) => {
    const t = tmplOf(u)
    // 缺 chibi 的人退回头像（小玉的 Q 版是手工补的，见 fetch-art.mjs 的 MANUAL_ART）
    const art = artOf(t.id, "chibi") || artOf(t.id, "icon")
    const tr = t.skill?.trigger?.type
    const ready = u.skillCd <= 0 && (tr === "cooldown" || tr === "on_auto" || tr === "on_kill")
    return `
    <div class="unit sup">
      <div class="bars">${ready ? `<div class="marks"><i class="mk warn">${ICON.warn}</i></div>` : ""}</div>
      <div class="art">
        ${art ? `<img src="${art}" alt="">` : `<div class="ph" style="background:${ATTACK[t.atkType]}">${esc(t.name[0])}</div>`}
        <div class="shadow"></div>
      </div>
      <b class="supnm">${esc(t.name)}</b>
    </div>`
  }).join("")
  return `<div class="supRow ${side === 1 ? "red" : "blue"}">${cells}</div>`
}

// ---------------- 主入口 ----------------

export function buildBattleHtml(state, events = []) {
  const fx = fxByUnit(events)
  const row = (side) => state.sides[side].units
    .map((u) => unitCell(state, side, u, fx.get(`${side}:${u.idx}`))).join("")
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><style>${css()}</style></head><body>
<div id="map">
  ${header(state)}
  <div class="arena">
    ${zoneLayer(state)}
    ${supportBand(state, 1)}
    <div class="laneRow red">${row(1)}</div>
    <div class="engage"></div>
    ${summonBand(state, fx)}
    <div class="laneRow blue">${row(0)}</div>
    ${supportBand(state, 0)}
    ${arrowLayer(state, events)}
  </div>
  ${hud(state)}
</div>
</body></html>`
}
