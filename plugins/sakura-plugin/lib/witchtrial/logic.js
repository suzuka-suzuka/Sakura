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
  EVIDENCE_VIA,
  FACT_EFFECT_STANCE,
  FACT_EFFECT_WHEN,
  SUPPORT_THRESHOLD,
  VERDICT,
  canPerformMethod,
  canPresentEvidenceOn,
  conclusionsOf,
  evidenceActivatesFactEffect,
  evidenceCanSupportConclusion,
  evidenceOf,
  listGirls,
  livingGirls,
  livingPlayers,
  propositionOf,
} from "./schema.js";
import {
  publicize,
  withdrawPublicEvidence,
} from "./SessionStore.js";

export { canPerformMethod };

// ===== 调查文本相关性 =====

const QUESTION_STOP_CHARS = new Set(
  "的了是在有和与及你我她他它谁什么怎么为何为什么吗呢啊呀吧着过都就还那这哪请说讲问事"
);

/**
 * 从玩家问题里提取足够稳定的关键词。
 * 中文没有空格，因此同时取连续汉字段的二字/三字片段；英文和数字按词取。
 */
function relevanceTokens(text) {
  const source = String(text || "").toLowerCase();
  const tokens = new Set(source.match(/[a-z0-9]{2,}/g) || []);
  const hanRuns = source.match(/\p{Script=Han}+/gu) || [];

  for (const run of hanRuns) {
    for (const size of [3, 2]) {
      for (let index = 0; index <= run.length - size; index++) {
        const token = run.slice(index, index + size);
        if ([...token].every((char) => QUESTION_STOP_CHARS.has(char))) continue;
        tokens.add(token);
      }
    }
  }
  return [...tokens];
}

/**
 * 询问不再只是装饰文本：问题与证言名称/描述的关键词越贴近，越优先拿到那条。
 * 完全没有命中时仍随机，避免玩家必须猜中 AI 原句才能取得任何证言。
 */
export function pickRelevantEvidence(pool, question, random = Math.random) {
  if (!Array.isArray(pool) || !pool.length) return null;
  const tokens = relevanceTokens(question);
  if (!tokens.length) return pool[Math.floor(random() * pool.length)];

  let bestScore = 0;
  let best = [];
  for (const evidence of pool) {
    const name = String(evidence?.name || "").toLowerCase();
    const description = String(evidence?.description || "").toLowerCase();
    const score = tokens.reduce((total, token) => {
      const nameHit = name.includes(token) ? token.length * 2 : 0;
      const descriptionHit = description.includes(token) ? token.length : 0;
      return total + nameHit + descriptionHit;
    }, 0);
    if (score > bestScore) {
      bestScore = score;
      best = [evidence];
    } else if (score === bestScore && score > 0) {
      best.push(evidence);
    }
  }

  const candidates = bestScore > 0 ? best : pool;
  return candidates[Math.floor(random() * candidates.length)];
}

/**
 * 给真人预留约一半可取得证据，并按人轮转分配。
 * NPC 凶手预定要毁掉的牌不进入保留池；真人凶手仍可临场湮灭这些线索。
 */
export function reserveInvestigationEvidence(
  session,
  caseFile = session.caseFile,
  random = Math.random
) {
  const players = livingPlayers(session);
  const leads = Object.fromEntries(players.map((girl) => [girl.id, []]));
  if (!players.length || !caseFile?.evidence?.length) return leads;

  const planned = new Set((caseFile.witchPlan || []).map((item) => item.evidenceId));
  for (const evidence of caseFile.evidence) evidence.reservedFor = "";

  const candidates = caseFile.evidence.filter(
    (item) => !item.fake && !planned.has(item.id)
  );
  for (let index = candidates.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [candidates[index], candidates[swap]] = [candidates[swap], candidates[index]];
  }

  const reserveCount = Math.min(
    candidates.length,
    Math.max(players.length, Math.ceil(candidates.length / 2))
  );
  for (let index = 0; index < reserveCount; index++) {
    const owner = players[index % players.length];
    const evidence = candidates[index];
    evidence.reservedFor = owner.id;
    leads[owner.id].push(evidence.id);
  }
  return leads;
}

/**
 * 本地掷定死者与凶手。真人概率是整章最终概率，因此要扣除极罕见自杀分支后换算。
 */
export function pickVictimAndCulprit(
  session,
  {
    playerCulpritChance = 0.5,
    suicideChance = 0.01,
    random = Math.random,
  } = {}
) {
  const living = Object.values(session.girls || {}).filter((girl) => girl.alive);
  const npcs = living.filter((girl) => girl.kind === "npc");
  const players = living.filter((girl) => girl.kind === "player");
  const choose = (list) => list[Math.floor(random() * list.length)];
  const selfChance = Math.max(0, Math.min(0.95, Number(suicideChance) || 0));
  const configuredPlayerChance = Math.max(
    0,
    Math.min(1, Number(playerCulpritChance) || 0)
  );

  if (!npcs.length) return null;
  const victim = choose(npcs);
  if (random() < selfChance) return { victim, culprit: victim };

  const rest = living.filter((girl) => girl.id !== victim.id);
  const playerPool = rest.filter((girl) => girl.kind === "player");
  const npcPool = rest.filter((girl) => girl.kind === "npc");
  const playerChanceGivenHomicide = Math.min(
    1,
    configuredPlayerChance / Math.max(0.05, 1 - selfChance)
  );

  let culprit;
  if (playerPool.length && (random() < playerChanceGivenHomicide || !npcPool.length)) {
    culprit = choose(playerPool);
  } else if (npcPool.length) {
    culprit = choose(npcPool);
  } else {
    culprit = choose(players.length ? players : npcs);
  }
  return { victim, culprit };
}

// ===== 结论判定 =====

/**
 * 取已经通过当庭行动建立到某个命题上的证据。
 */
