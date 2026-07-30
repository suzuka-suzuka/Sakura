/**
 * 少女、案件档案的数据结构、归一化与校验
 *
 * AI 的输出一律先过这一层：截断超长字段、补全缺失项、丢弃悬空引用。
 * 案件档案额外要过一遍逻辑一致性校验——那才是这个游戏能不能玩的关键。
 *
 * 【真相的形式定义】
 *   证据全集 E，已公开集合 P ⊆ E，已明确建立的论证关系 L
 *   事实 F 成立：L 中至少有一条证据支持 F，且没有任何一条关系反驳 F
 *   事实效果 R：F 成立或被反驳时，按案件预设向结论产生一次间接支持或反驳
 *   结论 C 成立：直接证据与已激活事实效果达到门槛、至少有一条间接事实支持，
 *                且没有任何直接或间接反驳
 *   真相 T：不存在能够直接或间接反驳 T 的真实论证路径 —— 吸收态，证成即不可反驳
 *
 * 证物进入 P 只代表所有人都能看见和复用；它不会因此自动产生 L 中的关系。
 *
 * 「真相一旦被推出来就无法反驳」不是特殊规则，是这个定义的直接推论：
 * 想反驳真相就得掏出一条否定它的证据，而那条证据按定义不存在。
 */

/** 结论类型 */
export const VERDICT = {
  ACCUSE: "accuse",     // 指认某人
  SUICIDE: "suicide",   // 自杀
};

/**
 * 各类结论成立所需的支持论据数（直接证物 + 已激活事实效果）
 * 自杀门槛更高——它让全员存活，不能太好拿
 */
export const SUPPORT_THRESHOLD = {
  [VERDICT.ACCUSE]: 2,
  [VERDICT.SUICIDE]: 3,
};

/** 证据的获取途径 */
export const EVIDENCE_VIA = {
  SEARCH: "search", // 搜查某地点
  ASK: "ask",       // 询问某位少女
};

/** 事实处于哪种已判定状态时触发结论效果 */
export const FACT_EFFECT_WHEN = {
  ESTABLISHED: "established",
  REFUTED: "refuted",
};

/** 事实对结论产生的论证方向；与庭审出示方向使用相同字符串 */
export const FACT_EFFECT_STANCE = {
  SUPPORT: "support",
  REFUTE: "refute",
};

// ===== id 约定 =====
// 玩家 "p:<QQ>"，NPC "n:<拼音>"。统一成一种 id 后，少女、嫌疑值、投票、
// 指认目标都不用再分玩家和 NPC 两套代码路径。

export const toPlayerId = (userId) => `p:${userId}`;
export const toNpcId = (slug) => `n:${slug}`;
export const isPlayerId = (id) => String(id || "").startsWith("p:");
export const userIdOf = (id) => String(id || "").slice(2);

// ===== 通用工具 =====

export function safeString(value, maxLength = 400) {
  return String(value ?? "")
    .trim()
    .slice(0, maxLength);
}

export function safeInt(value, { min = 0, max = 999, fallback = 0 } = {}) {
  const num = Math.round(Number(value));
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

export function normalizeStringArray(value, { limit = 8, maxLength = 120 } = {}) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => safeString(item, maxLength))
    .filter(Boolean)
    .slice(0, limit);
}

/**
 * 从 AI 回复里抠出 JSON 对象
 * 依次尝试：代码围栏内容 → 首尾大括号之间 → 整段文本
 */
export function extractJson(text) {
  const source = String(text || "").trim();
  if (!source) return null;

  const candidates = [];
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1]);

  const firstBrace = source.indexOf("{");
  const lastBrace = source.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(source.slice(firstBrace, lastBrace + 1));
  }
  candidates.push(source);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // 换下一个候选
    }
  }
  return null;
}

function slugId(value, fallback) {
  const text = safeString(value, 40).replace(/\s+/g, "_");
  return text || fallback;
}

// ===== 牢狱 =====

/** 地点代号：A、B、C…… 打字比中文名快，也不会因为模糊匹配选错 */
const LOCATION_CODES = "ABCDEFGHIJ";

export function normalizePrison(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const usedLocationIds = new Set();

  const locations = (Array.isArray(source.locations) ? source.locations : [])
    .slice(0, LOCATION_CODES.length)
    .map((item, index) => {
      const baseId = slugId(item?.id, `loc_${index + 1}`);
      let id = baseId;
      let suffix = 2;
      while (usedLocationIds.has(id)) id = `${baseId}_${suffix++}`;
      usedLocationIds.add(id);
      return {
        id,
        code: LOCATION_CODES[index],
        name: safeString(item?.name, 20) || `区域${index + 1}`,
        description: safeString(item?.description, 300),
      };
    })
    .filter((item) => item.name);

  return {
    name: safeString(source.name, 30) || "孤岛牢狱",
    intro: safeString(source.intro, 1200),
    warden: safeString(source.warden, 200) || "一只会说话的猫头鹰，自称典狱长。",
    rules: normalizeStringArray(source.rules, { limit: 8, maxLength: 120 }),
    locations,
  };
}

