/**
 * 审判引擎：章节生命周期与两个阶段的回合结算
 *
 * 每个回合只调一次 AI，而且调用之前所有判定都已经算完了。
 * AI 拿到的是「谁做了什么、系统判成什么样」，它只负责写成故事。
 *
 * 调查阶段还留着一点随机（搜到哪条证据），庭审阶段是纯确定性的——
 * 证据能否定哪个命题是查表，不是掷骰。
 */

import { getAI } from "../AIUtils/getAI.js";
import { generateCase } from "./CaseGenerator.js";
import {
  PENALTY,
  PLAY_RESULT,
  STANCE,
  addPenalty,
  decideVerdict,
  isFakeExposed,
  isTruthEstablished,
  judgeEvidencePlay,
  npcInvestigateActions,
  npcTrialMoves,
  npcVotes,
  pickVictimAndCulprit,
  pickRelevantEvidence,
  plantFakeEvidence,
  propositionStatus,
  recomputeSuspicion,
  reserveInvestigationEvidence,
  resolveFakeChallenge,
  standingConclusions,
} from "./logic.js";
import {
  INVESTIGATE_SYSTEM,
  TRIAL_SYSTEM,
  buildInvestigatePrompt,
  buildTrialPrompt,
  buildVerdictPrompt,
} from "./prompts.js";
import {
  EVIDENCE_VIA,
  VERDICT,
  comparePrisonerCode,
  conclusionsOf,
  evidenceOf,
  girlOf,
  listGirls,
  livingGirls,
  livingPlayers,
  propositionOf,
  safeString,
} from "./schema.js";
import { PHASES, addToPouch, pouchOf, publicize } from "./SessionStore.js";

const MAX_SUMMARY_LINES = 12;
const RECENT_LOG_SIZE = 3;

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function locationName(session, locationId) {
  return session.prison?.locations.find((item) => item.id === locationId)?.name || "未知区域";
}

/** 代号只给玩家看，AI 的提示词里用名字就好，塞代号只会变成噪声 */
function locationCode(session, locationId) {
  return session.prison?.locations.find((item) => item.id === locationId)?.code || "";
}

/** 同一回合的公开行动按囚犯编号播报，不能保留「真人先、NPC 后」的提交拼接顺序。 */
function compareActorCode(session, a, b) {
  return comparePrisonerCode(
    girlOf(session, a?.actorId || a?.girlId),
    girlOf(session, b?.actorId || b?.girlId)
  );
}

async function narrate({ route, e, system, prompt }) {
  const result = await getAI(route, e, [{ text: prompt }], system, false, false, []);
  if (typeof result === "string") throw new Error(result);
  return result?.text || "";
}

// ===== 章节生命周期 =====

/**
 * 开一章：掷定死者与凶手，生成案件，重置本章状态
 * @returns {Promise<{victim: object, culprit: object}>}
 */
export async function startChapter({ e, route, session, onProgress, playerCulpritChance, suicideChance }) {
  const picked = pickVictimAndCulprit(session, { playerCulpritChance, suicideChance });
  if (!picked) throw new Error("NPC 少女已经不够了，开不了新的案件");
  const chapter = session.chapter + 1;

  const caseFile = await generateCase({
    e,
    route,
    session,
    victim: picked.victim,
    culprit: picked.culprit,
    chapter,
    onProgress,
  });

  // 生成成功后才正式消耗章节号；失败重试不会跳章
  session.chapter = chapter;
  // 死者退场
  picked.victim.alive = false;
  picked.victim.fate = "victim";

  session.caseFile = caseFile;
  session.phase = PHASES.INVESTIGATE;
  session.round = 0;
  session.pendingActions = {};
  session.publicEvidence = [];
  session.destroyedEvidence = [];
  session.refutedProps = [];
  session.claims = [];
  session.questions = [];
  session.votes = {};
  session.pouch = {};
  session.advancePending = false;
  session.fakeUsed = false;
  session.investigationLeads = reserveInvestigationEvidence(session, caseFile);

  // 行为惩罚每章清零，结构性嫌疑会重算
  for (const girl of listGirls(session)) girl.penalty = 0;
  recomputeSuspicion(session);

  return picked;
}

// ===== 调查阶段 =====