export function linkedEvidence(
  caseFile,
  propId,
  evidenceLinks = [],
  stance = STANCE.SUPPORT
) {
  const linkedIds = new Set(
    evidenceLinks
      .filter(
        (item) =>
          item.propId === propId &&
          item.stance === stance
      )
      .map((item) => item.evidenceId)
  );

  return (caseFile?.evidence || []).filter((item) => {
    const relation =
      stance === STANCE.SUPPORT ? item.supports || [] : item.refutes || [];
    if (!relation.includes(propId)) return false;
    return linkedIds.has(item.id);
  });
}

/** 一条“证据—方向—命题”的论证是否已经建立 */
export function hasEvidenceLink(session, evidenceId, propId, stance) {
  return session.evidenceLinks.some(
    (item) =>
      item.evidenceId === evidenceId &&
      item.propId === propId &&
      item.stance === stance &&
      item.chapter === session.chapter
  );
}

/** 建立一条有效论证；相同关系只记录一次 */
export function addEvidenceLink(
  session,
  { evidenceId, propId, stance, byId = "", round = session.round + 1 }
) {
  const evidence = evidenceOf(session?.caseFile, evidenceId);
  const prop = propositionOf(session?.caseFile, propId);
  const relation =
    stance === STANCE.SUPPORT ? evidence?.supports || [] : evidence?.refutes || [];
  if (!evidence || !prop || !relation.includes(propId)) return false;
  if (hasEvidenceLink(session, evidenceId, propId, stance)) return false;

  session.evidenceLinks.push({
    evidenceId,
    propId,
    stance,
    byId,
    chapter: session.chapter,
    round,
  });
  return true;
}

function directPropositionArguments(caseFile, propId, evidenceLinks = []) {
  const supporters = linkedEvidence(
    caseFile,
    propId,
    evidenceLinks,
    STANCE.SUPPORT
  );
  const refuters = linkedEvidence(
    caseFile,
    propId,
    evidenceLinks,
    STANCE.REFUTE
  );
  return { supporters, refuters };
}

/** 当前已经由真实出牌激活的“事实状态 → 结论”关系 */
export function activeFactEffects(caseFile, evidenceLinks = []) {
  return (caseFile?.factEffects || [])
    .filter((effect) => {
      const fact = propositionOf(caseFile, effect.factPropId);
      if (!fact || fact.conclusion) return false;
      const { supporters, refuters } = directPropositionArguments(
        caseFile,
        fact.id,
        evidenceLinks
      );
      const established = supporters.length >= 1 && refuters.length === 0;
      const refuted = refuters.length > 0;
      return effect.when === FACT_EFFECT_WHEN.REFUTED
        ? refuted
        : established;
    })
    .map((effect) => ({
      ...effect,
      factText: propositionOf(caseFile, effect.factPropId)?.text || "",
    }));
}

/**
 * 某个命题在当前已建立论证下的状态
 * @param {object} caseFile 案件档案
 * @param {string} propId 命题 id
 * @param {object[]} evidenceLinks 已明确建立的证据关系
 */
export function propositionStatus(
  caseFile,
  propId,
  evidenceLinks = [],
  { includeIndirect = true } = {}
) {
  const { supporters, refuters } = directPropositionArguments(
    caseFile,
    propId,
    evidenceLinks
  );
  const prop = propositionOf(caseFile, propId);
  const threshold = prop?.conclusion ? SUPPORT_THRESHOLD[prop.conclusion.type] : 1;
  const indirect = prop?.conclusion && includeIndirect
    ? activeFactEffects(caseFile, evidenceLinks).filter(
        (effect) => effect.conclusionPropId === propId
      )
    : [];
  const indirectSupportEffects = indirect.filter(
    (effect) => effect.stance === FACT_EFFECT_STANCE.SUPPORT
  );
  const indirectRefuteEffects = indirect.filter(
    (effect) => effect.stance === FACT_EFFECT_STANCE.REFUTE
  );
  const supportCount = supporters.length + indirectSupportEffects.length;
  const refuted = refuters.length > 0 || indirectRefuteEffects.length > 0;
  const hasRequiredFactSupport =
    !prop?.conclusion || indirectSupportEffects.length > 0;

  return {
    propId,
    supports: supportCount,
    directSupports: supporters.length,
    indirectSupports: indirectSupportEffects.length,
    supportedBy: supporters.map((item) => item.id),
    indirectSupportedBy: indirectSupportEffects.map((item) => item.factPropId),
    indirectSupportEffects,
    threshold,
    refuted,
    refutedBy: refuters.map((item) => item.id),
    indirectRefutedBy: indirectRefuteEffects.map((item) => item.factPropId),
    indirectRefuteEffects,
    hasRequiredFactSupport,
    // 结论必须有至少一条已经激活的事实支持；直接堆证物不能绕过推理链。
    stands:
      supportCount >= threshold &&
      !refuted &&
      hasRequiredFactSupport,
  };
}

/** 运行中只让已经正式主张并开放的结论接收事实效果。 */
export function propositionStatusForSession(session, propId) {
  const prop = propositionOf(session?.caseFile, propId);
  return propositionStatus(
    session?.caseFile,
    propId,
    session?.evidenceLinks || [],
    {
      includeIndirect:
        !prop?.conclusion || canPresentEvidenceOn(session, propId),
    }
  );
}

/** 只返回当前已经开放结论上的事实效果，供公开记录与回合播报使用。 */
export function activeFactEffectsForSession(session) {
  return activeFactEffects(
    session?.caseFile,
    session?.evidenceLinks || []
  ).filter((effect) =>
    canPresentEvidenceOn(session, effect.conclusionPropId)
  );
}