// ===== 少女 =====

/**
 * 魔法能力写成结构化规则而不是数值
 * 它既是完整犯罪方案的可能性，也是被指控的理由——这是「设定系本格」的落点。
 * 方案可行性因此是集合运算，不是掷骰，AI 无从干预。
 */
function normalizeAbility(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    name: safeString(source.name, 20) || "无名之力",
    can: normalizeStringArray(source.can, { limit: 4, maxLength: 40 }),
    limit: safeString(source.limit, 100) || "（无明确限制）",
  };
}

export function normalizeGirl(raw, { id, kind, userId } = {}) {
  const source = raw && typeof raw === "object" ? raw : {};

  return {
    id: String(id ?? source.id ?? ""),
    code: "", // 囚犯编号，全员生成完后由 assignPrisonerCodes 统一分配
    kind: kind === "player" ? "player" : "npc",
    userId: kind === "player" ? String(userId ?? "") : "",
    name: safeString(source.name, 20) || "无名少女",
    age: safeInt(source.age, { min: 12, max: 19, fallback: 16 }),
    appearance: safeString(source.appearance, 200),
    profile: safeString(source.profile, 500),
    ability: normalizeAbility(source.ability),
    // 秘密只用于处刑叙事，不参与庭审嫌疑值。
    secret: safeString(source.secret, 200) || "（无）",
    secretExposed: false,
    suspicion: 0,
    alive: true,
    fate: "", // "" | "victim" | "executed"
  };
}

/**
 * 分配囚犯编号 001、002……
 *
 * 按姓名排序而不是按玩家/NPC 分段：分段的话编号本身就泄露了谁是玩家。
 * 图鉴不会标出角色归属，编号本身也不能留下真人先写入的痕迹。
 */
export function assignPrisonerCodes(girls) {
  Object.values(girls)
    .sort((a, b) => a.name.localeCompare(b.name, "zh"))
    .forEach((girl, index) => {
      girl.code = String(index + 1).padStart(3, "0");
    });
  return girls;
}

/**
 * 囚犯编号是所有公开名册唯一允许使用的排序依据。
 *
 * 不能依赖对象的写入顺序：开局生成时真人会先写入 girls，NPC 后写入，
 * 直接 Object.values() 就会把「谁是真人」悄悄排在最前面。
 */
export function comparePrisonerCode(a, b) {
  const codeA = Number.parseInt(String(a?.code || ""), 10);
  const codeB = Number.parseInt(String(b?.code || ""), 10);
  const hasCodeA = Number.isFinite(codeA);
  const hasCodeB = Number.isFinite(codeB);

  if (hasCodeA && hasCodeB && codeA !== codeB) return codeA - codeB;
  if (hasCodeA !== hasCodeB) return hasCodeA ? -1 : 1;

  return (
    String(a?.name || "").localeCompare(String(b?.name || ""), "zh") ||
    String(a?.id || "").localeCompare(String(b?.id || ""))
  );
}

/** 返回按 001、002……排列的新数组，不改动原始对象。 */
export function girlsByPrisonerCode(girls) {
  return Object.values(girls || {}).sort(comparePrisonerCode);
}

