/**
 * 纯逻辑判定层
 *
 * 这个文件里没有一行调用 AI。结论成不成立、反驳有没有效、嫌疑值多少、
 * 谁被处刑——全部是对案件档案的集合运算。AI 只负责把这里算出来的结果
 * 写成庭审对白，一点判定权都没有。
 *
 * 推理部分因此是确定性的，连骰子都不需要。骰子只留给调查阶段的搜查。
 */

import {
  SUPPORT_THRESHOLD,
  VERDICT,
  conclusionsOf,
  evidenceOf,
  listGirls,
  livingGirls,
  propositionOf,
} from "./schema.js";

// ===== 结论判定 =====

/**
 * 某个命题在当前已公开证据下的状态
 * @param {object} caseFile 案件档案
 * @param {string} propId 命题 id
 * @param {string[]} publicIds 已公开证据 id（集合 P）
 */
export function propositionStatus(caseFile, propId, publicIds = []) {
  const shown = new Set(publicIds);
  const evidence = (caseFile?.evidence || []).filter((item) => shown.has(item.id));

  const supporters = evidence.filter((item) => item.supports.includes(propId));
  const refuters = evidence.filter((item) => item.refutes.includes(propId));

  const prop = propositionOf(caseFile, propId);
  const threshold = prop?.conclusion ? SUPPORT_THRESHOLD[prop.conclusion.type] : 1;

  return {
    propId,
    supports: supporters.length,
    threshold,
    refuted: refuters.length > 0,
    refutedBy: refuters.map((item) => item.id),
    // 成立 = 支持够门槛 且 无矛盾
    stands: supporters.length >= threshold && refuters.length === 0,
  };
}

/** 当前所有能站住的结论 */
export function standingConclusions(caseFile, publicIds = []) {
  return conclusionsOf(caseFile)
    .map((item) => ({ prop: item, status: propositionStatus(caseFile, item.id, publicIds) }))
    .filter((item) => item.status.stands);
}

/**
 * 真相是否已被证成
 * 真相是吸收态：一旦证成就没有任何证据能推翻它（那样的证据按定义不存在），
 * 所以这里返回 true 时可以直接跳过投票定案。
 */
export function isTruthEstablished(caseFile, publicIds = []) {
  if (!caseFile?.truthId) return false;
  return propositionStatus(caseFile, caseFile.truthId, publicIds).stands;
}

/**
 * 可行结论集合的大小
 * 随着证据公开单调收缩——凶手的全部工作就是阻止这个收缩
 */
export function viableConclusionCount(caseFile, publicIds = []) {
  const shown = new Set(publicIds);
  return conclusionsOf(caseFile).filter(
    (item) =>
      !(caseFile.evidence || []).some(
        (e) => shown.has(e.id) && e.refutes.includes(item.id)
      )
  ).length;
}

// ===== 庭审动作判定 =====

export const REFUTE_RESULT = {
  VALID: "valid",       // 有效反驳，命题倒台
  INVALID: "invalid",   // 无效，反噬
  UNKNOWN: "unknown",   // 证据或命题不存在
  NOT_OWNED: "not_owned", // 证据不在手上
};

/**
 * 出示证据反驳某个命题
 *
 * 无效反驳不只是没打中——证据照样被公开出去了。乱扔牌的代价是双重的：
 * 自己涨嫌疑，还白白把一张牌摊在桌面上。
 */
export function judgeRefutation(caseFile, { evidenceId, propId, pouch = [] }) {
  const evidence = evidenceOf(caseFile, evidenceId);
  const prop = propositionOf(caseFile, propId);
  if (!evidence || !prop) return { result: REFUTE_RESULT.UNKNOWN, evidence, prop };
  if (!pouch.includes(evidenceId)) return { result: REFUTE_RESULT.NOT_OWNED, evidence, prop };

  // 伪证：如果对方手里有那条破绽证据，反揭穿的判定在别处；这里只看命中与否
  const hit = evidence.refutes.includes(propId);
  return {
    result: hit ? REFUTE_RESULT.VALID : REFUTE_RESULT.INVALID,
    evidence,
    prop,
  };
}

/**
 * 伪证是否被反揭穿
 * 每条伪证带一个破绽字段，指向某条真证据。对方手里有那条就能反揭穿。
 */
export function isFakeExposed(caseFile, fakeEvidenceId, publicIds = []) {
  const fake = evidenceOf(caseFile, fakeEvidenceId);
  if (!fake?.fake || !fake.flawOf) return false;
  return publicIds.includes(fake.flawOf);
}

// ===== 嫌疑值 =====

/** 嫌疑值的行为惩罚项 */
export const PENALTY = {
  BACKFIRE: 8,        // 反噬：反驳无效
  CLAIM_BROKEN: 10,   // 自己的主张被推翻
  DODGE: 12,          // 回避追问
  SECRET_EXPOSED: 15, // 秘密被曝光
  FAKE_EXPOSED: 25,   // 伪证被反揭穿
};