/** 当前所有能站住的结论 */
export function standingConclusions(caseFile, evidenceLinks = []) {
  return conclusionsOf(caseFile)
    .map((item) => ({
      prop: item,
      status: propositionStatus(caseFile, item.id, evidenceLinks),
    }))
    .filter((item) => item.status.stands);
}

export function standingConclusionsForSession(session) {
  return conclusionsOf(session?.caseFile)
    .map((item) => ({
      prop: item,
      status: propositionStatusForSession(session, item.id),
    }))
    .filter((item) => item.status.stands);
}

/**
 * 真相是否已被证成
 * 真相是吸收态：一旦证成就没有任何证据能推翻它（那样的证据按定义不存在），
 * 所以这里返回 true 时可以直接跳过投票定案。
 */
export function isTruthEstablished(caseFile, evidenceLinks = []) {
  if (!caseFile?.truthId) return false;
  return propositionStatus(caseFile, caseFile.truthId, evidenceLinks).stands;
}

export function isTruthEstablishedForSession(session) {
  if (!session?.caseFile?.truthId) return false;
  return propositionStatusForSession(session, session.caseFile.truthId).stands;
}

/**
 * 可行结论集合的大小
 * 随着有效反驳被明确建立而单调收缩
 */
export function viableConclusionCount(caseFile, evidenceLinks = []) {
  return conclusionsOf(caseFile).filter(
    (item) => !propositionStatus(caseFile, item.id, evidenceLinks).refuted
  ).length;
}

// ===== 庭审动作判定 =====

export const PLAY_RESULT = {
  VALID: "valid",         // 打中了
  INVALID: "invalid",     // 打空，反噬
  UNKNOWN: "unknown",     // 证据或命题不存在
  NOT_OWNED: "not_owned", // 证据不在手上
  UNAVAILABLE: "unavailable", // 已被销毁，不能出牌
};

export const STANCE = {
  SUPPORT: "support",
  REFUTE: "refute",
};

/** 某人当前是否欠着上一轮的追问回应 */
export function hasPendingQuestion(session, girlId) {
  return (session.questions || []).some(
    (item) =>
      !item.answered &&
      item.toId === girlId &&
      item.round <= session.round
  );
}

/**
 * 出示一条证据，声明它支持或否定某个命题
 *
 * 两个方向都必须声明目标，也都可能打空。这是刻意的——
 * 玩家只看得见证物的名字和描述，看不见它在档案里的 supports/refutes，
 * 往哪打全靠从描述推。不用声明就能公开证据的话，出牌就没有风险了。
 *
 * 打空时自己会涨嫌疑，证物也仍会进入公共池，交给其他人继续判断。
 */
export function judgeEvidencePlay(
  caseFile,
  { evidenceId, propId, stance, pouch = [], destroyedIds = [] }
) {
  const evidence = evidenceOf(caseFile, evidenceId);
  const prop = propositionOf(caseFile, propId);
  if (!evidence || !prop) return { result: PLAY_RESULT.UNKNOWN, evidence, prop, stance };
  if (!pouch.includes(evidenceId)) return { result: PLAY_RESULT.NOT_OWNED, evidence, prop, stance };
  if (destroyedIds.includes(evidenceId)) {
    return { result: PLAY_RESULT.UNAVAILABLE, evidence, prop, stance };
  }

  const hit =
    stance === STANCE.SUPPORT
      ? evidence.supports.includes(propId)
      : evidence.refutes.includes(propId);

  return {
    result: hit ? PLAY_RESULT.VALID : PLAY_RESULT.INVALID,
    evidence,
    prop,
    stance,
  };
}

/**
 * 找出当前确实能发动的预制伪证方案。
 * 破绽必须尚未公开、未被销毁，并且确实握在另一位在场者手中。
 */
function isHeldByOtherLiving(session, actor, evidenceId) {
  const otherLiving = new Set(
    livingGirls(session)
      .filter((girl) => girl.id !== actor.id)
      .map((girl) => girl.id)
  );
  return Object.entries(session.pouch || {}).some(
    ([girlId, bag]) =>
      otherLiving.has(girlId) &&
      Array.isArray(bag) &&
      bag.includes(evidenceId)
  );
}

export function availableForgeryPlans(session, actor, propId) {
  const caseFile = session.caseFile;
  const prop = propositionOf(caseFile, propId);
  if (
    session.fakeUsed ||
    !actor?.alive ||
    actor.id !== caseFile.culpritId ||
    !prop?.conclusion ||
    session.round >= session.trialRounds - 1
  ) {
    return [];
  }

  return caseFile.forgeryPlans.filter((plan) => {
    if (plan.targetPropId !== prop.id) return false;
    const flaw = evidenceOf(caseFile, plan.flawEvidenceId);
    return Boolean(
      flaw &&
      !flaw.fake &&
      evidenceCanSupportConclusion(caseFile, flaw, prop.id) &&
      !(session.publicEvidence || []).includes(flaw.id) &&
      !(session.destroyedEvidence || []).includes(flaw.id) &&
      isHeldByOtherLiving(session, actor, flaw.id)
    );
  });
}

/** 从可用方案中选一套，并把选择冻结进待结算行动。 */
export function selectForgeryPlan(
  session,
  actor,
  propId,
  random = Math.random
) {
  const candidates = availableForgeryPlans(session, actor, propId);
  if (!candidates.length) return null;
  return candidates[Math.floor(random() * candidates.length)] || null;
}

/**
 * 启用一条可反制的预制伪证。
 * 玩家不能自由编造文本；公开证物只使用案件生成时已校验过的普通名称与描述。
 */