/** 某地点当前还能被这个人搜到的证据 */
function heldEvidenceIds(session) {
  return new Set(Object.values(session.pouch || {}).flat());
}

function searchablePool(session, actorId, locationId) {
  const held = heldEvidenceIds(session);
  const pool = (session.caseFile.evidence || []).filter(
    (item) =>
      item.via === EVIDENCE_VIA.SEARCH &&
      item.location === locationId &&
      !item.fake &&
      !session.destroyedEvidence.includes(item.id) &&
      !held.has(item.id) &&
      (!item.reservedFor || item.reservedFor === actorId)
  );
  const reserved = pool.filter((item) => item.reservedFor === actorId);
  return reserved.length ? reserved : pool;
}

function askablePool(session, actorId, targetId) {
  const held = heldEvidenceIds(session);
  const pool = (session.caseFile.evidence || []).filter(
    (item) =>
      item.via === EVIDENCE_VIA.ASK &&
      item.askTarget === targetId &&
      !item.fake &&
      !session.destroyedEvidence.includes(item.id) &&
      !held.has(item.id) &&
      (!item.reservedFor || item.reservedFor === actorId)
  );
  const reserved = pool.filter((item) => item.reservedFor === actorId);
  return reserved.length ? reserved : pool;
}

/**
 * 结算一个调查回合
 * @param {object[]} actions [{ girlId, kind, locationId, targetId, question }]
 */
export async function resolveInvestigateTurn({ e, route, session, actions: playerActions }) {
  const caseFile = session.caseFile;
  const results = [];

  // NPC 和玩家做一样的事。少了这一步，「谁在四处翻找」本身就是身份标签。
  const actions = [...playerActions, ...npcInvestigateActions(session, session.round + 1)];

  // 先把去向登记下来，撞见判定要用
  const byLocation = new Map();
  for (const action of actions) {
    if (action.kind !== "search" && action.kind !== "destroy") continue;
    const list = byLocation.get(action.locationId) || [];
    list.push(action.girlId);
    byLocation.set(action.locationId, list);
  }

  for (const action of actions) {
    const actor = girlOf(session, action.girlId);
    if (!actor?.alive) continue;

    if (action.kind === "search") {
      const pool = searchablePool(session, actor.id, action.locationId);
      const found = pool.length ? pick(pool) : null;
      if (found) addToPouch(session, actor.id, found.id);
      results.push({
        kind: "search",
        actorId: actor.id,
        actorName: actor.name,
        actorCode: actor.code,
        locationName: locationName(session, action.locationId),
        locationCode: locationCode(session, action.locationId),
        found: Boolean(found),
        evidenceName: found?.name || "",
        evidenceDesc: found?.description || "",
        relatedPropIds: found
          ? [...new Set([...(found.supports || []), ...(found.refutes || [])])]
          : [],
        // 私聊回执要报出编号，玩家才知道庭上该打第几号
        pouchIndex: found ? pouchOf(session, actor.id).indexOf(found.id) + 1 : 0,
      });
      continue;
    }

    if (action.kind === "ask") {
      const target = girlOf(session, action.targetId);
      const pool = askablePool(session, actor.id, action.targetId);
      const found = pickRelevantEvidence(pool, action.question);
      if (found) addToPouch(session, actor.id, found.id);
      // 证言跨章保留：这一章说的话，下一章还能翻出来对质
      session.testimony.push({
        chapter: session.chapter,
        byId: target?.id || action.targetId,
        name: target?.name || "某人",
        text: found ? found.description.slice(0, 120) : "（没说出什么有用的）",
      });
      results.push({
        kind: "ask",
        actorId: actor.id,
        actorName: actor.name,
        actorCode: actor.code,
        targetName: target?.name || "某人",
        targetCode: target?.code || "",
        question: action.question || "案发那晚的事",
        found: Boolean(found),
        evidenceName: found?.name || "",
        evidenceDesc: found?.description || "",
        relatedPropIds: found
          ? [...new Set([...(found.supports || []), ...(found.refutes || [])])]
          : [],
        pouchIndex: found ? pouchOf(session, actor.id).indexOf(found.id) + 1 : 0,
      });
      continue;
    }

    if (action.kind === "destroy") {
      const held = heldEvidenceIds(session);
      const pool = (caseFile.evidence || []).filter(
        (item) =>
          item.via === EVIDENCE_VIA.SEARCH &&
          item.location === action.locationId &&
          !item.fake &&
          !session.destroyedEvidence.includes(item.id) &&
          !session.publicEvidence.includes(item.id) &&
          !held.has(item.id) &&
          (!action.evidenceId || item.id === action.evidenceId)
      );
      const target = pool.length ? pick(pool) : null;
      if (target) session.destroyedEvidence.push(target.id);

      const others = (byLocation.get(action.locationId) || []).filter((id) => id !== actor.id);
      results.push({
        kind: "destroy",
        actorId: actor.id,
        actorName: actor.name,
        actorCode: actor.code,
        locationName: locationName(session, action.locationId),
        locationCode: locationCode(session, action.locationId),
        destroyed: Boolean(target),
        evidenceName: target?.name || "",
        evidenceDesc: target?.description || "",
        witnessed: others.length > 0,
        witnessNames: others.map((id) => girlOf(session, id)?.name || "某人"),
      });
    }
  }

  // 判定已经结束后再排序，不改变抢证据等规则，只清除公开播报里的身份顺序。
  results.sort((a, b) => compareActorCode(session, a, b));

  // 撞见：同地点两人以上
  const encounters = [];
  for (const [locationId, ids] of byLocation) {
    if (ids.length < 2) continue;
    const orderedIds = [...ids].sort((a, b) =>
      comparePrisonerCode(girlOf(session, a), girlOf(session, b))
    );
    encounters.push({
      locationName: locationName(session, locationId),
      locationCode: locationCode(session, locationId),
      names: orderedIds.map((id) => girlOf(session, id)?.name || "某人"),
      labels: orderedIds.map((id) => {
        const girl = girlOf(session, id);
        return girl ? `${girl.code} ${girl.name}` : "某人";
      }),
    });
  }
  encounters.sort((a, b) =>
    String(a.locationCode || "").localeCompare(String(b.locationCode || ""))
  );

  const prompt = buildInvestigatePrompt({
    prison: session.prison,
    caseFile,
    girls: session.girls,
    round: session.round + 1,
    maxRounds: session.investigateRounds,
    results,
    encounters,
    summaryLines: session.summaryLines,
    recentLog: session.recentLog,
  });

  const raw = await narrate({ route, e, system: INVESTIGATE_SYSTEM, prompt });
  const parsed = extractNarration(raw);

  session.round += 1;
  session.pendingActions = {};
  pushLog(session, parsed);
  recomputeSuspicion(session);

  return {
    narration: parsed.narration,
    results,
    encounters,
    phaseDone: session.round >= session.investigateRounds,
  };
}

