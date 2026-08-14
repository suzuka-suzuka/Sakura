/**
 * 指令解析 —— 原则：手机单手能打完
 *
 *   配队（私聊）  14 5 9 1        或  震荡 穿甲 秘仪 炎火
 *   出招（群内）  过
 *                ex 1            1 号位放 EX，目标走默认规则
 *                ex 1>3          1 号位 EX 打敌方 3 号位
 *                ex 1>友3        目标是己方 3 号位（治疗/护盾类）
 *                ex 1>3 4        按技能牌窗口顺序连续释放
 */

import { findUnit } from "./roster.js"

/**
 * 解析配队。
 * @returns {{ok:true, picks:string[]}|{ok:false, error:string}}
 */
export function parseDraft(text) {
  const tokens = String(text).trim().split(/[\s,，、/]+/).filter(Boolean)
  if (tokens.length !== 4) {
    return { ok: false, error: `要正好 4 个角色，你给了 ${tokens.length} 个` }
  }
  const picks = []
  for (const tk of tokens) {
    const t = findUnit(tk)
    if (!t) return { ok: false, error: `找不到角色「${tk}」，用编号或角色名都行` }
    if (picks.includes(t.id)) return { ok: false, error: `${t.name} 重复了，四个位置要选不同角色` }
    picks.push(t.id)
  }
  return { ok: true, picks }
}

const PASS_RE = /^(过|pass|p)$/i
const EX_RE = /^(?:ex|EX|技|大)\s*(.+)$/

/**
 * 解析出招指令。
 * @returns {{ok:true, action:object}|{ok:false, error:string}|null} null 表示这不是出招指令
 */
export function parseAction(text) {
  const s = String(text).trim()
  if (PASS_RE.test(s)) return { ok: true, action: { type: "pass" } }

  const m = s.match(EX_RE)
  if (!m) return null

  const specs = m[1].trim().split(/[\s,，、]+/).filter(Boolean)
  if (!specs.length) return { ok: false, error: "要指定放哪个位置的 EX，例：ex 1" }

  const casts = []
  for (const spec of specs) {
    // <pos>[>[友|敌]<idx>]
    const mm = spec.match(/^([1-4])(?:\s*[>＞:：]\s*(友|己|敌)?\s*([1-4]))?$/)
    if (!mm) {
      return { ok: false, error: `看不懂「${spec}」，格式是 ex 1 或 ex 1>3（打敌方3号位）` }
    }
    const cast = { pos: Number(mm[1]) - 1 }
    if (mm[3]) {
      const ally = mm[2] === "友" || mm[2] === "己"
      cast.target = { scope: ally ? "ally" : "foe", idx: Number(mm[3]) - 1 }
    }
    casts.push(cast)
  }
  return { ok: true, action: { type: "ex", casts } }
}