const ABILITY_MATCH_BASE = 25;
const PER_SUPPORT = 12;
const PER_REFUTE = 15;

/** 这位少女的能力能不能做到本案的手法 */
export function canPerformMethod(girl, caseFile) {
  const required = caseFile?.method?.requiredAbilities || [];
  if (!required.length) return true; // 手法没要求特殊能力，人人都做得到

  const owned = [girl?.ability?.name, ...(girl?.ability?.can || [])].filter(Boolean);
  return required.every((need) =>
    owned.some((have) => have.includes(need) || need.includes(have))
  );
}

/**
 * 重算全场嫌疑值
 *
 * 嫌疑值 = 结构性嫌疑（从当前证据算出，每回合刷新）+ 行为惩罚（累积）
 * 结构性部分每次重算，所以嫌疑值永远反映当下的证据状态，不会因为
 * 早期的误导而永久跑偏。
 *
 * 「能力符合手法」这一项只在手法公开之后才计入——调查阶段玩家还不知道
 * 死因是什么，这时候就按能力给分等于开局直接点名真凶。手法由猫头鹰在
 * 开庭时连同尸检一起公布，所以这一项从庭审阶段起生效。
 */
export function recomputeSuspicion(session) {
  const caseFile = session.caseFile;
  if (!caseFile) return;

  const methodKnown = session.phase === "trial" || session.phase === "voting";

  const publicIds = session.publicEvidence || [];
  const shown = new Set(publicIds);
  const evidence = (caseFile.evidence || []).filter((item) => shown.has(item.id));

  // 指认每个人的结论，预先索引好
  const accuseProp = new Map();
  for (const item of conclusionsOf(caseFile)) {
    if (item.conclusion.type === VERDICT.ACCUSE) {
      accuseProp.set(item.conclusion.targetId, item.id);
    }
  }

  for (const girl of listGirls(session)) {
    if (!girl.alive) {
      girl.suspicion = 0;
      continue;
    }

    let score = 0;

    // 能力符合手法 → 底值。这就是「只能漂浮十厘米的少女在脚印案里成为嫌疑人」
    if (methodKnown && canPerformMethod(girl, caseFile)) score += ABILITY_MATCH_BASE;

    const propId = accuseProp.get(girl.id);
    if (propId) {
      score += evidence.filter((item) => item.supports.includes(propId)).length * PER_SUPPORT;
      score -= evidence.filter((item) => item.refutes.includes(propId)).length * PER_REFUTE;
    }

    if (girl.secretExposed) score += PENALTY.SECRET_EXPOSED;

    girl.suspicion = Math.max(0, score + (girl.penalty || 0));
  }
}

export function addPenalty(girl, amount) {
  if (!girl) return;
  girl.penalty = (girl.penalty || 0) + amount;
}

/** 当前嫌疑值最高的在场者，平手取名字靠前的，保证可复现 */
export function mostSuspected(session, { exclude = [] } = {}) {
  const excluded = new Set(exclude);
  const pool = livingGirls(session).filter((girl) => !excluded.has(girl.id));
  if (!pool.length) return null;

  return pool.sort((a, b) => {
    if (b.suspicion !== a.suspicion) return b.suspicion - a.suspicion;
    return a.name.localeCompare(b.name, "zh");
  })[0];
}

// ===== 投票与判决 =====

export const VERDICT_SOURCE = {
  TRUTH: "truth",       // 真相被证成，直接定案
  VOTE: "vote",         // 投票通过且结论成立
  TIMEOUT: "timeout",   // 无结论达标，处刑嫌疑最高者
};

/**
 * NPC 怎么投票
 *
 * 本地决定，不问 AI。凶手 NPC 会推一个不指向自己的结论，其余 NPC
 * 投当前证据支持最多、且能站住的那个。
 */
export function npcVotes(session) {
  const caseFile = session.caseFile;
  const publicIds = session.publicEvidence || [];
  const standing = standingConclusions(caseFile, publicIds);

  const votes = {};
  for (const girl of livingGirls(session)) {
    if (girl.kind !== "npc") continue;

    const isCulprit = girl.id === caseFile.culpritId;
    const safe = standing.filter(
      (item) =>
        !(item.prop.conclusion.type === VERDICT.ACCUSE && item.prop.conclusion.targetId === girl.id)
    );

    if (safe.length) {
      // 支持数最高的那个；凶手同样从「不指向自己」里挑，天然构成误导
      const best = safe.sort((a, b) => b.status.supports - a.status.supports)[0];
      votes[girl.id] = best.prop.id;
      continue;
    }

    // 没有能站住的结论时弃权；凶手也乐得没人达标（超时对他不一定坏）
    if (!isCulprit) votes[girl.id] = "";
    else votes[girl.id] = "";
  }
  return votes;
}

/**
 * 统计票数
 * @returns {{tally: Record<string, number>, total: number, top: string, topCount: number}}
 */