export function plantFakeEvidence(session, actor, action) {
  const caseFile = session.caseFile;
  const prop = propositionOf(caseFile, action.propId);
  const plan = caseFile.forgeryPlans.find(
    (item) =>
      item.id === action.forgeryPlanId &&
      item.targetPropId === action.propId
  );
  const flaw = plan ? evidenceOf(caseFile, plan.flawEvidenceId) : null;
  if (
    session.fakeUsed ||
    !actor?.alive ||
    actor.id !== caseFile.culpritId ||
    !prop?.conclusion ||
    !plan ||
    !flaw ||
    flaw.fake ||
    !evidenceCanSupportConclusion(caseFile, flaw, prop.id) ||
    (session.publicEvidence || []).includes(flaw.id) ||
    (session.destroyedEvidence || []).includes(flaw.id) ||
    !isHeldByOtherLiving(session, actor, flaw.id) ||
    session.round >= session.trialRounds - 1
  ) {
    return { ok: false, reason: "invalid" };
  }

  session.fakeUsed = true;
  const idBase = `court_${session.chapter}_${session.round + 1}`;
  let evidenceId = idBase;
  let suffix = 2;
  while (evidenceOf(caseFile, evidenceId)) {
    evidenceId = `${idBase}_${suffix}`;
    suffix += 1;
  }
  const fake = {
    id: evidenceId,
    name: plan.name,
    description: plan.description,
    via: EVIDENCE_VIA.SEARCH,
    location: "",
    askTarget: "",
    supports: [],
    refutes: [prop.id],
    fake: true,
    flawOf: flaw.id,
    forgedById: actor.id,
    forgeryPlanId: plan.id,
    exposureText: plan.exposureText,
    reservedFor: "",
    createdRound: session.round + 1,
    challengeUntilRound: session.round + 2,
  };
  caseFile.evidence.push(fake);
  publicize(session, fake.id);
  addEvidenceLink(session, {
    evidenceId: fake.id,
    propId: prop.id,
    stance: STANCE.REFUTE,
    byId: actor.id,
    round: session.round + 1,
  });
  return { ...fake, ok: true };
}

// ===== 嫌疑值 =====

/**
 * 嫌疑值的行为惩罚项
 *
 * 秘密不在这里。它不参与嫌疑值计算——秘密是处刑前才翻出来的东西，
 * 用来给那个人的下场配重，不是庭上的筹码。
 */
export const PENALTY = {
  BACKFIRE: 8,      // 反噬：出牌打空
  CLAIM_BROKEN: 10, // 自己押的命题被推翻
  DODGE: 12,        // 回避追问
  FAKE_EXPOSED: 25, // 伪证被反揭穿
};

const PER_SUPPORT = 12;

/**
 * 重算全场嫌疑值
 *
 * 嫌疑值 = 结构性嫌疑（从当前证据算出，每回合刷新）+ 行为惩罚（累积）
 * 结构性部分每次重算，所以嫌疑值永远反映当下的证据状态，不会因为
 * 早期的误导而永久跑偏。
 *
 * **能力符合手法不加分。** 做得到不等于做了——「她有把刀」不能让她变成嫌疑人，
 * 只能让她没被排除。能力的作用是让玩家从尸体与证物划出可能名单，名单之内谁的
 * 嫌疑高，完全由证据和行为决定。全员从 0 起算。
 */
export function recomputeSuspicion(session) {
  const caseFile = session.caseFile;
  if (!caseFile) return;

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

    const propId = accuseProp.get(girl.id);
    if (propId) {
      // 一条有效反证已经把整项指认打倒，结构性嫌疑就应归零；
      // 不能让“两条支持 - 一条反证”还残留 9 点，仿佛被否定的指控仍有一半成立。
      const status = propositionStatusForSession(session, propId);
      if (!status.refuted) {
        score += status.supports * PER_SUPPORT;
      }
    }

    girl.suspicion = Math.max(0, score + (girl.penalty || 0));
  }
}

export function addPenalty(girl, amount) {
  if (!girl) return;
  girl.penalty = (girl.penalty || 0) + amount;
}

/**
 * 指定一件可疑公共证物，再用手中另一件证物检验它。
 * 无论成败，作为破绽提交的证物都会公开；命中处罚伪造者，猜错处罚挑战者。
 */
export function resolveFakeChallenge(
  session,
  actor,
  suspectEvidenceId,
  flawEvidenceId,
  currentRound = session.round + 1
) {
  const caseFile = session.caseFile;
  const suspect = evidenceOf(caseFile, suspectEvidenceId);
  const flaw = evidenceOf(caseFile, flawEvidenceId);
  const bag = session.pouch?.[actor.id] || [];
  if (
    !suspect ||
    !flaw ||
    suspect.id === flaw.id ||
    !(session.publicEvidence || []).includes(suspect.id) ||
    !bag.includes(suspect.id) ||
    !bag.includes(flaw.id) ||
    (session.destroyedEvidence || []).includes(suspect.id) ||
    (session.destroyedEvidence || []).includes(flaw.id)
  ) {
    return null;
  }

  const fake =
    suspect.fake &&
    suspect.flawOf === flaw.id &&
    (!Number.isFinite(suspect.challengeUntilRound) ||
      currentRound <= suspect.challengeUntilRound)
      ? suspect
      : null;
  publicize(session, flaw.id);

  let faker = null;
  if (fake) {
    faker = session.girls?.[fake.forgedById] || null;
    caseFile.evidence = caseFile.evidence.filter((item) => item.id !== fake.id);
    withdrawPublicEvidence(session, fake.id);
    session.evidenceLinks = session.evidenceLinks.filter(
      (item) => item.evidenceId !== fake.id
    );
    addPenalty(faker, PENALTY.FAKE_EXPOSED);
  } else {
    addPenalty(actor, PENALTY.BACKFIRE);
  }

  return {
    suspect,
    flaw,
    fake: fake || null,
    faker,
    success: Boolean(fake),
  };
}

/**
 * 当前嫌疑值最高的在场者
 *
 * 平手时优先取「能力做得到本案手法」的那个——能力不加分，但在别的都一样时
 * 它是唯一还能用的依据。再平手就按名字排，保证结果可复现。
 */