// ===== 庭审阶段 =====

function syncRefutedProps(session) {
  const shown = new Set(session.publicEvidence || []);
  session.refutedProps = [
    ...new Set(
      (session.caseFile?.evidence || [])
        .filter((item) => shown.has(item.id))
        .flatMap((item) => item.refutes || [])
    ),
  ];
}

/** 只有真实公开证据会让押错结论永久吃 +10；伪证只暂时改变台面状态 */
function realRefutedProps(session) {
  const shown = new Set(session.publicEvidence || []);
  return new Set(
    (session.caseFile?.evidence || [])
      .filter((item) => !item.fake && shown.has(item.id))
      .flatMap((item) => item.refutes || [])
  );
}

function penalizeNewlyBrokenClaims(session, beforeRefuted) {
  const afterRefuted = realRefutedProps(session);
  for (const claim of session.claims || []) {
    if (
      claim.chapter !== session.chapter ||
      claim.broken ||
      beforeRefuted.has(claim.propId) ||
      !afterRefuted.has(claim.propId)
    ) {
      continue;
    }
    addPenalty(girlOf(session, claim.byId), PENALTY.CLAIM_BROKEN);
    claim.broken = true;
  }
}

function exposePublicFakes(session, moves, currentRound) {
  const caseFile = session.caseFile;
  const exposed = (caseFile.evidence || []).filter(
    (item) =>
      item.fake &&
      isFakeExposed(caseFile, item.id, session.publicEvidence, {
        round: currentRound,
      })
  );
  if (!exposed.length) return;

  const exposedIds = new Set(exposed.map((item) => item.id));
  caseFile.evidence = caseFile.evidence.filter((item) => !exposedIds.has(item.id));
  session.publicEvidence = session.publicEvidence.filter((id) => !exposedIds.has(id));

  for (const fake of exposed) {
    const actor = girlOf(session, fake.askTarget);
    addPenalty(actor, PENALTY.FAKE_EXPOSED);
    moves.push({
      kind: "fake_exposed",
      actorId: actor?.id || fake.askTarget,
      actorName: actor?.name || "某人",
      text: fake.description,
      evidenceName:
        evidenceOf(caseFile, fake.flawOf)?.name || "破绽证据",
    });
  }
  syncRefutedProps(session);
}