export function tallyVotes(votes) {
  const tally = {};
  let total = 0;
  for (const propId of Object.values(votes || {})) {
    if (!propId) continue;
    tally[propId] = (tally[propId] || 0) + 1;
    total += 1;
  }

  let top = "";
  let topCount = 0;
  for (const [propId, count] of Object.entries(tally).sort((a, b) => a[0].localeCompare(b[0]))) {
    if (count > topCount) {
      top = propId;
      topCount = count;
    }
  }
  return { tally, total, top, topCount };
}

/**
 * 最终判决
 *
 * 三条出路：
 *   指认某人  → 该人被处刑，其余全活
 *   自杀/意外 → 全员存活（但凶手也活着，下一章照样死人）
 *   超时未决  → 处刑当前嫌疑值最高者
 *
 * @param {object} session
 * @param {Record<string,string>} votes 全体在场者的票：girlId -> propId
 */
export function decideVerdict(session, votes) {
  const caseFile = session.caseFile;
  const publicIds = session.publicEvidence || [];
  const voterCount = livingGirls(session).length;

  // 真相已证成：吸收态，直接定案，不走投票
  if (isTruthEstablished(caseFile, publicIds)) {
    const truth = propositionOf(caseFile, caseFile.truthId);
    return buildVerdict(session, {
      source: VERDICT_SOURCE.TRUTH,
      prop: truth,
      votes,
      tally: tallyVotes(votes),
    });
  }

  const counted = tallyVotes(votes);
  const majority = Math.floor(voterCount / 2) + 1;

  if (counted.top && counted.topCount >= majority) {
    const status = propositionStatus(caseFile, counted.top, publicIds);
    if (status.stands) {
      return buildVerdict(session, {
        source: VERDICT_SOURCE.VOTE,
        prop: propositionOf(caseFile, counted.top),
        votes,
        tally: counted,
      });
    }
  }

  // 无结论达标 → 超时处刑
  return buildVerdict(session, {
    source: VERDICT_SOURCE.TIMEOUT,
    prop: null,
    votes,
    tally: counted,
  });
}

function buildVerdict(session, { source, prop, votes, tally }) {
  const caseFile = session.caseFile;

  let executedId = "";
  if (source === VERDICT_SOURCE.TIMEOUT) {
    executedId = mostSuspected(session)?.id || "";
  } else if (prop?.conclusion?.type === VERDICT.ACCUSE) {
    executedId = prop.conclusion.targetId;
  }
  // 自杀/意外结论不处刑任何人

  return {
    source,
    conclusionId: prop?.id || "",
    conclusionText: prop?.text || "",
    conclusionType: prop?.conclusion?.type || "",
    executedId,
    // 判对了没有：处刑的是真凶，或结论就是真相
    correct: prop ? prop.id === caseFile.truthId : executedId === caseFile.culpritId,
    culpritEscaped: executedId !== caseFile.culpritId,
    votes,
    tally: tally.tally,
    truthId: caseFile.truthId,
  };
}

// ===== NPC 凶手的行动排程 =====

/**
 * 为 NPC 凶手排好整个调查阶段的行动
 *
 * 必须在案件生成时一次性定死，绝不能让 AI 每回合即兴决定销毁什么——
 * 否则「本地判定权威」这条线就漏了。
 *
 * 策略：优先销毁「支持指认自己」且尚未被发现的证据，从最致命的开始。
 */
export function planWitchActions(caseFile, { rounds = 3 } = {}) {
  const culpritId = caseFile.culpritId;
  const accuseProp = conclusionsOf(caseFile).find(
    (item) => item.conclusion.type === VERDICT.ACCUSE && item.conclusion.targetId === culpritId
  );
  if (!accuseProp) return [];

  // 越是同时「支持指认凶手」又「否定其他结论」的证据越致命，优先毁掉
  const deadly = (caseFile.evidence || [])
    .filter((item) => item.supports.includes(accuseProp.id))
    .sort((a, b) => b.refutes.length - a.refutes.length);

  // 每回合最多毁一条，且留一手：不把支持真相的证据毁绝，否则案子无解
  const truthSupport = (caseFile.evidence || []).filter((item) =>
    item.supports.includes(caseFile.truthId)
  );
  const keepAtLeast = Math.max(
    SUPPORT_THRESHOLD[propositionOf(caseFile, caseFile.truthId)?.conclusion?.type] || 2,
    2
  );

  const plan = [];
  let destroyedTruthSupport = 0;
  for (const item of deadly) {
    if (plan.length >= rounds) break;
    const isTruthSupport = truthSupport.some((e) => e.id === item.id);
    if (isTruthSupport && truthSupport.length - destroyedTruthSupport <= keepAtLeast) continue;
    if (isTruthSupport) destroyedTruthSupport += 1;

    plan.push({ round: plan.length + 1, action: "destroy", evidenceId: item.id });
  }
  return plan;
}
