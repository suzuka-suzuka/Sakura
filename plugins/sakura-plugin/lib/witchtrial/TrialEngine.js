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
import { generateCase, pickVictimAndCulprit } from "./CaseGenerator.js";
import {
  PENALTY,
  REFUTE_RESULT,
  addPenalty,
  decideVerdict,
  isTruthEstablished,
  judgeRefutation,
  npcVotes,
  propositionStatus,
  recomputeSuspicion,
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
  session.chapter += 1;

  const picked = pickVictimAndCulprit(session, { playerCulpritChance, suicideChance });
  if (!picked) throw new Error("NPC 少女已经不够了，开不了新的案件");

  const caseFile = await generateCase({
    e,
    route,
    session,
    victim: picked.victim,
    culprit: picked.culprit,
    onProgress,
  });

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

  // 行为惩罚每章清零，结构性嫌疑会重算
  for (const girl of listGirls(session)) girl.penalty = 0;
  recomputeSuspicion(session);

  return picked;
}

// ===== 调查阶段 =====

/** 某地点当前还能被这个人搜到的证据 */
function searchablePool(session, actorId, locationId) {
  const bag = pouchOf(session, actorId);
  return (session.caseFile.evidence || []).filter(
    (item) =>
      item.via === EVIDENCE_VIA.SEARCH &&
      item.location === locationId &&
      !item.fake &&
      !session.destroyedEvidence.includes(item.id) &&
      !bag.includes(item.id)
  );
}

function askablePool(session, actorId, targetId) {
  const bag = pouchOf(session, actorId);
  return (session.caseFile.evidence || []).filter(
    (item) =>
      item.via === EVIDENCE_VIA.ASK &&
      item.askTarget === targetId &&
      !item.fake &&
      !session.destroyedEvidence.includes(item.id) &&
      !bag.includes(item.id)
  );
}

/**
 * 结算一个调查回合
 * @param {object[]} actions [{ girlId, kind, locationId, targetId, question }]
 */
