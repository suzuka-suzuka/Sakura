/**
 * 指令解析 —— 原则：手机单手能打完
 *
 *   配队（私聊）  星野 白子 野宫 芹香     顺序即左起 1~4 号位（决定对位）
 *   出招（群内）  过
 *                星野ex          星野放 EX，目标由技能描述和战场位置自动决定
 *                过                结束本回合的 EX，结算技能和普攻
 *
 *   玩家只决定「谁放 EX」，不能点名目标；具体落点由技能自带索敌优先，
 *   没有特殊索敌时再按站位规则自动决定。
 */

import { findUnit } from "./roster.js"

/**
 * 解析配队。
 * @returns {{ok:true, picks:string[]}|{ok:false, error:string}}
 */
const DRAFT_EG = "星野 白子 野宫 芹香 静子 芹娜"

/**
 * 解析配队：**前 4 个是主力（顺序即左起 1~4 号位），后 2 个是支援**。
 *
 * 支援不站在场上、打不到，也不占号位 —— 它们只在普通技能阶段跟主力一起出手，外加自己的 EX。
 * 位置写错（把支援排在前四位）直接打回，不替玩家重排：号位决定对位和战场分割，
 * 猜错了整局的刀都落在别处。
 */
export function parseDraft(text) {
  const tokens = String(text).trim().split(/[\s,，、/]+/).filter(Boolean)
  if (tokens.length !== 6) {
    return { ok: false, error: `要正好 6 个角色（4 主力 + 2 支援），你给了 ${tokens.length} 个\n例：${DRAFT_EG}` }
  }
  const picks = []
  for (const [i, tk] of tokens.entries()) {
    const t = findUnit(tk)
    if (!t) return { ok: false, error: `找不到角色「${tk}」，写角色名，例：${DRAFT_EG}` }
    if (picks.includes(t.id)) return { ok: false, error: `${t.name} 重复了，六个位置要选不同角色` }
    const want = i < 4 ? "主力" : "支援"
    if ((t.squad || "主力") !== want) {
      return {
        ok: false,
        error: `${t.name}是${t.squad || "主力"}，不能放在第 ${i + 1} 位（前 4 位是主力，后 2 位是支援）\n例：${DRAFT_EG}`,
      }
    }
    picks.push(t.id)
  }
  return { ok: true, picks }
}

const PASS_RE = /^(过|pass|p)$/i
const EX_MARK = /ex|技|大/i

/**
 * 找到紧跟在一个已知角色名后的 EX 标记。
 * 不直接用非贪婪正则切，避免未来角色名自身带「大 / 技」时被从中间截断。
 */
function splitCast(s) {
  for (const m of s.matchAll(/ex|技|大/gi)) {
    const who = refOf(s.slice(0, m.index))
    if (who) return { who, tail: s.slice(m.index + m[0].length) }
  }
  return null
}

/**
 * 解析出招指令。
 * @returns {{ok:true, action:object}|{ok:false, error:string}|null} null 表示这不是出招指令
 */
export function parseAction(text) {
  const s = String(text).trim()
  if (PASS_RE.test(s)) return { ok: true, action: { type: "pass" } }
  if (!EX_MARK.test(s)) return null

  const spec = splitCast(s)
  // 施放者认不出来，说明这很可能只是带了 ex 的普通聊天，交给上层放行。
  if (!spec) {
    if (/^(?:ex|技|大)\s*$/i.test(s)) {
      return { ok: false, error: "要指定放哪个角色的 EX，例：星野ex" }
    }
    return null
  }
  if (spec.tail.trim()) {
    return { ok: false, error: "EX 不能指定目标，只需选择释放者，例：星野ex" }
  }
  return { ok: true, action: { type: "ex", casts: [spec.who] } }
}

/**
 * 一律按名字定位，不收号位数字。
 * 同队不允许重名（parseDraft 拦着），名字足以唯一确定是谁；
 * 战场图上也就不用标序号，指令还更好记。
 */
function refOf(token) {
  const t = findUnit(String(token).trim())
  return t ? { id: t.id } : null
}
