/**
 * 模组与角色卡的数据结构、归一化与校验
 *
 * AI 的输出一律先过这一层：截断超长字段、补全缺失项、夹紧数值范围。
 * 这样 KP 引擎和指令层永远拿到形状固定的对象，不用到处防御式判空。
 */

import { deriveStats, rollAttributes } from "./dice.js";

export const ATTRIBUTE_KEYS = [
  "力量",
  "体质",
  "敏捷",
  "外貌",
  "意志",
  "智力",
  "教育",
  "体型",
];

/** 技能缺省值：KP 点名了角色卡上没有的技能时用它兜底 */
export const DEFAULT_SKILLS = {
  侦查: 25,
  聆听: 20,
  图书馆使用: 20,
  说服: 10,
  话术: 5,
  恐吓: 15,
  魅惑: 15,
  闪避: 0, // 由敏捷派生，归一化时填
  斗殴: 25,
  射击: 20,
  急救: 30,
  医学: 1,
  潜行: 20,
  攀爬: 20,
  跳跃: 20,
  游泳: 20,
  驾驶: 20,
  机械维修: 10,
  电器维修: 10,
  锁匠: 1,
  导航: 10,
  追踪: 10,
  历史: 5,
  神秘学: 5,
  心理学: 10,
  自然学: 10,
  科学: 1,
  计算机使用: 5,
  侦察: 25,
};

const UNKNOWN_SKILL_VALUE = 20;

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

// ===== 模组 =====

function normalizeScene(raw, index) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    id: slugId(source.id, `scene_${index + 1}`),
    name: safeString(source.name, 40) || `场景${index + 1}`,
    description: safeString(source.description, 600),
    features: normalizeStringArray(source.features, { limit: 6, maxLength: 80 }),
    exits: normalizeStringArray(source.exits, { limit: 6, maxLength: 40 }),
    secrets: (Array.isArray(source.secrets) ? source.secrets : [])
      .slice(0, 4)
      .map((secret) => ({
        description: safeString(secret?.description, 300),
        skill: safeString(secret?.skill, 20),
        note: safeString(secret?.note, 200),
      }))
      .filter((secret) => secret.description),
  };
}

function normalizeNpc(raw, index) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    name: safeString(source.name, 30) || `无名者${index + 1}`,
    role: safeString(source.role, 60),
    personality: safeString(source.personality, 150),
    motive: safeString(source.motive, 200),
    secret: safeString(source.secret, 300),
  };
}

export function normalizeModule(raw) {
  const source = raw && typeof raw === "object" ? raw : {};

  const scenes = (Array.isArray(source.scenes) ? source.scenes : [])
    .slice(0, 12)
    .map(normalizeScene);

  return {
    title: safeString(source.title, 40) || "无名之章",
    genre: safeString(source.genre, 30),
    tone: safeString(source.tone, 60),
    background: safeString(source.background, 1200),
    hook: safeString(source.hook, 800),
    scenes,
    npcs: (Array.isArray(source.npcs) ? source.npcs : []).slice(0, 10).map(normalizeNpc),
    mainline: (Array.isArray(source.mainline) ? source.mainline : [])
      .slice(0, 8)
      .map((item, index) => ({
        id: slugId(item?.id, `beat_${index + 1}`),
        title: safeString(item?.title, 60),
        trigger: safeString(item?.trigger, 200),
        outcome: safeString(item?.outcome, 300),
      }))
      .filter((item) => item.title),
    storyFlags: (Array.isArray(source.storyFlags) ? source.storyFlags : [])
      .slice(0, 14)
      .map((item) => ({
        name: safeString(item?.name, 30),
        description: safeString(item?.description, 120),
      }))
      .filter((item) => item.name),
    endings: (Array.isArray(source.endings) ? source.endings : [])
      .slice(0, 5)
      .map((item, index) => ({
        id: slugId(item?.id, `ending_${index + 1}`),
        name: safeString(item?.name, 40) || `结局${index + 1}`,
        description: safeString(item?.description, 500),
        requires: {
          all: normalizeStringArray(item?.requires?.all, { limit: 8, maxLength: 30 }),
          any: normalizeStringArray(item?.requires?.any, { limit: 8, maxLength: 30 }),
          none: normalizeStringArray(item?.requires?.none, { limit: 8, maxLength: 30 }),
        },
      })),
    dangers: normalizeStringArray(source.dangers, { limit: 6, maxLength: 150 }),
    startScene: slugId(source.startScene, scenes[0]?.id || "scene_1"),
  };
}

