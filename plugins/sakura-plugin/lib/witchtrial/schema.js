/**
 * 少女、案件档案的数据结构、归一化与校验
 *
 * AI 的输出一律先过这一层：截断超长字段、补全缺失项、丢弃悬空引用。
 * 案件档案额外要过一遍逻辑一致性校验——那才是这个游戏能不能玩的关键。
 *
 * 【真相的形式定义】
 *   证据全集 E，已公开集合 P ⊆ E
 *   结论 C 成立：∃ 足够多 e ∈ P 使 C ∈ e.supports，且 ∄ e ∈ P 使 C ∈ e.refutes
 *   真相 T：∄ e ∈ E 使 T ∈ e.refutes            —— 吸收态，证成即不可反驳
 *   假结论 F：∃ e ∈ E 使 F ∈ e.refutes，但那条 e 未必在 P 里 —— 不稳定态
 *
 * 「真相一旦被推出来就无法反驳」不是特殊规则，是这个定义的直接推论：
 * 想反驳真相就得掏出一条否定它的证据，而那条证据按定义不存在。
 */

/** 结论类型 */
export const VERDICT = {
  ACCUSE: "accuse",     // 指认某人
  SUICIDE: "suicide",   // 自杀
  ACCIDENT: "accident", // 意外
};

/**
 * 各类结论成立所需的支持证据条数
 * 自杀/意外门槛更高——它让全员存活，不能太好拿
 */
export const SUPPORT_THRESHOLD = {
  [VERDICT.ACCUSE]: 2,
  [VERDICT.SUICIDE]: 3,
  [VERDICT.ACCIDENT]: 3,
};

/** 证据的获取途径 */
export const EVIDENCE_VIA = {
  SEARCH: "search", // 搜查某地点
  ASK: "ask",       // 询问某位少女
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
 * 它既是作案手法的可能性，也是被指控的理由——这是「设定系本格」的落点。
 * 手法可行性因此是集合运算，不是掷骰，AI 无从干预。
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
 * 这位少女的能力能不能做到本案的手法
 *
 * 这是纯集合运算，不掷骰也不问 AI——「设定系本格」的判定基础。
 * 注意它只表示「没被排除」，不表示「有嫌疑」：做得到不等于做了。
 */
export function canPerformMethod(girl, caseFile) {
  const required = caseFile?.method?.requiredAbilities || [];
  if (!required.length) return true; // 手法没要求特殊能力，人人都做得到

  const owned = [girl?.ability?.name, ...(girl?.ability?.can || [])].filter(Boolean);
  return required.every((need) =>
    owned.some((have) => have.includes(need) || need.includes(have))
  );
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
    // 伪证由凶手在庭上临时造，不出现在 AI 生成的档案里
    fake: false,
    flawOf: "",
    reservedFor: "", // 本地分配给真人的调查线索，AI 不得指定
  };
}

export function normalizeCase(raw, { chapter = 1 } = {}) {
  const source = raw && typeof raw === "object" ? raw : {};

  const propositions = (Array.isArray(source.propositions) ? source.propositions : [])
    .slice(0, 16)
    .map(normalizeProposition)
    .filter((item) => item.text);

  const evidence = (Array.isArray(source.evidence) ? source.evidence : [])
    .slice(0, 20)
    .map(normalizeEvidence)
    .filter((item) => item.description);

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
      description: safeString(source.method?.description, 400),
      requiredAbilities: normalizeStringArray(source.method?.requiredAbilities, {
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

export function evidenceOf(caseFile, evidenceId) {
  return (caseFile?.evidence || []).find((item) => item.id === evidenceId) || null;
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
  const { propositions, evidence } = caseFile;
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
  const duplicateLocations = duplicates(locationIds);
  if (duplicateProps.length) problems.push(`命题 id 重复：${duplicateProps.join("、")}`);
  if (duplicateEvidence.length) problems.push(`证据 id 重复：${duplicateEvidence.join("、")}`);
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
  if (conclusions.length < 3) problems.push("候选结论少于 3 个");
  if (propositions.length < 6) problems.push("命题少于 6 条");
  if (evidence.length < 10) problems.push("证据少于 10 条");

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
  } else if (caseFile.culpritId !== caseFile.victimId) {
    problems.push("真相是自杀/意外，但凶手不是死者本人");
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

  // --- 四条逻辑校验 ---

  // 1. 真相不被任何证据否定（真相是吸收态的定义性质）
  const refutesTruth = evidence.filter((item) => item.refutes.includes(truth.id));
  if (refutesTruth.length) {
    problems.push(
      `有证据否定了真相：${refutesTruth.map((item) => item.name).join("、")}`
    );
  }

  // 2. 唯一解：每个非真相结论至少有一条证据能否定它
  //    否则案子有二义性，玩家推到一半会发现怎么都对
  for (const item of conclusions) {
    if (item.id === truth.id) continue;
    if (!evidence.some((e) => e.refutes.includes(item.id))) {
      problems.push(`结论「${item.text}」无法被任何证据否定，案件有二义性`);
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

  // 4. 每一个候选结论都必须真的有机会成立。
  // 只有反证、没有足够支持牌的“陪跑答案”会让投票菜单看似有选择，实则只有一个按钮。
  for (const item of conclusions) {
    const supports = evidence.filter((e) => e.supports.includes(item.id)).length;
    const threshold = SUPPORT_THRESHOLD[item.conclusion.type];
    if (supports < threshold) {
      problems.push(
        `支持结论「${item.text}」的证据只有 ${supports} 条，不足 ${threshold} 条`
      );
    }
  }

  // 凶手当然得做得到自己干过的事
  const culprit = girls[caseFile.culpritId];
  if (culprit && !canPerformMethod(culprit, caseFile)) {
    problems.push(`手法需要「${caseFile.method.requiredAbilities.join("、")}」，但凶手的能力做不到`);
  }

  // 但也不能只有凶手做得到。
  // 玩家从尸体与证物推出所需能力后，如果范围只圈得住一个人，
  // 仍然等于直接念出凶手的名字。
  // 「设定系本格」是用物理约束**缩小**嫌疑范围，不是锁定一个人。
  const candidates = Object.values(girls).filter(
    (girl) => girl.alive && girl.id !== caseFile.victimId && canPerformMethod(girl, caseFile)
  );
  const inPlay = Object.values(girls).filter(
    (girl) => girl.alive && girl.id !== caseFile.victimId
  ).length;

  if (candidates.length < 2) {
    problems.push(
      `手法只有 ${candidates.length} 个人做得到，玩家推断出能力后会直接锁定凶手`
    );
  } else if (inPlay >= 4 && candidates.length > Math.ceil(inPlay * 0.6)) {
    problems.push(`手法有 ${candidates.length}/${inPlay} 人做得到，范围太宽，能力筛选失去意义`);
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