/** 按编号找人，找不到返回 null。接受 001 / 1 / #001 各种写法 */
export function girlByCode(session, text) {
  const match = String(text || "").trim().match(/^#?(\d{1,3})$/);
  if (!match) return null;
  const code = String(Number(match[1])).padStart(3, "0");
  return Object.values(session.girls || {}).find((girl) => girl.code === code) || null;
}

/** 按代号找地点，接受大小写 */
export function locationByCode(session, text) {
  const match = String(text || "").trim().match(/^([A-Za-z])$/);
  if (!match) return null;
  const code = match[1].toUpperCase();
  return (session.prison?.locations || []).find((item) => item.code === code) || null;
}

/**
 * 这位少女的能力能不能完成本案里不可缺少的魔法部分
 *
 * 这是纯集合运算，不掷骰也不问 AI——「设定系本格」的判定基础。
 * 注意它只表示「没被排除」，不表示「有嫌疑」：做得到不等于做了。
 */
function canUseAbilities(girl, required = []) {
  if (!required.length) return true;
  const owned = [girl?.ability?.name, ...(girl?.ability?.can || [])].filter(Boolean);
  return required.every((need) =>
    owned.some((have) => have.includes(need) || need.includes(have))
  );
}

function abilityTextsOverlap(left, right) {
  const a = String(left ?? "").trim();
  const b = String(right ?? "").trim();
  return Boolean(a && b && (a.includes(b) || b.includes(a)));
}

export function canPerformMethod(girl, caseFile) {
  const required = caseFile?.method?.requiredAbilities || [];
  // 普通的致死动作或不依赖魔法的方案对所有人开放。
  return canUseAbilities(girl, required);
}

/** 取全部少女。公开与内部统一按囚犯编号，绝不按真人/NPC 分段。 */
export function listGirls(session) {
  return girlsByPrisonerCode(session.girls);
}

export function girlOf(session, id) {
  return session.girls?.[String(id)] || null;
}

export function girlOfUser(session, userId) {
  return session.girls?.[toPlayerId(userId)] || null;
}

/** 还在场上的少女：既没被杀，也没被处刑 */
export function livingGirls(session) {
  return listGirls(session).filter((girl) => girl.alive);
}

export function livingPlayers(session) {
  return livingGirls(session).filter((girl) => girl.kind === "player");
}

// ===== 案件档案 =====

function normalizeProposition(raw, index) {
  const source = raw && typeof raw === "object" ? raw : {};

  let conclusion = null;
  const rawConclusion = source.conclusion;
  if (rawConclusion && typeof rawConclusion === "object") {
    const type = safeString(rawConclusion.type, 12);
    if (Object.values(VERDICT).includes(type)) {
      conclusion = {
        type,
        targetId: type === VERDICT.ACCUSE ? safeString(rawConclusion.targetId, 40) : "",
      };
    }
  }

  return {
    id: slugId(source.id, `p_${index + 1}`),
    text: safeString(source.text, 120),
    conclusion,
  };
}

function normalizeEvidence(raw, index) {
  const source = raw && typeof raw === "object" ? raw : {};
  const via = source.via === EVIDENCE_VIA.ASK ? EVIDENCE_VIA.ASK : EVIDENCE_VIA.SEARCH;

  return {
    id: slugId(source.id, `e_${index + 1}`),
    name: safeString(source.name, 24) || `证物${index + 1}`,
    description: safeString(source.description, 300),
    via,
    location: via === EVIDENCE_VIA.SEARCH ? slugId(source.location, "") : "",
    askTarget: via === EVIDENCE_VIA.ASK ? safeString(source.askTarget, 40) : "",
    supports: normalizeStringArray(source.supports, { limit: 6, maxLength: 40 }),
    refutes: normalizeStringArray(source.refutes, { limit: 6, maxLength: 40 }),
    // 运行时证物的内部字段；普通案件证据一律保持为空
    fake: false,
    flawOf: "",
    forgedById: "",
    forgeryPlanId: "",
    exposureText: "",
    reservedFor: "", // 本地分配给真人的调查线索，AI 不得指定
  };
}

function normalizeForgeryPlan(raw, index) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    id: slugId(source.id, `fp_${index + 1}`),
    targetPropId: slugId(source.targetPropId, ""),
    name: safeString(source.name, 24),
    description: safeString(source.description, 300),
    flawEvidenceId: slugId(source.flawEvidenceId, ""),
    exposureText: safeString(source.exposureText, 300),
  };
}

function normalizeFactEffect(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    factPropId: slugId(source.factPropId, ""),
    when:
      source.when === FACT_EFFECT_WHEN.REFUTED
        ? FACT_EFFECT_WHEN.REFUTED
        : FACT_EFFECT_WHEN.ESTABLISHED,
    conclusionPropId: slugId(source.conclusionPropId, ""),
    stance:
      source.stance === FACT_EFFECT_STANCE.REFUTE
        ? FACT_EFFECT_STANCE.REFUTE
        : FACT_EFFECT_STANCE.SUPPORT,
    reason: safeString(source.reason, 200),
  };
}

