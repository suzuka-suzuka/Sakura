/**
 * 指令解析 —— 原则：手机单手能打完
 *
 *   配队（私聊）  星野 白子 野宫 芹香     顺序即左起 1~4 号位（决定对位）
 *   出招（群内）  过
 *                星野ex          星野放 EX，目标走技能默认规则
 *                星野ex打白子     打敌方的白子
 *                星野ex给芹香     目标是己方的芹香（治疗 / 护盾 / 增益）
 *                星野ex打白子 芹香ex   空格分隔连放多个，按写的顺序结算
 *
 *   一律写角色名，不收编号 —— 同队禁止重名，名字足以唯一定位，也比数字好记。
 *   中间那个字（打/给）决定目标在敌方还是己方 —— 双方都可能选同一个角色，
 *   光凭名字分不出是哪一边的；不写就按技能自己的目标类型判定。
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
    if (!t) return { ok: false, error: `找不到角色「${tk}」，写角色名，例：星野 白子 野宫 芹香` }
    if (picks.includes(t.id)) return { ok: false, error: `${t.name} 重复了，四个位置要选不同角色` }
    picks.push(t.id)
  }
  return { ok: true, picks }
}

const PASS_RE = /^(过|pass|p)$/i
const EX_MARK = /ex|EX|Ex|技|大/
/** 中间那个字：打人还是帮人。写法可以随意，认的是意思 */
const FOE_VERB = "打攻揍轰砸捶秒锤"
const ALLY_VERB = "给帮为治奶助"
const CAST_RE = new RegExp(
  `^(.+?)(?:ex|EX|Ex|技|大)(?:\\s*([${FOE_VERB}${ALLY_VERB}])?\\s*(.+))?$`
)

/**
 * 解析出招指令。
 * @returns {{ok:true, action:object}|{ok:false, error:string}|null} null 表示这不是出招指令
 */
export function parseAction(text) {
  const s = String(text).trim()
  if (PASS_RE.test(s)) return { ok: true, action: { type: "pass" } }
  if (!EX_MARK.test(s)) return null

  const specs = splitCasts(s)
  if (!specs.length) return { ok: false, error: "要指定放哪个角色的 EX，例：星野ex" }

  const casts = []
  for (const [i, spec] of specs.entries()) {
    const mm = spec.match(CAST_RE)
    if (!mm) return { ok: false, error: `看不懂「${spec}」，格式是 星野ex 或 星野ex打白子` }
    const who = refOf(mm[1])
    // 第一段的施放者都认不出来，说明这压根不是出招指令（聊天里带个 ex 就被当指令很烦），
    // 返回 null 让上层放行；后面几段认不出才算写错了
    if (!who && i === 0) return null
    if (!who) return { ok: false, error: `找不到角色「${mm[1]}」，写角色名，例：星野ex打白子` }
    const cast = { ...who }
    if (mm[3]) {
      const tgt = refOf(mm[3])
      if (!tgt) return { ok: false, error: `找不到目标「${mm[3]}」，写角色名，例：星野ex打白子` }
      // 没写动词就留空，交给引擎按技能自己的目标类型判定
      const scope = mm[2] ? (ALLY_VERB.includes(mm[2]) ? "ally" : "foe") : null
      cast.target = { scope, ...(tgt.pos != null ? { idx: tgt.pos } : { id: tgt.id }) }
    }
    casts.push(cast)
  }
  return { ok: true, action: { type: "ex", casts } }
}

/**
 * 按空格切出每一次释放。
 *
 * 空格是「下一个人」的分隔符，但人总会顺手在里面也敲空格（「星野ex 打白子」），
 * 所以规则是：只有当当前这段已经含 ex 时，遇到新的 ex 才另起一段。
 */
function splitCasts(s) {
  const out = []
  let buf = ""
  for (const tk of s.split(/[\s,，、]+/).filter(Boolean)) {
    if (buf && EX_MARK.test(buf) && EX_MARK.test(tk)) { out.push(buf); buf = "" }
    buf += tk
  }
  if (buf) out.push(buf)
  return out
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