/**
 * 结算一个庭审回合
 * @param {object[]} actions [{ girlId, kind, propId, evidenceId, targetId, topic, text }]
 */
export async function resolveTrialTurn({ e, route, session, actions: playerActions }) {
  const caseFile = session.caseFile;
  const moves = [];
  syncRefutedProps(session);

  // NPC 也出手：主张、出示、反驳、追问、回避。它们的回避同样挨罚——
  // 否则「从来不用正面回答的那个」就是活体身份标签。
  const focusPropIds = playerActions
    .filter((item) => item.kind === "claim" || item.kind === "answer")
    .map((item) => item.propId);
  const actions = [
    ...playerActions,
    ...npcTrialMoves(session, { focusPropIds }),
  ];

  // 上一轮被追问却没回应的人，先记回避（NPC 的回避由 npcTrialMoves 自己决定，这里只管玩家）
  //
  // 注意只认**有效**的回应：押了非结论命题的会在下面被跳过，如果这里就把它
  // 算成已回应，等于交一条废指令就白嫖掉 12 点回避罚。
  const answered = new Set(
    actions
      .filter(
        (item) =>
          item.kind === "dodge" ||
          (item.kind === "answer" && propositionOf(caseFile, item.propId)?.conclusion)
      )
      .map((item) => item.girlId)
  );
  for (const question of session.questions) {
    if (question.answered || question.round > session.round) continue;
    const target = girlOf(session, question.toId);
    if (!target?.alive || target.kind !== "player") continue;
    if (answered.has(target.id)) continue;

    addPenalty(target, PENALTY.DODGE);
    question.answered = true;
    moves.push({ kind: "dodge", actorId: target.id, actorName: target.name });
  }

  for (const action of actions) {
    const actor = girlOf(session, action.girlId);
    if (!actor?.alive) continue;

    if (action.kind === "claim") {
      const prop = propositionOf(caseFile, action.propId);
      if (!prop) continue;
      const status = propositionStatus(caseFile, prop.id, session.publicEvidence);
      const reallyRefuted = realRefutedProps(session).has(prop.id);
      session.claims.push({
        byId: actor.id,
        propId: prop.id,
        chapter: session.chapter,
        round: session.round + 1,
        broken: reallyRefuted,
      });
      if (reallyRefuted) addPenalty(actor, PENALTY.CLAIM_BROKEN);
      moves.push({
        kind: "claim",
        actorId: actor.id,
        actorName: actor.name,
        propId: prop.id,
        propText: prop.text,
        stands: status.stands,
        supports: status.supports,
        threshold: status.threshold,
        refuted: status.refuted,
      });
      continue;
    }

    if (action.kind === "play") {
      const judged = judgeEvidencePlay(caseFile, {
        evidenceId: action.evidenceId,
        propId: action.propId,
        stance: action.stance,
        pouch: pouchOf(session, actor.id),
        publicIds: session.publicEvidence,
        destroyedIds: session.destroyedEvidence,
      });
      if (
        judged.result === PLAY_RESULT.UNKNOWN ||
        judged.result === PLAY_RESULT.NOT_OWNED ||
        judged.result === PLAY_RESULT.UNAVAILABLE
      ) {
        continue; // 指令层已经拦过，这里只是兜底
      }

      // 打空的代价是双重的：自己涨嫌疑，牌还白白摊上了桌面
      const beforeRefuted = realRefutedProps(session);
      publicize(session, judged.evidence.id);
      const valid = judged.result === PLAY_RESULT.VALID;
      syncRefutedProps(session);
      // 先撤下被这张真证据当场戳穿的伪证，再按最终台面状态处罚主张。
      // 否则一条本来正确的主张会先被伪证判破，再在同一动作里恢复，却白吃 +10。
      exposePublicFakes(session, moves, session.round + 1);
      penalizeNewlyBrokenClaims(session, beforeRefuted);

      if (!valid) {
        addPenalty(actor, PENALTY.BACKFIRE);
      }

      moves.push({
        kind: "play",
        stance: action.stance,
        actorId: actor.id,
        actorName: actor.name,
        evidenceName: judged.evidence.name,
        evidenceDesc: judged.evidence.description,
        propText: judged.prop.text,
        valid,
      });
      continue;
    }

    if (action.kind === "challenge") {
      const beforeRefuted = realRefutedProps(session);
      const challenged = resolveFakeChallenge(
        session,
        actor,
        action.evidenceId,
        session.round + 1
      );
      if (!challenged) continue;
      syncRefutedProps(session);
      penalizeNewlyBrokenClaims(session, beforeRefuted);
      moves.push({
        kind: "challenge",
        actorId: actor.id,
        actorName: actor.name,
        evidenceName: challenged.evidence.name,
        evidenceDesc: challenged.evidence.description,
        success: challenged.success,
        fakerId: challenged.faker?.id || "",
        fakerName: challenged.faker?.name || "",
      });
      continue;
    }

    if (action.kind === "dodge") {
      addPenalty(actor, PENALTY.DODGE);
      for (const question of session.questions) {
        if (
          question.toId === actor.id &&
          !question.answered &&
          question.round <= session.round
        ) {
          question.answered = true;
        }
      }

      // 秘密不在这里曝光。它是处刑前才翻出来的东西，用来给那个人的下场配重，
      // 不该在庭上被当成嫌疑值筹码消耗掉。
      moves.push({ kind: "dodge", actorId: actor.id, actorName: actor.name });
      continue;
    }

    if (action.kind === "question") {
      const target = girlOf(session, action.targetId);
      if (!target?.alive) continue;

      // 追问**不撬证据**。搜证是调查阶段的事（#询问），庭上追问只施压。
      //
      // 一度让追问也能白拿一张牌，结果它成了唯一「零风险还有收益」的动作，
      // 出示要担反噬、主张没收益，理性玩家只会一路追问到榨干为止。
      // 现在它是纯粹的节奏交换：我花一个动作，逼你也花一个动作表态——
      // 而你表的态会变成我下一轮的靶子。
      session.questions.push({
        fromId: actor.id,
        toId: target.id,
        topic: safeString(action.topic, 60),
        round: session.round + 1,
        answered: false,
      });
      moves.push({
        kind: "question",
        actorId: actor.id,
        actorName: actor.name,
        targetName: target.name,
        targetId: target.id,
        topic: safeString(action.topic, 60),
      });
      continue;
    }

    if (action.kind === "answer") {
      // 回应必须押一个**结论型**命题——也就是必须当众说出「我认为她是怎么死的」。
      //
      // 只要求押任意命题的话，押一条平平无奇的事实陈述就完事了，几乎没代价，
      // 追问也就威胁不到任何人。而按案件校验，除真相之外**每个结论都有证据能否定**，
      // 所以站队必然承担被打穿的风险。押中真相才安全——可你怎么知道哪个是真相。
      const prop = propositionOf(caseFile, action.propId);
      if (!prop?.conclusion) continue;

      for (const question of session.questions) {
        if (
          question.toId === actor.id &&
          !question.answered &&
          question.round <= session.round
        ) {
          question.answered = true;
        }
      }

      const status = propositionStatus(caseFile, prop.id, session.publicEvidence);
      const reallyRefuted = realRefutedProps(session).has(prop.id);
      session.claims.push({
        byId: actor.id,
        propId: prop.id,
        chapter: session.chapter,
        round: session.round + 1,
        broken: reallyRefuted,
      });
      if (reallyRefuted) addPenalty(actor, PENALTY.CLAIM_BROKEN);
      session.testimony.push({
        chapter: session.chapter,
        byId: actor.id,
        name: actor.name,
        text: `${safeString(action.text, 100)}（据以辩解：${prop.text}）`,
      });

      moves.push({
        kind: "answer",
        actorId: actor.id,
        actorName: actor.name,
        text: safeString(action.text, 120),
        propText: prop.text,
        refuted: status.refuted,
      });
      continue;
    }

    if (action.kind === "fake") {
      const fake = plantFakeEvidence(session, actor, action);
      if (!fake) continue;
      if (!fake.ok) {
        if (fake.reason === "no_flaw") {
          addPenalty(actor, PENALTY.BACKFIRE);
          moves.push({
            kind: "fake_failed",
            actorId: actor.id,
            actorName: actor.name,
            text: safeString(action.text, 200),
          });
        }
        continue;
      }
      syncRefutedProps(session);
      moves.push({
        kind: "fake",
        actorId: actor.id,
        actorName: actor.name,
        text: fake.description,
        exposed: false,
      });
    }
  }

  recomputeSuspicion(session);
  moves.sort((a, b) => compareActorCode(session, a, b));

  const publicEvidence = (caseFile.evidence || []).filter((item) =>
    session.publicEvidence.includes(item.id)
  );
  const standing = standingConclusions(caseFile, session.publicEvidence).map((item) => ({
    text: item.prop.text,
    supports: item.status.supports,
  }));
  const suspicionBoard = livingGirls(session)
    .sort((a, b) => b.suspicion - a.suspicion || comparePrisonerCode(a, b))
    .map((girl) => ({
      name: girl.name,
      suspicion: girl.suspicion,
    }));

  const prompt = buildTrialPrompt({
    caseFile,
    girls: session.girls,
    round: session.round + 1,
    maxRounds: session.trialRounds,
    moves,
    publicEvidence,
    standing,
    suspicionBoard,
    summaryLines: session.summaryLines,
    recentLog: session.recentLog,
  });

  const raw = await narrate({ route, e, system: TRIAL_SYSTEM, prompt });
  const parsed = extractNarration(raw);

  session.round += 1;
  session.pendingActions = {};
  pushLog(session, parsed);

  // 真相是吸收态：一旦证成就没有证据能推翻它，可以直接跳过投票定案
  const truthDone = isTruthEstablished(caseFile, session.publicEvidence);

  return {
    narration: parsed.narration,
    npcLines: parsed.npcLines,
    moves,
    standing,
    truthEstablished: truthDone,
    phaseDone: truthDone || session.round >= session.trialRounds,
  };
}