export function normalizeCase(raw, { chapter = 1 } = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const methodSource =
    source.method && typeof source.method === "object" ? source.method : {};
  const misdirectionSource =
    methodSource.misdirection && typeof methodSource.misdirection === "object"
      ? methodSource.misdirection
      : null;
  const misdirection = misdirectionSource
    ? {
        description: safeString(misdirectionSource.description, 500),
        apparentAbility: safeString(misdirectionSource.apparentAbility, 40),
        targetId: safeString(misdirectionSource.targetId, 40),
      }
    : null;
  const normalizedMisdirection =
    misdirection &&
    (misdirection.description || misdirection.apparentAbility || misdirection.targetId)
      ? misdirection
      : null;
  const causeOfDeath = safeString(methodSource.causeOfDeath, 160);
  const killingAction = safeString(methodSource.killingAction, 300);
  const magicRole = safeString(methodSource.magicRole, 300);
  const methodDescription =
    safeString(methodSource.description, 500) ||
    [causeOfDeath, killingAction, magicRole, normalizedMisdirection?.description]
      .filter(Boolean)
      .join("；");

  const propositions = (Array.isArray(source.propositions) ? source.propositions : [])
    .slice(0, 16)
    .map(normalizeProposition)
    .filter((item) => item.text);

  const evidence = (Array.isArray(source.evidence) ? source.evidence : [])
    .slice(0, 20)
    .map(normalizeEvidence)
    .filter((item) => item.description);

  const forgeryPlans = (Array.isArray(source.forgeryPlans) ? source.forgeryPlans : [])
    .slice(0, 12)
    .map(normalizeForgeryPlan)
    .filter((item) => item.name && item.description);

  const factEffects = (Array.isArray(source.factEffects) ? source.factEffects : [])
    .slice(0, 40)
    .map(normalizeFactEffect);

  // 悬空引用直接剪掉，后面的逻辑层就不用到处判空
  const propIds = new Set(propositions.map((item) => item.id));
  for (const item of evidence) {
    item.supports = item.supports.filter((id) => propIds.has(id));
    item.refutes = item.refutes.filter((id) => propIds.has(id));
  }

  return {
    chapter: safeInt(chapter, { min: 1, max: 20, fallback: 1 }),
    victimId: safeString(source.victimId, 40),
    culpritId: safeString(source.culpritId, 40),
    truthId: slugId(source.truthId, ""),
    discovery: {
      location: slugId(source.discovery?.location, ""),
      time: safeString(source.discovery?.time, 40),
      body: safeString(source.discovery?.body, 400),
      finder: safeString(source.discovery?.finder, 40),
    },
    method: {
      causeOfDeath,
      killingAction,
      magicRole,
      misdirection: normalizedMisdirection,
      description: methodDescription,
      requiredAbilities: normalizeStringArray(methodSource.requiredAbilities, {
        limit: 4,
        maxLength: 20,
      }),
    },
    // 动机纯属叙事层：不进证据表、不参与任何判定，只在处刑前被讲出来。
    // 放进逻辑层会污染已经校验过的案件结构，而且「有动机」本来也不该等于「是凶手」。
    motive: {
      trigger: safeString(source.motive?.trigger, 200),
      backstory: safeString(source.motive?.backstory, 600),
      confession: safeString(source.motive?.confession, 300),
    },
    propositions,
    evidence,
    // 事实只有在被证实或反驳后才激活这些效果；公开界面只展示已经激活的关系
    factEffects,
    // 仅供服务器在凶手发动能力时选用；公开案件视图和叙事 AI 均看不到
    forgeryPlans,
    // NPC 凶手的行动排程本地生成，不来自 AI
    witchPlan: [],
  };
}

/** 全部结论型命题 */
export function conclusionsOf(caseFile) {
  return (caseFile?.propositions || []).filter((item) => item.conclusion);
}

export function propositionOf(caseFile, propId) {
  return (caseFile?.propositions || []).find((item) => item.id === propId) || null;
}

/**
 * 玩家当前是否可以把证据直接打向某个命题。
 *
 * 事实命题始终可以举证；结论必须先经过一次正式主张，并等主张所在回合
 * 结算后才开放。回应追问只是被迫表态，不会替结论开题。
 */
export function canPresentEvidenceOn(session, propId) {
  const prop = propositionOf(session?.caseFile, propId);
  if (!prop) return false;
  if (!prop.conclusion) return true;

  const currentRound = Number(session?.round);
  return (session?.claims || []).some((claim) => {
    if (
      claim.chapter !== session.chapter ||
      claim.propId !== propId ||
      claim.opensEvidence !== true
    ) {
      return false;
    }
    return Number(claim.round) <= currentRound;
  });
}

export function evidenceOf(caseFile, evidenceId) {
  return (caseFile?.evidence || []).find((item) => item.id === evidenceId) || null;
}

/** 一件证物按哪个方向打向事实，才能触发指定的事实效果 */
export function evidenceActivatesFactEffect(evidence, effect) {
  if (!evidence || !effect?.factPropId) return false;
  return effect.when === FACT_EFFECT_WHEN.REFUTED
    ? (evidence.refutes || []).includes(effect.factPropId)
    : (evidence.supports || []).includes(effect.factPropId);
}

/** 一件真实证物是否存在直接或经由事实支持某个结论的路径 */
export function evidenceCanSupportConclusion(caseFile, evidence, conclusionPropId) {
  if (!evidence) return false;
  if ((evidence.supports || []).includes(conclusionPropId)) return true;
  return (caseFile?.factEffects || []).some(
    (effect) =>
      effect.conclusionPropId === conclusionPropId &&
      effect.stance === FACT_EFFECT_STANCE.SUPPORT &&
      evidenceActivatesFactEffect(evidence, effect)
  );
}

/**
 * 案件档案的一致性校验
 *
 * 这四条是「总得有个真相」在工程上的落点。不过就打回让 AI 重生成——
 * 我们不需要 AI 写出一个好推理，只需要它随机吐结构，本地筛掉不自洽的。
 *
 * @param {object} caseFile 归一化后的案件档案
 * @param {object} context { girls: 全体少女, locationIds: 牢狱地点 id 集合 }
 */