export async function resolveInvestigateTurn({ e, route, session, actions }) {
  const caseFile = session.caseFile;
  const results = [];

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
        locationName: locationName(session, action.locationId),
        found: Boolean(found),
        evidenceName: found?.name || "",
        evidenceDesc: found?.description || "",
      });
      continue;
    }

    if (action.kind === "ask") {
      const target = girlOf(session, action.targetId);
      const pool = askablePool(session, actor.id, action.targetId);
      const found = pool.length ? pick(pool) : null;
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
        targetName: target?.name || "某人",
        question: action.question || "案发那晚的事",
        found: Boolean(found),
        evidenceName: found?.name || "",
        evidenceDesc: found?.description || "",
      });
      continue;
    }

    if (action.kind === "destroy") {
      const pool = (caseFile.evidence || []).filter(
        (item) =>
          item.via === EVIDENCE_VIA.SEARCH &&
          item.location === action.locationId &&
          !item.fake &&
          !session.destroyedEvidence.includes(item.id) &&
          !session.publicEvidence.includes(item.id)
      );
      const target = pool.length ? pick(pool) : null;
      if (target) session.destroyedEvidence.push(target.id);

      const others = (byLocation.get(action.locationId) || []).filter((id) => id !== actor.id);
      results.push({
        kind: "destroy",
        actorId: actor.id,
        actorName: actor.name,
        locationName: locationName(session, action.locationId),
        destroyed: Boolean(target),
        witnessed: others.length > 0,
      });
    }
  }

  // NPC 凶手按开局排好的表行动，不问 AI
  const npcPlan = (caseFile.witchPlan || []).find((item) => item.round === session.round + 1);
  if (npcPlan?.action === "destroy" && !session.destroyedEvidence.includes(npcPlan.evidenceId)) {
    if (!session.publicEvidence.includes(npcPlan.evidenceId)) {
      session.destroyedEvidence.push(npcPlan.evidenceId);
    }
  }

  // 撞见：同地点两人以上
  const encounters = [];
  for (const [locationId, ids] of byLocation) {
    if (ids.length < 2) continue;
    encounters.push({
      locationName: locationName(session, locationId),
      names: ids.map((id) => girlOf(session, id)?.name || "某人"),
    });
  }

  const prompt = buildInvestigatePrompt({
    prison: session.prison,
    caseFile,
    girls: session.girls,
    round: session.round + 1,
    maxRounds: session.investigateRounds,
    results,
    encounters,
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

/**
 * 结算一个庭审回合
 * @param {object[]} actions [{ girlId, kind, propId, evidenceId, targetId, topic, text }]
 */
export async function resolveTrialTurn({ e, route, session, actions }) {
  const caseFile = session.caseFile;
  const moves = [];

  // 上一轮被追问却没回应的人，先记回避
  const answered = new Set(
    actions.filter((item) => item.kind === "answer").map((item) => item.girlId)
  );
  for (const question of session.questions) {
    if (question.answered || question.round >= session.round) continue;
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
      session.claims.push({
        byId: actor.id,
        propId: prop.id,
        chapter: session.chapter,
        round: session.round + 1,
      });
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

    if (action.kind === "refute") {
      const judged = judgeRefutation(caseFile, {
        evidenceId: action.evidenceId,
        propId: action.propId,
        pouch: pouchOf(session, actor.id),
      });
      if (judged.result === REFUTE_RESULT.UNKNOWN || judged.result === REFUTE_RESULT.NOT_OWNED) {
        continue; // 指令层已经拦过，这里只是兜底
      }

      // 无效反驳的代价是双重的：自己涨嫌疑，还白白把牌摊上桌面
      publicize(session, judged.evidence.id);
      const valid = judged.result === REFUTE_RESULT.VALID;

      if (valid) {
        if (!session.refutedProps.includes(judged.prop.id)) {
          session.refutedProps.push(judged.prop.id);
        }
        // 主张这条命题的人要担责
        for (const claim of session.claims) {
          if (claim.propId === judged.prop.id && claim.chapter === session.chapter) {
            addPenalty(girlOf(session, claim.byId), PENALTY.CLAIM_BROKEN);
          }
        }
      } else {
        addPenalty(actor, PENALTY.BACKFIRE);
      }

      moves.push({
        kind: "refute",
        actorId: actor.id,
        actorName: actor.name,
        evidenceName: judged.evidence.name,
        evidenceDesc: judged.evidence.description,
        propText: judged.prop.text,
        valid,
      });
      continue;
    }

    if (action.kind === "question") {
      const target = girlOf(session, action.targetId);
      if (!target?.alive) continue;
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
        topic: safeString(action.topic, 60),
      });
      continue;
    }

    if (action.kind === "answer") {
      for (const question of session.questions) {
        if (question.toId === actor.id && !question.answered) question.answered = true;
      }
      session.testimony.push({
        chapter: session.chapter,
        byId: actor.id,
        name: actor.name,
        text: safeString(action.text, 120),
      });
      moves.push({
        kind: "answer",
        actorId: actor.id,
        actorName: actor.name,
        text: safeString(action.text, 120),
      });
      continue;
    }

    if (action.kind === "fake") {
      const fake = plantFakeEvidence(session, actor, action);
      if (!fake) continue;
      moves.push({
        kind: "fake",
        actorId: actor.id,
        actorName: actor.name,
        text: fake.description,
        exposed: fake.exposed,
      });
      if (fake.exposed) addPenalty(actor, PENALTY.FAKE_EXPOSED);
    }
  }

  recomputeSuspicion(session);

  const publicEvidence = (caseFile.evidence || []).filter((item) =>
    session.publicEvidence.includes(item.id)
  );
  const standing = standingConclusions(caseFile, session.publicEvidence).map((item) => ({
    text: item.prop.text,
    supports: item.status.supports,
  }));
  const suspicionBoard = livingGirls(session).map((girl) => ({
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

/**
 * 凶手伪造一条证据
 * 伪证带一个破绽字段，指向某条能戳破它的真证据。对方手里有那条就被反揭穿。
 */
function plantFakeEvidence(session, actor, action) {
  const caseFile = session.caseFile;
  const prop = propositionOf(caseFile, action.propId);
  if (!prop) return null;

  // 破绽 = 一条支持该命题的真证据。它一旦在台面上，伪证就站不住
  const flaw = (caseFile.evidence || []).find(
    (item) => !item.fake && item.supports.includes(prop.id)
  );

  const fake = {
    id: `fake_${session.chapter}_${caseFile.evidence.length + 1}`,
    name: `${actor.name}的说辞`,
    description: safeString(action.text, 200),
    via: EVIDENCE_VIA.ASK,
    location: "",
    askTarget: actor.id,
    supports: [],
    refutes: [prop.id],
    fake: true,
    flawOf: flaw?.id || "",
  };

  const exposed = Boolean(flaw && session.publicEvidence.includes(flaw.id));
  if (!exposed) {
    // 没被当场识破才真的生效，否则只是一次难堪的表演
    caseFile.evidence.push(fake);
    session.publicEvidence.push(fake.id);
    if (!session.refutedProps.includes(prop.id)) session.refutedProps.push(prop.id);
  }

  return { ...fake, exposed };
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

  const executed = verdict.executedId ? girlOf(session, verdict.executedId) : null;
  if (executed) {
    executed.alive = false;
    executed.fate = "executed";
  }

  const isFinalChapter = session.chapter >= session.maxChapters;
  let text = "";
  try {
    const prompt = buildVerdictPrompt({
      caseFile,
      girls: session.girls,
      verdict,
      executed,
      truthProp: propositionOf(caseFile, caseFile.truthId),
      chapter: session.chapter,
      isFinalChapter,
    });
    const raw = await narrate({ route, e, system: null, prompt });
    text = safeString(raw, 2000);
  } catch (error) {
    logger.warn(`[魔女审判] 宣判文本生成失败，回落到简述：${error.message}`);
  }

  session.history.push({
    chapter: session.chapter,
    victimName: girlOf(session, caseFile.victimId)?.name || "某人",
    executedName: executed?.name || "",
    correct: verdict.correct,
    truthText: propositionOf(caseFile, caseFile.truthId)?.text || "",
    culpritName: girlOf(session, caseFile.culpritId)?.name || "",
    // 判错的那几章，动机当时没被讲出来。留到终局一次性摊开。
    motive: caseFile.motive?.trigger || "",
    confession: caseFile.motive?.confession || "",
  });

  return { verdict, executed, text, over: checkGameOver(session, verdict) };
}

/**
 * 结束条件
 * 真凶被处刑 → 幸存者全部获释；玩家剩不到 2 人 / 章节耗尽 / NPC 池空 → 收场
 */
export function checkGameOver(session, verdict) {
  const players = livingPlayers(session);
  const npcLeft = livingGirls(session).filter((girl) => girl.kind === "npc").length;

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
      targetName: target?.name || "",
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