// ===== 投票与判决 =====

/**
 * 收票、判决、处刑、推进章节
 * @param {Record<string,string>} playerVotes girlId -> propId
 */
export async function resolveVerdict({ e, route, session, playerVotes }) {
  const caseFile = session.caseFile;
  const votes = { ...npcVotes(session), ...playerVotes };
  const verdict = decideVerdict(session, votes);

  const executedAll = (verdict.executedIds || [])
    .map((id) => girlOf(session, id))
    .filter(Boolean);
  for (const girl of executedAll) {
    girl.alive = false;
    girl.fate = "executed";
    // 秘密在这一刻才被翻出来——指认结束、处刑之前。
    // 它不是嫌疑值筹码，是给这个人的下场配重的东西：直到她要死了，
    // 大家才知道她一直藏着什么。
    girl.secretExposed = true;
  }
  // 单人处刑的路径还沿用 executed；全员处刑走 executedAll
  const executed = executedAll.length === 1 ? executedAll[0] : null;

  const over = checkGameOver(session, verdict);
  const isFinalChapter = over.over;
  let text = "";
  try {
    const prompt = buildVerdictPrompt({
      caseFile,
      girls: session.girls,
      verdict,
      executed,
      executedAll,
      truthProp: propositionOf(caseFile, caseFile.truthId),
      chapter: session.chapter,
      isFinalChapter,
      summaryLines: session.summaryLines,
      recentLog: session.recentLog,
    });
    const raw = await narrate({ route, e, system: null, prompt });
    text = safeString(raw, 2000);
  } catch (error) {
    logger.warn(`[魔女审判] 宣判文本生成失败，回落到简述：${error.message}`);
  }

  session.history.push({
    chapter: session.chapter,
    victimName: girlOf(session, caseFile.victimId)?.name || "某人",
    executedName: verdict.collapsed
      ? `全员（${executedAll.length}人）`
      : executed?.name || "",
    collapsed: verdict.collapsed,
    correct: verdict.correct,
    truthText: propositionOf(caseFile, caseFile.truthId)?.text || "",
    culpritName: girlOf(session, caseFile.culpritId)?.name || "",
    // 自杀/意外的章节里「凶手」就是死者本人，终局表要按这个改写措辞，
    // 否则会打出「死者：梅露露　真凶：梅露露」这种胡话
    truthType: propositionOf(caseFile, caseFile.truthId)?.conclusion?.type || "",
    // 判错的那几章，动机当时没被讲出来。留到终局一次性摊开。
    motive: caseFile.motive?.trigger || "",
    confession: caseFile.motive?.confession || "",
  });

  return { verdict, executed, text, over };
}