/** 模组必须满足的最低要求，不满足就打回让 AI 重生成 */
export function validateModule(module) {
  const problems = [];

  if (!module.title) problems.push("缺少标题");
  if (!module.background) problems.push("缺少背景设定");
  if (module.scenes.length < 3) problems.push("场景少于 3 个");
  if (module.npcs.length < 2) problems.push("NPC 少于 2 个");
  if (module.mainline.length < 3) problems.push("主线事件少于 3 条");
  if (module.endings.length < 2) problems.push("结局少于 2 个");
  if (module.storyFlags.length < 4) problems.push("剧情标记少于 4 个");

  const sceneIds = new Set(module.scenes.map((scene) => scene.id));
  if (module.scenes.length && !sceneIds.has(module.startScene)) {
    problems.push("起始场景不在场景列表里");
  }

  // 结局条件必须能被本地判定：引用的标记要在词表里，且不能没有条件
  const flagNames = new Set(module.storyFlags.map((flag) => flag.name));
  for (const ending of module.endings) {
    const referenced = [...ending.requires.all, ...ending.requires.any, ...ending.requires.none];
    const unknown = referenced.filter((name) => !flagNames.has(name));
    if (unknown.length) {
      problems.push(`结局「${ending.name}」引用了词表外的标记：${unknown.join("、")}`);
    }
    if (!ending.requires.all.length && !ending.requires.any.length) {
      problems.push(`结局「${ending.name}」没有任何达成条件`);
    }
  }

  return { ok: problems.length === 0, problems };
}

// ===== 角色卡 =====

export function normalizeCharacter(raw, { userId, nickname } = {}) {
  const source = raw && typeof raw === "object" ? raw : {};

  const attrs = {};
  const rolled = rollAttributes();
  for (const key of ATTRIBUTE_KEYS) {
    // AI 给的属性只在 15~90 之间采纳，超出范围就用本地掷出来的
    const provided = safeInt(source.attrs?.[key], { min: 0, max: 100, fallback: 0 });
    attrs[key] = provided >= 15 && provided <= 90 ? provided : rolled[key];
  }

  const derived = deriveStats(attrs);

  const skills = {};
  const rawSkills = source.skills && typeof source.skills === "object" ? source.skills : {};
  for (const [name, value] of Object.entries(rawSkills).slice(0, 25)) {
    const skillName = safeString(name, 20);
    if (!skillName) continue;
    skills[skillName] = safeInt(value, { min: 1, max: 95, fallback: UNKNOWN_SKILL_VALUE });
  }
  if (!skills.闪避) skills.闪避 = derived.dodge;

  return {
    userId: String(userId ?? source.userId ?? ""),
    playerName: safeString(nickname, 40),
    name: safeString(source.name, 30) || safeString(nickname, 30) || "无名调查员",
    occupation: safeString(source.occupation, 40) || "旅人",
    age: safeInt(source.age, { min: 10, max: 90, fallback: 30 }),
    appearance: safeString(source.appearance, 200),
    background: safeString(source.background, 600),
    goal: safeString(source.goal, 300),
    // 个人目标的达成标记，收场时按它逐人结算；AI 没给就本地兜一个
    goalFlag: safeString(source.goalFlag, 30) || `${safeString(source.name, 12) || "某人"}的心愿`,
    attrs,
    skills,
    hp: derived.maxHp,
    maxHp: derived.maxHp,
    mp: derived.maxMp,
    maxMp: derived.maxMp,
    san: derived.maxSan,
    maxSan: derived.maxSan,
    move: derived.move,
    inventory: normalizeStringArray(source.inventory, { limit: 8, maxLength: 40 }),
    status: [],
    alive: true,
  };
}

/**
 * 取角色某项技能的值
 * 顺序：角色卡技能 → 角色卡属性 → 通用技能默认值 → 兜底 20
 */
export function getSkillValue(character, skillName) {
  const name = safeString(skillName, 20);
  if (!name) return UNKNOWN_SKILL_VALUE;

  if (Number.isFinite(character?.skills?.[name])) return character.skills[name];
  if (Number.isFinite(character?.attrs?.[name])) return character.attrs[name];

  // 「侦查检定」「说服(困难)」这类带修饰的写法，取包含关系再试一次
  for (const key of Object.keys(character?.skills || {})) {
    if (name.includes(key) || key.includes(name)) return character.skills[key];
  }
  for (const key of ATTRIBUTE_KEYS) {
    if (name.includes(key)) return character.attrs?.[key] ?? UNKNOWN_SKILL_VALUE;
  }
  if (Number.isFinite(DEFAULT_SKILLS[name])) return DEFAULT_SKILLS[name];

  return UNKNOWN_SKILL_VALUE;
}