export function validateCase(caseFile, { girls = {}, locationIds = [] } = {}) {
  const problems = [];
  const { propositions, evidence, factEffects, forgeryPlans } = caseFile;
  const duplicates = (values) => {
    const seen = new Set();
    return [...new Set(values.filter((value) => {
      if (seen.has(value)) return true;
      seen.add(value);
      return false;
    }))];
  };

  const duplicateProps = duplicates(propositions.map((item) => item.id));
  const duplicateEvidence = duplicates(evidence.map((item) => item.id));
  const duplicateFactEffects = duplicates(
    factEffects.map(
      (item) => `${item.factPropId}|${item.when}|${item.conclusionPropId}`
    )
  );
  const duplicateForgeryPlans = duplicates(forgeryPlans.map((item) => item.id));
  const duplicateForgeryNames = duplicates(forgeryPlans.map((item) => item.name));
  const duplicateLocations = duplicates(locationIds);
  if (duplicateProps.length) problems.push(`命题 id 重复：${duplicateProps.join("、")}`);
  if (duplicateEvidence.length) problems.push(`证据 id 重复：${duplicateEvidence.join("、")}`);
  if (duplicateFactEffects.length) {
    problems.push(`同一事实状态对同一结论配置了多个效果：${duplicateFactEffects.join("、")}`);
  }
  if (duplicateForgeryPlans.length) {
    problems.push(`伪证方案 id 重复：${duplicateForgeryPlans.join("、")}`);
  }
  if (duplicateForgeryNames.length) {
    problems.push(`伪证方案公开名称重复：${duplicateForgeryNames.join("、")}`);
  }
  if (duplicateLocations.length) problems.push(`地点 id 重复：${duplicateLocations.join("、")}`);

  // --- 结构完整性 ---
  const truth = propositionOf(caseFile, caseFile.truthId);
  if (!truth) {
    problems.push("truthId 不指向任何命题");
    return { ok: false, problems }; // 真相都没有，后面几条没法查
  }
  if (!truth.conclusion) {
    problems.push("真相不是一个结论型命题");
    return { ok: false, problems };
  }

  const conclusions = conclusionsOf(caseFile);
  const facts = propositions.filter((item) => !item.conclusion);
  if (conclusions.length < 3) problems.push("候选结论少于 3 个");
  if (propositions.length < 6) problems.push("命题少于 6 条");
  if (evidence.length < 10) problems.push("证据少于 10 条");

  const invalidConclusionTypes = conclusions.filter(
    (item) =>
      item.conclusion.type !== VERDICT.ACCUSE &&
      item.conclusion.type !== VERDICT.SUICIDE
  );
  if (invalidConclusionTypes.length) {
    problems.push(
      `结论类型只能是指认或自杀，不能生成：${[
        ...new Set(invalidConclusionTypes.map((item) => item.conclusion.type)),
      ].join("、")}`
    );
  }

  const suicideConclusions = conclusions.filter(
    (item) => item.conclusion.type === VERDICT.SUICIDE
  );
  if (suicideConclusions.length !== 1) {
    problems.push(`suicide 结论必须恰好 1 条，当前为 ${suicideConclusions.length} 条`);
  }

  const accusationTargets = conclusions
    .filter((item) => item.conclusion.type === VERDICT.ACCUSE)
    .map((item) => item.conclusion.targetId);
  const duplicateTargets = duplicates(accusationTargets);
  if (duplicateTargets.length) {
    problems.push(`多个指认结论指向同一人：${duplicateTargets.join("、")}`);
  }

  if (!girls[caseFile.victimId]) problems.push("死者不在少女名册里");
  else if (!girls[caseFile.victimId].alive) problems.push("死者在本章开始前已经退场");
  if (!girls[caseFile.culpritId]) problems.push("凶手不在少女名册里");
  else if (
    caseFile.culpritId !== caseFile.victimId &&
    !girls[caseFile.culpritId].alive
  ) {
    problems.push("凶手在本章开始前已经退场");
  }

  // 真相与凶手必须对得上，否则处刑结算会自相矛盾
  if (truth.conclusion.type === VERDICT.ACCUSE) {
    if (truth.conclusion.targetId !== caseFile.culpritId) {
      problems.push("真相指认的人不是档案里的凶手");
    }
  } else if (truth.conclusion.type === VERDICT.SUICIDE) {
    if (caseFile.culpritId !== caseFile.victimId) {
      problems.push("真相是自杀，但档案里的凶手不是死者本人");
    }
  } else {
    problems.push("真相只能是指认或自杀");
  }

  // 指认型结论的对象必须是在场的人，且不能指认死者
  for (const item of conclusions) {
    if (item.conclusion.type !== VERDICT.ACCUSE) continue;
    const target = girls[item.conclusion.targetId];
    if (!target) problems.push(`结论「${item.text}」指认了名册外的人`);
    else if (item.conclusion.targetId === caseFile.victimId) {
      problems.push(`结论「${item.text}」指认了死者本人`);
    } else if (!target.alive) {
      problems.push(`结论「${item.text}」指认了前几章已经退场的人`);
    }
  }

  // --- 事实到结论的推理链 ---

  const conclusionIds = new Set(conclusions.map((item) => item.id));
  const factIds = new Set(facts.map((item) => item.id));
  const internalCaseIds = [
    ...propositions.map((item) => item.id),
    ...evidence.map((item) => item.id),
  ].filter((id) => id.length >= 3);
  const triggerEvidence = (effect) =>
    evidence.filter((item) => evidenceActivatesFactEffect(item, effect));

  for (const effect of factEffects) {
    const fact = propositionOf(caseFile, effect.factPropId);
    const conclusion = propositionOf(caseFile, effect.conclusionPropId);
    if (!factIds.has(effect.factPropId) || !fact || fact.conclusion) {
      problems.push(`事实效果引用了不存在或并非事实的命题：${effect.factPropId}`);
    }
    if (!conclusionIds.has(effect.conclusionPropId) || !conclusion?.conclusion) {
      problems.push(`事实效果没有指向候选结论：${effect.conclusionPropId}`);
    }
    if (effect.reason.length < 12) {
      problems.push(
        `事实「${fact?.text || effect.factPropId}」对结论的影响理由过短`
      );
    }
    if (/girl_\d+/i.test(effect.reason)) {
      problems.push(
        `事实「${fact?.text || effect.factPropId}」的影响理由含有匿名少女 id`
      );
    }
    if (
      internalCaseIds.some((id) => effect.reason.includes(id)) ||
      /正确答案|错误答案|真相结论|真正的凶手|实际凶手|隐藏动机|真实手法|未公开(?:证物|证据|内幕)/.test(
        effect.reason
      )
    ) {
      problems.push(
        `事实「${fact?.text || effect.factPropId}」的影响理由泄露了内部答案或结构信息`
      );
    }

    const triggers = triggerEvidence(effect);
    if (!triggers.length) {
      problems.push(
        `事实「${fact?.text || effect.factPropId}」处于 ${effect.when} 时的效果没有任何证物可以触发`
      );
    }

    // 同一件证物不能既直接作用于结论，又通过它证明的事实重复贡献同方向论据。
    const duplicatedProvenance = triggers.filter((item) => {
      const direct =
        effect.stance === FACT_EFFECT_STANCE.SUPPORT
          ? item.supports
          : item.refutes;
      return direct.includes(effect.conclusionPropId);
    });
    if (duplicatedProvenance.length) {
      problems.push(
        `证物「${duplicatedProvenance.map((item) => item.name).join("、")}」会对结论「${conclusion?.text || effect.conclusionPropId}」直接和间接重复计数`
      );
    }
  }

  for (const fact of facts) {
    if (!factEffects.some((effect) => effect.factPropId === fact.id)) {
      problems.push(`事实「${fact.text}」不会影响任何结论，属于无效推理支线`);
    }
  }

  for (const fact of facts) {
    for (const conclusion of conclusions) {
      const pair = factEffects.filter(
        (effect) =>
          effect.factPropId === fact.id &&
          effect.conclusionPropId === conclusion.id
      );
      if (
        pair.length === 2 &&
        pair[0].when !== pair[1].when &&
        pair[0].stance === pair[1].stance
      ) {
        problems.push(
          `事实「${fact.text}」无论成立还是被反驳都${pair[0].stance === FACT_EFFECT_STANCE.SUPPORT ? "支持" : "反驳"}同一结论，状态没有推理意义`
        );
      }
    }
  }

  // --- 四条逻辑校验 ---

  // 1. 真相既不能被证物直接否定，也不能被事实状态间接否定。
  const refutesTruth = evidence.filter((item) => item.refutes.includes(truth.id));
  if (refutesTruth.length) {
    problems.push(
      `有证据否定了真相：${refutesTruth.map((item) => item.name).join("、")}`
    );
  }
  const effectsRefutingTruth = factEffects.filter(
    (effect) =>
      effect.conclusionPropId === truth.id &&
      effect.stance === FACT_EFFECT_STANCE.REFUTE
  );
  if (effectsRefutingTruth.length) {
    problems.push("有事实状态能够间接反驳真相");
  }

  // 2. 唯一解：每个非真相结论至少有一条直接或间接反驳路径。
  //    否则案子有二义性，玩家推到一半会发现怎么都对
  for (const item of conclusions) {
    if (item.id === truth.id) continue;
    const hasDirectRefute = evidence.some((e) => e.refutes.includes(item.id));
    const hasIndirectRefute = factEffects.some(
      (effect) =>
        effect.conclusionPropId === item.id &&
        effect.stance === FACT_EFFECT_STANCE.REFUTE &&
        triggerEvidence(effect).length > 0
    );
    if (!hasDirectRefute && !hasIndirectRefute) {
      problems.push(`结论「${item.text}」没有可触发的直接或间接反驳路径，案件有二义性`);
    }
  }

  // 3. 每条证据都可达
  const validLocations = new Set(locationIds);
  if (!validLocations.has(caseFile.discovery.location)) {
    problems.push("尸体发现地点不存在");
  }
  const finder = girls[caseFile.discovery.finder];
  if (!finder || !finder.alive || finder.id === caseFile.victimId) {
    problems.push("第一发现者不是仍在场的少女");
  }
  for (const item of evidence) {
    if (!item.supports.length && !item.refutes.length) {
      problems.push(`证据「${item.name}」不支持也不否定任何命题`);
    }
    const contradictions = item.supports.filter((id) => item.refutes.includes(id));
    if (contradictions.length) {
      problems.push(`证据「${item.name}」同时支持并否定同一命题`);
    }
    if (item.via === EVIDENCE_VIA.SEARCH) {
      if (!validLocations.has(item.location)) {
        problems.push(`证据「${item.name}」挂在不存在的地点上`);
      }
    } else if (!girls[item.askTarget]) {
      problems.push(`证据「${item.name}」要问一个名册外的人`);
    } else if (item.askTarget === caseFile.victimId) {
      // 死者在校验这一刻还是 alive（她要到案件生成完才退场），得单独挡
      problems.push(`证据「${item.name}」要问死者本人，永远问不到`);
    } else if (!girls[item.askTarget].alive) {
      problems.push(`证据「${item.name}」要问一个前几章已经退场的人`);
    }
  }

  const searchEvidence = evidence.filter((item) => item.via === EVIDENCE_VIA.SEARCH);
  const askEvidence = evidence.filter((item) => item.via === EVIDENCE_VIA.ASK);
  if (searchEvidence.length < 3) problems.push("可搜查证据少于 3 条");
  if (askEvidence.length < 3) problems.push("可询问证言少于 3 条");
  if (new Set(searchEvidence.map((item) => item.location)).size < 3) {
    problems.push("可搜查证据没有分布到至少 3 个地点");
  }
  if (new Set(askEvidence.map((item) => item.askTarget)).size < 2) {
    problems.push("可询问证言没有分布到至少 2 位少女");
  }

  // 4. 每一个候选结论都必须真的有机会通过“证物 → 事实 → 结论”成立。
  for (const item of conclusions) {
    const directSupports = evidence.filter((e) => e.supports.includes(item.id)).length;
    const indirectSupports = factEffects.filter(
      (effect) =>
        effect.conclusionPropId === item.id &&
        effect.stance === FACT_EFFECT_STANCE.SUPPORT &&
        triggerEvidence(effect).length > 0
    ).length;
    const supports = directSupports + indirectSupports;
    const threshold = SUPPORT_THRESHOLD[item.conclusion.type];
    if (!indirectSupports) {
      problems.push(`结论「${item.text}」没有任何可触发的间接事实支持`);
    }
    if (supports < threshold) {
      problems.push(
        `支持结论「${item.text}」的潜在论据只有 ${supports} 条（直接 ${directSupports}、间接事实 ${indirectSupports}），不足 ${threshold} 条`
      );
    }
  }

  // 伪证不是玩家临场输入的一段无根说辞，而是案件档案里预先写好的可核验假线索。
  // 每个候选结论各有一套方案；它表面上反驳目标结论，指定的真实证据则能揭穿它。
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const tellWords = /伪证|伪造|假证|捏造|编造|说谎|破绽|揭穿|凶手提供|凶手制造/;
  const personalSourceWords =
    /说辞|证言|口供|自述|提供者|提交者|(?:由|来自).{0,12}(?:提供|递交|提交)/;
  if (forgeryPlans.length !== conclusions.length) {
    problems.push(
      `伪证方案必须与候选结论一一对应，当前有 ${forgeryPlans.length} 套方案、${conclusions.length} 个结论`
    );
  }
  for (const conclusion of conclusions) {
    const matches = forgeryPlans.filter((item) => item.targetPropId === conclusion.id);
    if (matches.length !== 1) {
      problems.push(`结论「${conclusion.text}」必须恰好有 1 套伪证方案`);
    }
  }
  for (const plan of forgeryPlans) {
    if (!conclusionIds.has(plan.targetPropId)) {
      problems.push(`伪证方案「${plan.id}」没有指向候选结论`);
    }
    const flaw = evidenceOf(caseFile, plan.flawEvidenceId);
    if (!evidenceIds.has(plan.flawEvidenceId) || !flaw) {
      problems.push(`伪证方案「${plan.id}」的破绽证据不存在`);
    } else if (!evidenceCanSupportConclusion(caseFile, flaw, plan.targetPropId)) {
      problems.push(`伪证方案「${plan.id}」的破绽证据没有直接或间接支持其目标结论的路径`);
    }
    if (plan.description.length < 40) {
      problems.push(`伪证方案「${plan.id}」的公开描述过短，无法作为可推理证物`);
    }
    if (plan.exposureText.length < 20) {
      problems.push(`伪证方案「${plan.id}」没有写清证物间的矛盾`);
    }
    if (tellWords.test(`${plan.name}${plan.description}`)) {
      problems.push(`伪证方案「${plan.id}」的公开文本提前暴露了伪造性质`);
    }
    if (personalSourceWords.test(`${plan.name}${plan.description}`)) {
      problems.push(`伪证方案「${plan.id}」的公开文本绑定了个人说辞或提供者`);
    }
    if (/girl_\d+/i.test(`${plan.name}${plan.description}${plan.exposureText}`)) {
      problems.push(`伪证方案「${plan.id}」的可读文本含有匿名少女 id`);
    }
    if (evidence.some((item) => item.name === plan.name)) {
      problems.push(`伪证方案「${plan.id}」与真实证据重名`);
    }
  }

  const requiredAbilities = caseFile.method?.requiredAbilities || [];
  if (requiredAbilities.length) {
    // 只校验完整方案中不可缺少的魔法部分；普通杀人动作本身不需要能力证明。
    const culprit = girls[caseFile.culpritId];
    if (culprit && !canPerformMethod(culprit, caseFile)) {
      problems.push(
        `完整犯罪方案需要「${requiredAbilities.join("、")}」，但凶手的能力做不到`
      );
    }

    // 能力可以缩小范围，但不能单独念出凶手的名字。
    const candidates = Object.values(girls).filter(
      (girl) => girl.alive && girl.id !== caseFile.victimId && canPerformMethod(girl, caseFile)
    );
    const inPlay = Object.values(girls).filter(
      (girl) => girl.alive && girl.id !== caseFile.victimId
    ).length;

    if (candidates.length < 2) {
      problems.push(
        `完整犯罪方案只有 ${candidates.length} 个人能完成，玩家推断出能力后会直接锁定凶手`
      );
    } else if (inPlay >= 4 && candidates.length > Math.ceil(inPlay * 0.6)) {
      problems.push(
        `完整犯罪方案有 ${candidates.length}/${inPlay} 人能完成，范围太宽，能力筛选失去意义`
      );
    }
  }

  const misdirection = caseFile.method?.misdirection;
  if (misdirection) {
    const { description, apparentAbility, targetId } = misdirection;
    if (!description) problems.push("魔法误导没有写清假象与真实替代手段");
    if (!apparentAbility) problems.push("魔法误导没有填写表面上必需的能力");
    if (!targetId) problems.push("魔法误导没有填写被嫁祸者");

    const target = targetId ? girls[targetId] : null;
    if (targetId && !target) {
      problems.push(`魔法误导指向名册外的人：${targetId}`);
    } else if (targetId === caseFile.victimId) {
      problems.push("魔法误导不能嫁祸给死者");
    } else if (targetId === caseFile.culpritId) {
      problems.push("魔法误导不能把凶手本人当作被嫁祸者");
    } else if (target && !target.alive) {
      problems.push(`魔法误导指向前几章已经退场的人：${targetId}`);
    }

    if (target && apparentAbility && !canUseAbilities(target, [apparentAbility])) {
      problems.push(
        `魔法误导声称「${targetId}」拥有「${apparentAbility}」，但其公开能力并不匹配`
      );
    }
    if (
      apparentAbility &&
      requiredAbilities.some((actualAbility) =>
        abilityTextsOverlap(actualAbility, apparentAbility)
      )
    ) {
      problems.push(
        `魔法误导中的「${apparentAbility}」也是实际作案所需能力，不构成错误前提`
      );
    }

    const hasFramedConclusion =
      targetId &&
      conclusions.some(
        (item) =>
          item.conclusion?.type === VERDICT.ACCUSE &&
          item.conclusion.targetId === targetId
      );
    if (targetId && !hasFramedConclusion) {
      problems.push(`魔法误导指向「${targetId}」，但没有对应的错误指认结论`);
    }
  }

  return { ok: problems.length === 0, problems };
}

// ===== 提示词用的压缩视图 =====

/** 少女的公开视图：所有人都能看到的部分 */
export function publicGirlView(girl) {
  return {
    id: girl.code ? `girl_${girl.code}` : "girl_unknown",
    姓名: girl.name,
    能力: `${girl.ability.name}（${girl.ability.can.join("、") || "未知"}；限制：${girl.ability.limit}）`,
    嫌疑值: girl.suspicion,
    状态: girl.alive ? "在场" : girl.fate === "victim" ? "已死亡" : "已处刑",
  };
}

/** 案件的公开视图：不含真相、不含未公开证据 */
export function publicCaseView(caseFile, publicEvidenceIds = []) {
  const shown = new Set(publicEvidenceIds);
  return {
    章: caseFile.chapter,
    死者: caseFile.victimId,
    发现: caseFile.discovery,
    命题: caseFile.propositions.map((item) => ({
      id: item.id,
      内容: item.text,
      是否结论: item.conclusion ? item.conclusion.type : "否",
    })),
    已公开证据: caseFile.evidence
      .filter((item) => shown.has(item.id))
      .map((item) => ({ id: item.id, 名称: item.name, 描述: item.description })),
  };
}