/**
 * 结束条件
 * 真凶被处刑 → 幸存者全部获释；玩家剩不到 2 人 / 章节耗尽 / NPC 池空 → 收场
 */
export function checkGameOver(session, verdict) {
  const players = livingPlayers(session);
  const npcLeft = livingGirls(session).filter((girl) => girl.kind === "npc").length;

  // 全员处刑要排在最前面判。真凶确实死在里面，但那是连坐不是查出来的，
  // 落到「真凶伏法」这个好结局上就说反了。
  if (verdict?.collapsed) {
    return { over: true, reason: "collapse", label: "审判崩坏" };
  }
  if (verdict && !verdict.culpritEscaped) {
    return { over: true, reason: "caught", label: "真凶伏法" };
  }
  if (!players.length) return { over: true, reason: "wipeout", label: "玩家全灭" };
  if (players.length < 2) return { over: true, reason: "lastOne", label: "只剩一人" };
  if (session.chapter >= session.maxChapters) {
    return { over: true, reason: "exhausted", label: "章节耗尽" };
  }
  if (!npcLeft) return { over: true, reason: "exhausted", label: "无人可作死者" };
  return { over: false };
}

// ===== 工具 =====

function extractNarration(raw) {
  const text = String(raw || "").trim();

  // 叙事类调用要求返回 JSON，但 AI 偶尔会直接给正文。给不出 JSON 就整段当叙事用，
  // 不值得为此丢掉一个已经花了钱的回合。
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed?.narration) {
        return {
          narration: safeString(parsed.narration, 2000),
          summary: safeString(parsed.summary, 150),
          npcLines: (Array.isArray(parsed.npcLines) ? parsed.npcLines : [])
            .slice(0, 4)
            .map((item) => ({
              girlId: safeString(item?.girlId, 40),
              text: safeString(item?.text, 80),
            }))
            .filter((item) => item.text),
        };
      }
    } catch {
      // 换下一个候选
    }
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const parsed = JSON.parse(text.slice(firstBrace, lastBrace + 1));
      if (parsed?.narration) {
        return {
          narration: safeString(parsed.narration, 2000),
          summary: safeString(parsed.summary, 150),
          npcLines: [],
        };
      }
    } catch {
      // 落到兜底
    }
  }

  return { narration: safeString(text, 2000), summary: "", npcLines: [] };
}