// ===== 提示词用的压缩视图 =====

/**
 * 模组的精简视图，用于每回合喂给 KP
 * 只保留 KP 判断剧情走向必需的信息，长度固定，不随回合数增长
 */
export function compactModule(module, currentSceneId) {
  const scene = module.scenes.find((item) => item.id === currentSceneId) || module.scenes[0];

  return {
    标题: module.title,
    基调: module.tone,
    背景: module.background,
    当前场景: scene
      ? {
          id: scene.id,
          名称: scene.name,
          描述: scene.description,
          可交互: scene.features,
          出口: scene.exits,
          隐藏内容: scene.secrets,
        }
      : null,
    其他场景: module.scenes
      .filter((item) => item.id !== scene?.id)
      .map((item) => ({ id: item.id, 名称: item.name, 一句话: item.description.slice(0, 60) })),
    NPC: module.npcs,
    主线: module.mainline,
    // 结局条件由本地判定，这里只给 KP 看方向，让它知道该往哪推
    结局: module.endings.map((item) => ({
      名称: item.name,
      需要达成: item.requires.all,
      任一即可: item.requires.any,
      一旦达成则排除: item.requires.none,
    })),
    危险: module.dangers,
  };
}

/** 角色卡的精简视图，用于每回合喂给 KP */
export function compactCharacter(character) {
  return {
    QQ: character.userId,
    姓名: character.name,
    职业: character.occupation,
    目标: character.goal,
    HP: `${character.hp}/${character.maxHp}`,
    SAN: `${character.san}/${character.maxSan}`,
    状态: character.status,
    持有物: character.inventory,
    存活: character.alive,
    主要技能: Object.fromEntries(
      Object.entries(character.skills)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
    ),
  };
}

// ===== 剧情标记与收场判定 =====

/**
 * 本局允许使用的全部标记名 = 模组词表 + 每人的个人目标标记
 * KP 只能从这份词表里选，写词表外的一律丢弃，否则结局条件永远对不上
 */
export function collectFlagVocabulary(module, characters = []) {
  const names = new Set((module?.storyFlags || []).map((flag) => flag.name).filter(Boolean));
  for (const character of characters) {
    if (character?.goalFlag) names.add(character.goalFlag);
  }
  return [...names];
}

/** 旧版本存下的会话没有 requires 字段，按「无条件」处理即可，不会误触发 */
function endingRequires(ending) {
  const requires = ending?.requires || {};
  return {
    all: Array.isArray(requires.all) ? requires.all : [],
    any: Array.isArray(requires.any) ? requires.any : [],
    none: Array.isArray(requires.none) ? requires.none : [],
  };
}

function endingMatches(ending, flags) {
  const has = (name) => flags?.[name] === true;
  const { all, any, none } = endingRequires(ending);

  // 没有任何条件的结局不会自动触发，避免开局就收场
  if (!all.length && !any.length) return false;
  if (none.some(has)) return false;
  if (all.length && !all.every(has)) return false;
  if (any.length && !any.some(has)) return false;
  return true;
}

/**
 * 本地判定是否达成了某个结局
 * 多个同时满足时取条件最多的那个，它通常也是最特殊、最该被讲出来的那个
 */
export function evaluateEndings(module, flags) {
  const weight = (ending) => {
    const { all, any } = endingRequires(ending);
    return all.length + any.length;
  };
  const matched = (module?.endings || [])
    .filter((ending) => endingMatches(ending, flags))
    .sort((a, b) => weight(b) - weight(a));
  return matched[0] || null;
}

/** 还没达成、但某个结局还用得上的标记，用来引导 KP 出选项 */
export function pendingEndingFlags(module, flags) {
  const wanted = new Set();
  for (const ending of module?.endings || []) {
    const { all, any } = endingRequires(ending);
    for (const name of [...all, ...any]) {
      if (flags?.[name] !== true) wanted.add(name);
    }
  }
  return [...wanted];
}

/** 逐人结算个人目标 */
export function settleGoals(characters, flags) {
  return characters.map((character) => ({
    userId: character.userId,
    name: character.name,
    goal: character.goal || "（未设定）",
    achieved: flags?.[character.goalFlag] === true,
  }));
}