export function mostSuspected(session, { exclude = [] } = {}) {
  const excluded = new Set(exclude);
  const pool = livingGirls(session).filter((girl) => !excluded.has(girl.id));
  if (!pool.length) return null;

  const caseFile = session.caseFile;
  return pool.sort((a, b) => {
    if (b.suspicion !== a.suspicion) return b.suspicion - a.suspicion;
    const ca = canPerformMethod(a, caseFile) ? 1 : 0;
    const cb = canPerformMethod(b, caseFile) ? 1 : 0;
    if (ca !== cb) return cb - ca;
    return a.name.localeCompare(b.name, "zh");
  })[0];
}

// ===== 投票与判决 =====

export const VERDICT_SOURCE = {
  TRUTH: "truth",       // 真相被证成，直接定案
  VOTE: "vote",         // 投票通过且结论成立
  TIMEOUT: "timeout",   // 无结论达标，处刑嫌疑最高者
  COLLAPSE: "collapse", // 审判彻底失败：没有结论，也没有任何人被查出一点嫌疑
};

/**
 * NPC 怎么投票
 *
 * 本地决定，不问 AI。凶手 NPC 会推一个不指向自己的结论，其余 NPC
 * 投当前证据支持最多、且能站住的那个。
 */
export function npcVotes(session) {
  const caseFile = session.caseFile;
  const standing = standingConclusionsForSession(session);

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
 *
 * 平票不需要打破——采纳一个结论要求**绝对多数**，而平票在数学上够不着：
 * 两个选项各 c 票，若 c ≥ ⌊n/2⌋+1 则 2c > n，与 2c ≤ n 矛盾。
 * 所以平票必然落到超时，由嫌疑最高者顶罪。这里只是把「平了」这件事
 * 显式标出来，好让宣判时能告诉玩家法庭是分裂的，而不是没人投票。
 *
 * @returns {{tally, total, top, topCount, tied, tiedIds}}
 */
export function tallyVotes(votes) {
  const tally = {};
  let total = 0;
  for (const propId of Object.values(votes || {})) {
    if (!propId) continue;
    tally[propId] = (tally[propId] || 0) + 1;
    total += 1;
  }

  const entries = Object.entries(tally);
  const topCount = entries.reduce((max, [, count]) => Math.max(max, count), 0);
  const tiedIds = entries.filter(([, count]) => count === topCount).map(([propId]) => propId);
  // 并列时取 id 字典序最靠前的当代表，纯粹为了结果可复现；它拿不到多数，
  // 所以这个选择不会影响判决，只影响播报里先列谁
  tiedIds.sort((a, b) => a.localeCompare(b));

  return {
    tally,
    total,
    top: tiedIds[0] || "",
    topCount,
    tied: tiedIds.length > 1,
    tiedIds,
  };
}

/**
 * 最终判决
 *
 * 三条出路：
 *   指认某人  → 该人被处刑，其余全活
 *   自杀      → 全员存活
 *   超时未决  → 处刑当前嫌疑值最高者
 *
 * @param {object} session
 * @param {Record<string,string>} votes 全体在场者的票：girlId -> propId
 */
export function decideVerdict(session, votes) {
  const caseFile = session.caseFile;
  const living = livingGirls(session);
  const voterById = new Map(living.map((girl) => [girl.id, girl]));
  const conclusionIds = new Set(conclusionsOf(caseFile).map((item) => item.id));
  const eligibleVotes = Object.fromEntries(
    Object.entries(votes || {}).filter(
      ([girlId, propId]) => voterById.has(girlId) && (!propId || conclusionIds.has(propId))
    )
  );
  const humanVotes = Object.fromEntries(
    Object.entries(eligibleVotes).filter(
      ([girlId]) => voterById.get(girlId)?.kind === "player"
    )
  );
  const humanCount = living.filter((girl) => girl.kind === "player").length;

  // 真相已证成：吸收态，直接定案，不走投票
  if (isTruthEstablishedForSession(session)) {
    const truth = propositionOf(caseFile, caseFile.truthId);
    return buildVerdict(session, {
      source: VERDICT_SOURCE.TRUTH,
      prop: truth,
      votes: eligibleVotes,
      tally: tallyVotes(eligibleVotes),
      playerTally: tallyVotes(humanVotes),
    });
  }

  const counted = tallyVotes(eligibleVotes);
  const playerCounted = tallyVotes(humanVotes);
  const playerMajority = Math.floor(humanCount / 2) + 1;

  // NPC 票用于叙事与展示，但不能替玩家作出最终选择。
  // 采纳结论必须先获得仍在场玩家的过半票。
  if (playerCounted.top && playerCounted.topCount >= playerMajority) {
    const status = propositionStatusForSession(session, playerCounted.top);
    if (status.stands) {
      return buildVerdict(session, {
        source: VERDICT_SOURCE.VOTE,
        prop: propositionOf(caseFile, playerCounted.top),
        votes: eligibleVotes,
        tally: counted,
        playerTally: playerCounted,
      });
    }
  }

  // 没有结论，而且一整场审判下来没有任何人被查出一点嫌疑——
  // 这不是「选不出来」，是根本没查。猫头鹰不会容忍这种局面。
  const nothingFound = livingGirls(session).every((girl) => girl.suspicion === 0);
  return buildVerdict(session, {
    source: nothingFound ? VERDICT_SOURCE.COLLAPSE : VERDICT_SOURCE.TIMEOUT,
    prop: null,
    votes: eligibleVotes,
    tally: counted,
    playerTally: playerCounted,
  });
}

function buildVerdict(session, { source, prop, votes, tally, playerTally }) {
  const caseFile = session.caseFile;

  let executedIds = [];
  if (source === VERDICT_SOURCE.COLLAPSE) {
    // 全员处刑。审判失败得彻底，所有人一起下去。
    executedIds = livingGirls(session).map((girl) => girl.id);
  } else if (source === VERDICT_SOURCE.TIMEOUT) {
    const target = mostSuspected(session);
    if (target) executedIds = [target.id];
  } else if (prop?.conclusion?.type === VERDICT.ACCUSE) {
    executedIds = [prop.conclusion.targetId];
  }
  // 自杀结论不处刑任何人。

  const collapsed = source === VERDICT_SOURCE.COLLAPSE;

  return {
    source,
    collapsed,
    conclusionId: prop?.id || "",
    conclusionText: prop?.text || "",
    conclusionType: prop?.conclusion?.type || "",
    executedIds,
    executedId: executedIds[0] || "",
    // 播报要区分「法庭分裂成两半」和「压根没人投票」，这两种都会掉进超时
    tied: Boolean(tally.tied),
    tiedIds: tally.tiedIds || [],
    voteTotal: tally.total,
    playerVoteTotal: playerTally?.total || 0,
    playerTally: playerTally?.tally || {},
    // 判对了没有：处刑的是真凶，或结论就是真相。
    // 全员处刑不算判对——真凶确实死了，但那是连坐，不是查出来的。
    correct: collapsed ? false : prop ? prop.id === caseFile.truthId : executedIds.includes(caseFile.culpritId),
    culpritEscaped: collapsed ? false : !executedIds.includes(caseFile.culpritId),
    votes,
    tally: tally.tally,
    truthId: caseFile.truthId,
  };
}

// ===== NPC 的自主行动 =====
//
// NPC 必须和玩家做一样的事，否则行为模式本身就暴露了身份：
// 只有玩家会搜证、只有玩家会出示证据、只有玩家会因为回避追问挨罚——
// 玩家观察两轮就能把 NPC 全挑出来，「不知道谁是玩家」也就无从谈起。
// 这些决策全部本地完成，不问 AI。

const pouchIds = (session, girlId) => session.pouch?.[girlId] || [];

function pickRandom(list) {
  return list.length ? list[Math.floor(Math.random() * list.length)] : null;
}

/** NPC 出牌看走眼的概率 */
const NPC_MISFIRE_CHANCE = 0.18;

/**
 * 包一次 NPC 的出牌
 *
 * NPC 手里握着档案里真实的 supports/refutes，玩家却只能从证物描述里推——
 * 要是 NPC 永远打不空，「从不反噬的那个」立刻又成了身份标签。
 * 所以让它按一定概率也看走眼一次。
 */
function npcPlay(
  caseFile,
  npc,
  evidence,
  propId,
  stance,
  playablePropIds = null
) {
  let target = propId;
  if (Math.random() < NPC_MISFIRE_CHANCE) {
    const wrong = pickRandom(
      (caseFile.propositions || []).filter(
        (item) =>
          item.id !== propId &&
          (!playablePropIds || playablePropIds.has(item.id))
      )
    );
    if (wrong) target = wrong.id;
  }
  return { girlId: npc.id, kind: "play", evidenceId: evidence.id, propId: target, stance };
}

/** 指认某人的那条结论 */
function accusationAgainst(caseFile, girlId) {
  return (
    conclusionsOf(caseFile).find(
      (item) => item.conclusion.type === VERDICT.ACCUSE && item.conclusion.targetId === girlId
    ) || null
  );
}

/**
 * 一件证物可以通过哪些有效出牌路线影响候选结论。
 *
 * 直接路线把证物打向结论；间接路线先把证物打向事实。NPC 只拿这些
 * 路线做策略选择，真正能否命中仍由与玩家相同的 judgeEvidencePlay 判定。
 */
function evidenceConclusionRoutes(session, evidence) {
  const caseFile = session.caseFile;
  const routes = [];

  for (const conclusion of conclusionsOf(caseFile)) {
    for (const stance of [STANCE.SUPPORT, STANCE.REFUTE]) {
      const relation =
        stance === STANCE.SUPPORT
          ? evidence.supports || []
          : evidence.refutes || [];
      if (
        relation.includes(conclusion.id) &&
        !hasEvidenceLink(session, evidence.id, conclusion.id, stance)
      ) {
        routes.push({
          conclusionId: conclusion.id,
          conclusionStance: stance,
          propId: conclusion.id,
          stance,
        });
      }
    }
  }

  for (const effect of caseFile.factEffects || []) {
    if (!evidenceActivatesFactEffect(evidence, effect)) continue;
    const stance =
      effect.when === FACT_EFFECT_WHEN.REFUTED
        ? STANCE.REFUTE
        : STANCE.SUPPORT;
    if (hasEvidenceLink(session, evidence.id, effect.factPropId, stance)) {
      continue;
    }

    // 已触发的事实不会因为再堆一件同向证物而重复贡献。
    const factStatus = propositionStatus(
      caseFile,
      effect.factPropId,
      session.evidenceLinks,
      { includeIndirect: false }
    );
    const alreadyActive =
      effect.when === FACT_EFFECT_WHEN.REFUTED
        ? factStatus.refuted
        : factStatus.stands;
    if (alreadyActive) continue;

    routes.push({
      conclusionId: effect.conclusionPropId,
      conclusionStance: effect.stance,
      propId: effect.factPropId,
      stance,
    });
  }

  const seen = new Set();
  return routes.filter((route) => {
    const key = [
      route.conclusionId,
      route.conclusionStance,
      route.propId,
      route.stance,
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * NPC 的调查阶段行动
 * 凶手 NPC 优先执行开局排好的销毁计划，其余人搜查或询问。
 */
export function npcInvestigateActions(session, round) {
  const caseFile = session.caseFile;
  const locations = session.prison?.locations || [];
  const actions = [];
  const held = new Set(Object.values(session.pouch || {}).flat());

  for (const npc of livingGirls(session)) {
    if (npc.kind !== "npc") continue;

    // 凶手按开局定死的排程销毁证据，不临场发挥
    if (npc.id === caseFile.culpritId) {
      const plan = (caseFile.witchPlan || []).find((item) => item.round === round);
      const target = plan ? evidenceOf(caseFile, plan.evidenceId) : null;
      if (
        target &&
        target.via === EVIDENCE_VIA.SEARCH &&
        !session.destroyedEvidence.includes(target.id) &&
        !session.publicEvidence.includes(target.id) &&
        !held.has(target.id)
      ) {
        actions.push({
          girlId: npc.id,
          kind: "destroy",
          evidenceId: target.id,
          locationId: target.location,
        });
        continue;
      }
    }

    // 三成概率去问人，其余搜地方——问出来的证言也是牌
    if (Math.random() < 0.3) {
      const targets = livingGirls(session).filter((girl) => girl.id !== npc.id);
      const fruitfulTargets = targets.filter((target) =>
        (caseFile.evidence || []).some(
          (item) =>
            item.via === EVIDENCE_VIA.ASK &&
            item.askTarget === target.id &&
            !item.fake &&
            !item.reservedFor &&
            !session.destroyedEvidence.includes(item.id) &&
            !held.has(item.id)
        )
      );
      const target = pickRandom(fruitfulTargets.length ? fruitfulTargets : targets);
      if (target) {
        actions.push({
          girlId: npc.id,
          kind: "ask",
          targetId: target.id,
          question: "案发那晚的事",
        });
        continue;
      }
    }

    // 优先去还有自己没拿到的证据的地方，没有就随便走走
    const fruitful = locations.filter((location) =>
      (caseFile.evidence || []).some(
        (item) =>
          item.via === EVIDENCE_VIA.SEARCH &&
          item.location === location.id &&
          !item.fake &&
          !item.reservedFor &&
          !session.destroyedEvidence.includes(item.id) &&
          !held.has(item.id)
      )
    );
    const location = pickRandom(fruitful.length ? fruitful : locations);
    if (location) {
      actions.push({ girlId: npc.id, kind: "search", locationId: location.id });
    }
  }

  return actions;
}

/**
 * NPC 的庭审行动
 *
 * 优先级：自保 → 进攻 → 施压。凶手 NPC 不会主动建立指向自己的支持论证。
 */
export function npcTrialMoves(session, { focusPropIds = [] } = {}) {
  const caseFile = session.caseFile;
  const publicIds = session.publicEvidence || [];
  const refuted = new Set(session.refutedProps || []);
  const focus = [
    ...new Set(
      focusPropIds.filter((propId) => propositionOf(caseFile, propId))
    ),
  ];
  const playablePropIds = new Set(
    (caseFile.propositions || [])
      .filter(
        (prop) =>
          !prop.conclusion ||
          canPresentEvidenceOn(session, prop.id) ||
          focus.includes(prop.id)
      )
      .map((prop) => prop.id)
  );
  const moves = [];
  let fakeChallengeClaimed = false;
  const actionRound = session.round + 1;

  // 上一轮被追问、这一轮该回话的 NPC
  const owed = new Set(
    (session.questions || [])
      .filter((item) => !item.answered && item.round <= session.round)
      .map((item) => item.toId)
  );

  for (const npc of livingGirls(session)) {
    if (npc.kind !== "npc") continue;

    const bag = pouchIds(session, npc.id)
      .map((id) => evidenceOf(caseFile, id))
      .filter(
        (item) =>
          item &&
          !(session.destroyedEvidence || []).includes(item.id)
      );
    const isCulprit = npc.id === caseFile.culpritId;
    const accuseMe = accusationAgainst(caseFile, npc.id);

    // 0. 欠着一次表态。心虚的多半躲，坦荡的答——凶手躲的概率高得多。
    //    表态要押一个**结论**，所以 NPC 也得从结论里挑一个不指向自己的
    if (owed.has(npc.id)) {
      const dodgeChance = isCulprit ? 0.45 : 0.15;
      const shelter =
        standingConclusionsForSession(session).find(
          (item) => item.prop.id !== accuseMe?.id
        )?.prop ||
        pickRandom(
          conclusionsOf(caseFile).filter(
            (item) => item.id !== accuseMe?.id && !refuted.has(item.id)
          )
        );

      if (Math.random() < dodgeChance || !shelter) {
        moves.push({ girlId: npc.id, kind: "dodge" });
      } else {
        moves.push({
          girlId: npc.id,
          kind: "answer",
          propId: shelter.id,
          text: "那时候我一个人待着，没人看见——我知道这话没用。",
        });
      }
      continue;
    }

    // 1. 自保：有人在指认我，而我手里正好有能否定它的牌
    if (
      accuseMe &&
      playablePropIds.has(accuseMe.id) &&
      !refuted.has(accuseMe.id)
    ) {
      const status = propositionStatusForSession(session, accuseMe.id);
      if (status.supports > 0) {
        const option = bag
          .flatMap((evidence) =>
            evidenceConclusionRoutes(session, evidence).map((route) => ({
              evidence,
              route,
            }))
          )
          .find(
            ({ route }) =>
              route.conclusionId === accuseMe.id &&
              route.conclusionStance === STANCE.REFUTE &&
              playablePropIds.has(route.propId)
          );
        if (option) {
          moves.push(
            npcPlay(
              caseFile,
              npc,
              option.evidence,
              option.route.propId,
              option.route.stance,
              playablePropIds
            )
          );
          continue;
        }
      }
    }

    // 2. 揭穿伪证：破绽在我手里时，只有下一轮这一次反制窗口。
    if (!fakeChallengeClaimed) {
      const fake = (caseFile.evidence || []).find(
        (item) =>
          item.fake &&
          publicIds.includes(item.id) &&
          item.flawOf &&
          (!Number.isFinite(item.challengeUntilRound) ||
            actionRound <= item.challengeUntilRound) &&
          bag.some((evidence) => evidence.id === item.flawOf)
      );
      if (fake) {
        fakeChallengeClaimed = true;
        moves.push({
          girlId: npc.id,
          kind: "challenge",
          suspectEvidenceId: fake.id,
          flawEvidenceId: fake.flawOf,
        });
        continue;
      }
    }

    // 3. 回应焦点：真人本轮正式主张后，NPC 优先翻自己手里的相关牌。
    //    这让“主张”成为能驱动台面信息的动作，而不是只有押错惩罚的空按钮。
    const focused = bag
      .flatMap((evidence) =>
        evidenceConclusionRoutes(session, evidence).map((route) => ({
          evidence,
          route,
        }))
      )
      .find(
        ({ route }) =>
          focus.includes(route.conclusionId) &&
          playablePropIds.has(route.propId) &&
          !(
            accuseMe &&
            route.conclusionId === accuseMe.id &&
            route.conclusionStance === STANCE.SUPPORT
          )
      );
    if (focused) {
      moves.push(
        npcPlay(
          caseFile,
          npc,
          focused.evidence,
          focused.route.propId,
          focused.route.stance,
          playablePropIds
        )
      );
      continue;
    }

    // 4. 进攻：打掉一个还站着的、不指向自己的命题
    const attack = bag
      .flatMap((evidence) =>
        evidenceConclusionRoutes(session, evidence).map((route) => ({
          evidence,
          route,
        }))
      )
      .find(
        ({ route }) =>
          route.conclusionStance === STANCE.REFUTE &&
          !refuted.has(route.conclusionId) &&
          route.conclusionId !== accuseMe?.id &&
          playablePropIds.has(route.propId) &&
          propositionStatusForSession(session, route.conclusionId).supports > 0
      );
    if (attack) {
      moves.push(
        npcPlay(
          caseFile,
          npc,
          attack.evidence,
          attack.route.propId,
          attack.route.stance,
          playablePropIds
        )
      );
      continue;
    }

    // 5. 摊牌：用一张证物去建立尚未出现、且不指认自己的支持论证。
    //    证物即使还关联别的命题，公开本身也不会让那些关系自动生效。
    const safe = bag
      .flatMap((evidence) =>
        evidenceConclusionRoutes(session, evidence).map((route) => ({
          evidence,
          route,
        }))
      )
      .find(
        ({ route }) =>
          route.conclusionStance === STANCE.SUPPORT &&
          route.conclusionId !== accuseMe?.id &&
          playablePropIds.has(route.propId)
      );
    if (safe) {
      moves.push(
        npcPlay(
          caseFile,
          npc,
          safe.evidence,
          safe.route.propId,
          safe.route.stance,
          playablePropIds
        )
      );
      continue;
    }

    // 6. 施压：追问嫌疑最高的另一个人
    const target = mostSuspected(session, { exclude: [npc.id] });
    if (target && Math.random() < 0.6) {
      moves.push({
        girlId: npc.id,
        kind: "question",
        targetId: target.id,
        topic: "案发那晚你在哪",
      });
      continue;
    }

    // 7. 主张一个已经出现推理基础、且不指向自己的结论。
    //    未开题结论尚不能“站住”，但 NPC 仍应能主动把它开出来。
    const pushable = conclusionsOf(caseFile)
      .map((prop) => ({
        prop,
        status: propositionStatus(caseFile, prop.id, session.evidenceLinks),
      }))
      .filter(
        (item) =>
          item.prop.id !== accuseMe?.id &&
          !item.status.refuted &&
          item.status.supports > 0
      )
      .sort(
        (a, b) =>
          Number(b.status.stands) - Number(a.status.stands) ||
          b.status.supports - a.status.supports
      );
    if (pushable.length) {
      moves.push({ girlId: npc.id, kind: "claim", propId: pushable[0].prop.id });
    }
  }

  return moves;
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

  // 越是能直接或经由事实支持「指认凶手」、又能否定其他结论的证物越致命。
  const deadly = (caseFile.evidence || [])
    .filter(
      (item) =>
        item.via === EVIDENCE_VIA.SEARCH &&
        evidenceCanSupportConclusion(caseFile, item, accuseProp.id)
    )
    .sort((a, b) => b.refutes.length - a.refutes.length);

  const truth = propositionOf(caseFile, caseFile.truthId);
  const truthThreshold = SUPPORT_THRESHOLD[truth?.conclusion?.type] || 2;
  const potentialTruthSupport = (destroyedIds) => {
    const available = (caseFile.evidence || []).filter(
      (item) => !destroyedIds.has(item.id)
    );
    const direct = available.filter((item) =>
      (item.supports || []).includes(caseFile.truthId)
    ).length;
    const indirect = (caseFile.factEffects || []).filter(
      (effect) =>
        effect.conclusionPropId === caseFile.truthId &&
        effect.stance === FACT_EFFECT_STANCE.SUPPORT &&
        available.some((item) => evidenceActivatesFactEffect(item, effect))
    ).length;
    return { total: direct + indirect, indirect };
  };

  const plan = [];
  const destroyedIds = new Set();
  for (const item of deadly) {
    if (plan.length >= rounds) break;
    const nextDestroyed = new Set([...destroyedIds, item.id]);
    const remaining = potentialTruthSupport(nextDestroyed);
    if (
      remaining.total < truthThreshold ||
      remaining.indirect < 1
    ) {
      continue;
    }

    destroyedIds.add(item.id);
    plan.push({ round: plan.length + 1, action: "destroy", evidenceId: item.id });
  }
  return plan;
}