function pushLog(session, parsed) {
  if (parsed.summary) {
    session.summaryLines = [...(session.summaryLines || []), parsed.summary].slice(-MAX_SUMMARY_LINES);
  }
  session.recentLog = [
    ...(session.recentLog || []),
    { chapter: session.chapter, round: session.round, text: parsed.narration.slice(0, 200) },
  ].slice(-RECENT_LOG_SIZE);
}

/** 本章可投的结论清单，供指令层出编号菜单 */
export function votableConclusions(session) {
  const caseFile = session.caseFile;
  return conclusionsOf(caseFile).map((item) => {
    const status = propositionStatus(caseFile, item.id, session.publicEvidence);
    const target =
      item.conclusion.type === VERDICT.ACCUSE ? girlOf(session, item.conclusion.targetId) : null;
    return {
      propId: item.id,
      text: item.text,
      type: item.conclusion.type,
      targetName: target ? `${target.code} ${target.name}` : "",
      supports: status.supports,
      threshold: status.threshold,
      stands: status.stands,
      refuted: status.refuted,
    };
  });
}

/** 某人证物袋里的证据详情 */
export function pouchDetail(session, girlId) {
  return pouchOf(session, girlId)
    .map((id) => evidenceOf(session.caseFile, id))
    .filter(Boolean);
}
