/**
 * 案件的本地逻辑骨架
 *
 * AI 只写案件蓝图与可读文本；候选结论、证据关系、事实传播、获取途径和
 * 伪证揭穿点全部在这里生成。这样模型无法因为漏写一个数组或写错一个 id
 * 破坏案件的可解性。
 */

import {
  EVIDENCE_VIA,
  FACT_EFFECT_STANCE,
  FACT_EFFECT_WHEN,
  SUPPORT_THRESHOLD,
  VERDICT,
  girlsByPrisonerCode,
  normalizeStringArray,
  safeString,
} from "./schema.js";

const FACT_COUNT = 5;
const MIN_EVIDENCE_DESCRIPTION = 24;
const MIN_FORGERY_DESCRIPTION = 40;
const MIN_EXPOSURE_TEXT = 20;

function randomIndex(length, random) {
  if (length <= 1) return 0;
  const value = Number(random?.());
  const normalized = Number.isFinite(value) ? Math.max(0, Math.min(0.999999, value)) : 0;
  return Math.floor(normalized * length);
}

function pick(list, random) {
  return list[randomIndex(list.length, random)];
}

function shuffled(list, random) {
  const result = [...list];
  for (let index = result.length - 1; index > 0; index--) {
    const swapIndex = randomIndex(index + 1, random);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function abilityTexts(girl, maxLength = 40) {
  return unique(
    [girl?.ability?.name, ...(girl?.ability?.can || [])]
      .map((item) => safeString(item, maxLength))
      .filter(Boolean)
  );
}

function girlCanUsePlan(girl, plan) {
  const owned = abilityTexts(girl);
  return plan.every((need) =>
    owned.some((have) => have.includes(need) || need.includes(have))
  );
}

function samePlan(left, right) {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((item, index) => item === b[index]);
}

function abilityOverlaps(left, right) {
  const a = safeString(left, 40);
  const b = safeString(right, 40);
  return Boolean(a && b && (a.includes(b) || b.includes(a)));
}

/**
 * 枚举能够通过现有能力校验的方案。
 *
 * 只给 AI 可选答案，不让它自由拼能力名。空数组永远合法，表示完整方案没有
 * 使用魔法；非空方案必须既能由凶手完成，又不能凭能力直接锁定唯一嫌疑人。
 */
export function allowedAbilityPlans({ girls, victim, culprit }) {
  const inPlay = girlsByPrisonerCode(girls).filter(
    (girl) => girl.alive && girl.id !== victim.id
  );
  const owned = abilityTexts(culprit, 20);
  const candidates = [
    ...owned.map((item) => [item]),
    ...owned.flatMap((left, leftIndex) =>
      owned.slice(leftIndex + 1).map((right) => [left, right])
    ),
  ];

  const valid = candidates.filter((plan) => {
    if (!girlCanUsePlan(culprit, plan)) return false;
    const possible = inPlay.filter((girl) => girlCanUsePlan(girl, plan)).length;
    if (possible < 2) return false;
    return inPlay.length < 4 || possible <= Math.ceil(inPlay.length * 0.6);
  });

  return [
    [],
    ...valid.filter(
      (plan, index) => valid.findIndex((other) => samePlan(other, plan)) === index
    ),
  ].slice(0, 8);
}

function conclusionText(spec, victim, girls) {
  if (spec.type === VERDICT.SUICIDE) {
    return `${victim.name}自行结束了生命`;
  }
  const target = girls[spec.targetId];
  return `${target?.name || "某位少女"}杀害了${victim.name}`;
}

function evidenceRelations(intent) {
  if (intent.role === "fact_support") {
    return { supports: [intent.factPropId], refutes: [] };
  }
  if (intent.role === "direct_refute") {
    return { supports: [], refutes: [intent.conclusionPropId] };
  }
  return { supports: [intent.conclusionPropId], refutes: [] };
}

/**
 * 一章只随机一次的逻辑拓扑。
 *
 * - 3-4 个候选结论，恰好一个自杀结论；
 * - 5 个事实，每个事实只向一个结论传播支持；
 * - 11 或 13 条证据，所有错误结论都有反证；
 * - 搜查与询问渠道在本地保证可达；
 * - 每个结论都有一套伪证方案和一条固定破绽证据。
 */
export function createCaseTopology({
  prison,
  girls,
  victim,
  culprit,
  chapter,
  random = Math.random,
}) {
  const locations = Array.isArray(prison?.locations) ? prison.locations : [];
  if (locations.length < 3) {
    throw new Error("牢狱地点少于 3 个，无法构造案件证据图");
  }

  const living = girlsByPrisonerCode(girls).filter((girl) => girl.alive);
  const inPlay = living.filter((girl) => girl.id !== victim.id);
  if (inPlay.length < 2) {
    throw new Error("除死者外少于 2 位在场少女，无法构造候选结论和证言");
  }

  const isSuicide = culprit.id === victim.id;
  const accusationCount = Math.min(3, inPlay.length);
  let accusationTargets;
  if (isSuicide) {
    accusationTargets = shuffled(inPlay, random).slice(0, accusationCount);
  } else {
    if (!inPlay.some((girl) => girl.id === culprit.id)) {
      throw new Error("本地选出的凶手不在本章可用名册中");
    }
    const falseTargets = shuffled(
      inPlay.filter((girl) => girl.id !== culprit.id),
      random
    ).slice(0, accusationCount - 1);
    accusationTargets = [culprit, ...falseTargets];
  }

  const rawConclusions = [
    ...accusationTargets.map((target) => ({
      type: VERDICT.ACCUSE,
      targetId: target.id,
      truth: !isSuicide && target.id === culprit.id,
    })),
    {
      type: VERDICT.SUICIDE,
      targetId: "",
      truth: isSuicide,
    },
  ];

  const conclusions = shuffled(rawConclusions, random).map((item, index) => ({
    ...item,
    id: `c_${String(index + 1).padStart(2, "0")}`,
    text: conclusionText(item, victim, girls),
  }));
  const truth = conclusions.find((item) => item.truth);
  if (!truth) throw new Error("案件拓扑没有生成唯一真相");

  const facts = Array.from({ length: FACT_COUNT }, (_, index) => {
    const conclusion = conclusions[index % conclusions.length];
    return {
      id: `f_${String(index + 1).padStart(2, "0")}`,
      conclusionPropId: conclusion.id,
    };
  });

  const intents = [];
  for (const fact of facts) {
    intents.push({
      role: "fact_support",
      factPropId: fact.id,
      conclusionPropId: fact.conclusionPropId,
    });
  }
  for (const conclusion of conclusions) {
    const directSupports = SUPPORT_THRESHOLD[conclusion.type] - 1;
    for (let index = 0; index < directSupports; index++) {
      intents.push({
        role: "direct_support",
        conclusionPropId: conclusion.id,
      });
    }
    if (!conclusion.truth) {
      intents.push({
        role: "direct_refute",
        conclusionPropId: conclusion.id,
      });
    }
  }

  const askTargets = shuffled(inPlay, random);
  let searchIndex = 0;
  let askIndex = 0;
  const evidence = shuffled(intents, random).map((intent, index) => {
    // 前三条固定分散到三个地点，随后三条固定分散到至少两位少女。
    const via =
      index < 3 || (index >= 6 && index % 2 === 0)
        ? EVIDENCE_VIA.SEARCH
        : EVIDENCE_VIA.ASK;
    const delivery =
      via === EVIDENCE_VIA.SEARCH
        ? {
            location: locations[searchIndex++ % locations.length].id,
            askTarget: "",
          }
        : {
            location: "",
            askTarget: askTargets[askIndex++ % askTargets.length].id,
          };
    const relations = evidenceRelations(intent);
    return {
      ...intent,
      id: `e_${String(index + 1).padStart(2, "0")}`,
      via,
      ...delivery,
      ...relations,
    };
  });

  // 至少让每条错误结论的反证还能推进另一种解释。证物公开后可以被不同玩家
  // 重复用于不同命题，不会退化成“一张牌只有一个固定按钮”。
  for (const conclusion of conclusions.filter((item) => !item.truth)) {
    const refute = evidence.find(
      (item) =>
        item.role === "direct_refute" &&
        item.conclusionPropId === conclusion.id
    );
    const alternatives = conclusions.filter((item) => item.id !== conclusion.id);
    const alternative = pick(alternatives, random);
    if (refute && alternative && !refute.supports.includes(alternative.id)) {
      refute.supports.push(alternative.id);
    }
  }

  const factEffects = facts.map((fact) => ({
    factPropId: fact.id,
    when: FACT_EFFECT_WHEN.ESTABLISHED,
    conclusionPropId: fact.conclusionPropId,
    stance: FACT_EFFECT_STANCE.SUPPORT,
  }));

  const forgeryPlans = conclusions.map((conclusion, index) => {
    const flaw = evidence.find(
      (item) =>
        item.role === "direct_support" &&
        item.conclusionPropId === conclusion.id
    );
    if (!flaw) {
      throw new Error(`结论 ${conclusion.id} 没有可用的伪证破绽证据`);
    }
    return {
      id: `fp_${String(index + 1).padStart(2, "0")}`,
      targetPropId: conclusion.id,
      flawEvidenceId: flaw.id,
    };
  });

  const falseAccusationIds = new Set(
    conclusions
      .filter((item) => !item.truth && item.type === VERDICT.ACCUSE)
      .map((item) => item.targetId)
  );
  const misdirectionChoices = inPlay
    .filter((girl) => falseAccusationIds.has(girl.id))
    .map((girl) => ({
      targetId: girl.id,
      targetName: girl.name,
      abilities: abilityTexts(girl),
    }));

  return {
    chapter,
    victimId: victim.id,
    culpritId: culprit.id,
    truthId: truth.id,
    discovery: {
      location: pick(locations, random).id,
      finder: pick(inPlay, random).id,
    },
    conclusions,
    facts,
    evidence,
    factEffects,
    forgeryPlans,
    allowedAbilityPlans: allowedAbilityPlans({ girls, victim, culprit }),
    misdirectionChoices,
  };
}

function requiredPlanOf(raw, allowedPlans) {
  const requested = normalizeStringArray(raw, { limit: 2, maxLength: 20 });
  return allowedPlans.find((plan) => samePlan(plan, requested)) || null;
}

function exactRows(rawRows, expectedIds, idOf, label, problems) {
  if (!Array.isArray(rawRows)) {
    problems.push(`${label}不是数组`);
    return new Map();
  }
  const rows = new Map();
  for (const row of rawRows) {
    const id = safeString(idOf(row), 40);
    if (!id || rows.has(id)) {
      problems.push(`${label}存在空 id 或重复 id`);
      continue;
    }
    rows.set(id, row);
  }
  const expected = new Set(expectedIds);
  const missing = expectedIds.filter((id) => !rows.has(id));
  const extras = [...rows.keys()].filter((id) => !expected.has(id));
  if (missing.length) problems.push(`${label}缺少：${missing.join("、")}`);
  if (extras.length) problems.push(`${label}包含未知项：${extras.join("、")}`);
  return rows;
}

/**
 * 收紧 AI 蓝图，只保留本地允许进入案件档案的字段。
 */
export function normalizeCaseBlueprint(
  raw,
  { topology, resolveGirlId = (value) => safeString(value, 40) }
) {
  const source = raw && typeof raw === "object" ? raw : {};
  const problems = [];
  const discovery = {
    time: safeString(source.discovery?.time, 40),
    body: safeString(source.discovery?.body, 400),
  };
  if (!discovery.time) problems.push("发现时间为空");
  if (discovery.body.length < 40) problems.push("尸体客观描述过短");

  const methodSource =
    source.method && typeof source.method === "object" ? source.method : {};
  const selectedPlan = requiredPlanOf(
    methodSource.requiredAbilities,
    topology.allowedAbilityPlans
  );
  if (!selectedPlan) problems.push("requiredAbilities 不在本地允许的方案中");

  const method = {
    causeOfDeath: safeString(methodSource.causeOfDeath, 160),
    killingAction: safeString(methodSource.killingAction, 300),
    magicRole: safeString(methodSource.magicRole, 300),
    description: safeString(methodSource.description, 500),
    requiredAbilities: selectedPlan || [],
    misdirection: null,
  };
  if (!method.causeOfDeath) problems.push("真实死因为空");
  if (method.killingAction.length < 8) problems.push("致死动作过短");
  if (method.magicRole.length < 6) problems.push("魔法用途说明过短");
  if (method.description.length < 40) problems.push("完整作案经过过短");

  if (methodSource.misdirection && typeof methodSource.misdirection === "object") {
    const targetId = resolveGirlId(methodSource.misdirection.targetId);
    const choice = topology.misdirectionChoices.find(
      (item) => item.targetId === targetId
    );
    const apparentAbility = safeString(
      methodSource.misdirection.apparentAbility,
      40
    );
    const description = safeString(methodSource.misdirection.description, 500);
    method.misdirection = { targetId, apparentAbility, description };

    if (!choice) problems.push("魔法误导没有指向本地给定的错误指认对象");
    if (choice && !choice.abilities.includes(apparentAbility)) {
      problems.push("魔法误导的表面能力不是被嫁祸者的公开能力原文");
    }
    if (
      method.requiredAbilities.some((actual) =>
        abilityOverlaps(actual, apparentAbility)
      )
    ) {
      problems.push("魔法误导的表面能力同时又是真实方案所需能力");
    }
    if (description.length < 20) problems.push("魔法误导没有写清假象与替代手段");
  }

  const motive = {
    trigger: safeString(source.motive?.trigger, 200),
    backstory: safeString(source.motive?.backstory, 600),
    confession: safeString(source.motive?.confession, 300),
  };
  if (motive.trigger.length < 12) problems.push("动机触发点过短");
  if (motive.backstory.length < 40) problems.push("动机背景过短");
  if (motive.confession.length < 12) problems.push("拆穿后的自白过短");

  const factRows = exactRows(
    source.facts,
    topology.facts.map((item) => item.id),
    (item) => item?.id,
    "事实蓝图",
    problems
  );
  const facts = topology.facts.map((slot) => ({
    id: slot.id,
    text: safeString(factRows.get(slot.id)?.text, 120),
  }));
  for (const fact of facts) {
    if (fact.text.length < 8) problems.push(`事实 ${fact.id} 的内容过短`);
    if (/girl_\d+|[cefp]_\d+/i.test(fact.text)) {
      problems.push(`事实 ${fact.id} 的可读文本含有内部 id`);
    }
  }
  if (new Set(facts.map((item) => item.text)).size !== facts.length) {
    problems.push("事实蓝图存在重复内容");
  }

  return {
    ok: problems.length === 0,
    problems,
    blueprint: { discovery, method, motive, facts },
  };
}

function placeholderEvidence(index) {
  return {
    name: `结构证物${index + 1}`,
    description:
      "这是一条用于案件结构检查的客观证物记录，具体可见内容会在逻辑关系锁定后由文本阶段完整填写。",
  };
}

/**
 * 把蓝图装进本地证据图。占位文本只用于在填文前运行原有 validateCase，
 * 不会在成功案件中返回给玩家。
 */
export function buildCaseDraft({ topology, blueprint }) {
  const factText = new Map(blueprint.facts.map((item) => [item.id, item.text]));
  const propositions = [
    ...topology.conclusions.map((item) => ({
      id: item.id,
      text: item.text,
      conclusion: {
        type: item.type,
        targetId: item.type === VERDICT.ACCUSE ? item.targetId : "",
      },
    })),
    ...topology.facts.map((item) => ({
      id: item.id,
      text: factText.get(item.id) || "",
      conclusion: null,
    })),
  ];

  const evidence = topology.evidence.map((slot, index) => ({
    id: slot.id,
    ...placeholderEvidence(index),
    via: slot.via,
    location: slot.location,
    askTarget: slot.askTarget,
    supports: [...slot.supports],
    refutes: [...slot.refutes],
  }));

  const factEffects = topology.factEffects.map((slot) => ({
    ...slot,
    reason:
      "这项已经公开确认的事实会改变对应责任结论的成立基础，因此可以作为一条独立的间接支持论据。",
  }));

  const forgeryPlans = topology.forgeryPlans.map((slot, index) => ({
    ...slot,
    name: `庭审记录${index + 1}`,
    description:
      "这份公开记录呈现了案发时段的一组连续客观现象，表面上足以排除目标责任结论所要求的关键条件。",
    exposureText:
      "指定的真实证物与这份记录在时间和物理状态上无法同时成立，二者对照后即可确认记录的解释不可靠。",
  }));

  return {
    chapter: topology.chapter,
    victimId: topology.victimId,
    culpritId: topology.culpritId,
    truthId: topology.truthId,
    discovery: {
      location: topology.discovery.location,
      finder: topology.discovery.finder,
      ...blueprint.discovery,
    },
    method: blueprint.method,
    motive: blueprint.motive,
    propositions,
    evidence,
    factEffects,
    forgeryPlans,
  };
}

function readableHasInternalId(value) {
  return /girl_\d+|[cefp]_\d+/i.test(String(value || ""));
}

/**
 * 检查文本阶段是否逐槽填满；关系字段即使被模型额外输出，也不会被采用。
 */
export function validateCaseText(raw, topology) {
  const source = raw && typeof raw === "object" ? raw : {};
  const problems = [];
  const evidenceRows = exactRows(
    source.evidence,
    topology.evidence.map((item) => item.id),
    (item) => item?.id,
    "证据文本",
    problems
  );
  const effectRows = exactRows(
    source.factEffects,
    topology.factEffects.map((item) => item.factPropId),
    (item) => item?.factPropId,
    "事实效果文本",
    problems
  );
  const forgeryRows = exactRows(
    source.forgeryPlans,
    topology.forgeryPlans.map((item) => item.id),
    (item) => item?.id,
    "伪证文本",
    problems
  );

  const evidenceNames = [];
  for (const slot of topology.evidence) {
    const row = evidenceRows.get(slot.id);
    const name = safeString(row?.name, 24);
    const description = safeString(row?.description, 300);
    evidenceNames.push(name);
    if (!name) problems.push(`证据 ${slot.id} 没有名称`);
    if (description.length < MIN_EVIDENCE_DESCRIPTION) {
      problems.push(`证据 ${slot.id} 的描述过短`);
    }
    if (readableHasInternalId(`${name}${description}`)) {
      problems.push(`证据 ${slot.id} 的可读文本含有内部 id`);
    }
  }
  if (new Set(evidenceNames).size !== evidenceNames.length) {
    problems.push("真实证据名称必须互不相同");
  }

  for (const slot of topology.factEffects) {
    const reason = safeString(effectRows.get(slot.factPropId)?.reason, 200);
    if (reason.length < 12) {
      problems.push(`事实 ${slot.factPropId} 的影响理由过短`);
    }
    if (readableHasInternalId(reason)) {
      problems.push(`事实 ${slot.factPropId} 的影响理由含有内部 id`);
    }
  }

  const forgeryNames = [];
  const tellWords = /伪证|伪造|假证|捏造|编造|说谎|破绽|揭穿|凶手提供|凶手制造/;
  const personalSourceWords =
    /说辞|证言|口供|自述|提供者|提交者|(?:由|来自).{0,12}(?:提供|递交|提交)/;
  for (const slot of topology.forgeryPlans) {
    const row = forgeryRows.get(slot.id);
    const name = safeString(row?.name, 24);
    const description = safeString(row?.description, 300);
    const exposureText = safeString(row?.exposureText, 300);
    forgeryNames.push(name);
    if (!name) problems.push(`伪证方案 ${slot.id} 没有公开名称`);
    if (description.length < MIN_FORGERY_DESCRIPTION) {
      problems.push(`伪证方案 ${slot.id} 的公开描述过短`);
    }
    if (exposureText.length < MIN_EXPOSURE_TEXT) {
      problems.push(`伪证方案 ${slot.id} 的揭穿说明过短`);
    }
    if (tellWords.test(`${name}${description}`)) {
      problems.push(`伪证方案 ${slot.id} 的公开文本提前暴露性质`);
    }
    if (personalSourceWords.test(`${name}${description}`)) {
      problems.push(`伪证方案 ${slot.id} 的公开文本绑定了个人来源`);
    }
    if (readableHasInternalId(`${name}${description}${exposureText}`)) {
      problems.push(`伪证方案 ${slot.id} 的可读文本含有内部 id`);
    }
  }
  if (new Set(forgeryNames).size !== forgeryNames.length) {
    problems.push("伪证方案公开名称必须互不相同");
  }
  if (forgeryNames.some((name) => evidenceNames.includes(name))) {
    problems.push("伪证方案不能与真实证据重名");
  }

  return { ok: problems.length === 0, problems };
}

/**
 * 只合并三个允许 AI 填写的文本面；所有关系和目标仍取自 draft。
 */
export function mergeCaseText(draft, raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const evidenceRows = new Map(
    (source.evidence || []).map((item) => [safeString(item?.id, 40), item])
  );
  const effectRows = new Map(
    (source.factEffects || []).map((item) => [
      safeString(item?.factPropId, 40),
      item,
    ])
  );
  const forgeryRows = new Map(
    (source.forgeryPlans || []).map((item) => [safeString(item?.id, 40), item])
  );
  const merged = structuredClone(draft);

  for (const item of merged.evidence) {
    const row = evidenceRows.get(item.id);
    item.name = safeString(row?.name, 24);
    item.description = safeString(row?.description, 300);
  }
  for (const item of merged.factEffects) {
    const row = effectRows.get(item.factPropId);
    item.reason = safeString(row?.reason, 200);
  }
  for (const item of merged.forgeryPlans) {
    const row = forgeryRows.get(item.id);
    item.name = safeString(row?.name, 24);
    item.description = safeString(row?.description, 300);
    item.exposureText = safeString(row?.exposureText, 300);
  }
  return merged;
}
