/**
 * 两阶段案件生成提示词
 *
 * 第一阶段只产出故事蓝图；第二阶段面对已经锁死的本地证据图填写可读文本。
 * 两个阶段都不会接触现实玩家资料。
 */

import {
  EVIDENCE_VIA,
  VERDICT,
  girlsByPrisonerCode,
} from "./schema.js";

export const CASE_BLUEPRINT_SYSTEM = `你是《魔女审判》的本格案件设计者。

程序已经决定死者、责任人、候选结论和证据图。你只设计一份与这些固定条件相容的
故事蓝图，不得自行增删结论、证据或关系。

规则：
1. 结论只有指认某人和自杀；生理死因写在 causeOfDeath，不生成意外结论。
2. 致死动作可以很普通。魔法可以直接致死，也可以只搬尸、藏痕、制造错误死因、
   时间、地点或不可能犯罪假象；公开能力也可以只是被凶手利用的误导。
3. requiredAbilities 必须原样选择程序列出的一个数组，不能自由填写或组合。
   选择 [] 就表示完整犯罪方案没有实际使用魔法，magicRole 必须如实说明。
4. misdirection 要么为 null，要么严格从程序列出的被嫁祸对象和能力中选择。
   表面能力不能是真实方案必需的能力，替代手段必须在 description 中讲清楚。
5. 每条事实都必须是可以被物证或证言证明的客观陈述，并能在不依赖动机的情况下
   合理支持指定结论。错误结论的支持事实也可以是真的，只是它不足以排除反证。
6. 动机只服务最终叙事，不作为证据。
7. 可读文字里只能使用少女姓名，不能出现 girl_、c_、e_、f_、fp_ 等内部 id。
8. 只输出指定 JSON，不要解释、代码围栏或思考过程。`;

function anonymousIdOf(anonymousGirlIds, girl) {
  return anonymousGirlIds.get(girl.id) || "girl_unknown";
}

function historyText(history) {
  if (!history?.length) return "（这是第一起案件）";
  return history
    .map(
      (item) =>
        `第${item.chapter}章：${item.victimName}死亡，${item.executedName || "无人"}被处刑，审判${item.correct ? "正确" : "错误"}`
    )
    .join("\n");
}

function methodPlanText(plans) {
  return plans.map((plan) => JSON.stringify(plan)).join("\n");
}

export function buildCaseBlueprintPrompt({
  prison,
  girls,
  victim,
  culprit,
  topology,
  chapter,
  history,
  anonymousGirlIds,
}) {
  const livingRoster = girlsByPrisonerCode(girls)
    .filter((girl) => girl.alive && girl.id !== victim.id)
    .map(
      (girl) =>
        `- ${girl.name}：能力「${girl.ability.name}」，可以${girl.ability.can.join("、") || "（无补充效果）"}；限制：${girl.ability.limit}`
    )
    .join("\n");
  const discoveryLocation =
    prison.locations.find((item) => item.id === topology.discovery.location);
  const finder = girls[topology.discovery.finder];
  const conclusionById = new Map(
    topology.conclusions.map((item) => [item.id, item])
  );
  const factSlots = topology.facts
    .map((fact) => {
      const conclusion = conclusionById.get(fact.conclusionPropId);
      return `- "${fact.id}"：写一项能够支持「${conclusion.text}」的客观事实`;
    })
    .join("\n");
  const truth = conclusionById.get(topology.truthId);

  const misdirectionText = topology.misdirectionChoices.length
    ? topology.misdirectionChoices
        .map(
          (item) =>
            `- targetId "${anonymousIdOf(anonymousGirlIds, girls[item.targetId])}"：${item.targetName}；apparentAbility 只能选 ${JSON.stringify(item.abilities)}`
        )
        .join("\n")
    : "（没有可用对象，本案的 misdirection 必须为 null）";

  return `请为第 ${chapter} 章填写案件蓝图。

## 牢狱
${prison.name}
尸体固定在「${discoveryLocation?.name || "未知地点"}」被发现，第一发现者固定为${finder?.name || "一位在场少女"}。

## 在场少女与公开能力
${livingRoster}

## 本地已经决定的真相
死者：${victim.name}，能力「${victim.ability.name}」
身世：${victim.profile}
责任人：${culprit.name}，能力「${culprit.ability.name}」，可以${culprit.ability.can.join("、") || "（无补充效果）"}；限制：${culprit.ability.limit}
身世：${culprit.profile}
她藏着的事：${culprit.secret}
唯一真相结论：${truth?.text || "（缺失）"}
${culprit.id === victim.id ? "这是极罕见的自杀真相。" : "这是他杀真相；责任人可能以普通手段致死，不能强迫魔法直接杀人。"}

## 前情
${historyText(history)}

## 真实方案允许使用的能力数组
requiredAbilities 必须完整照抄下面某一行，不能增加、删减或合并：
${methodPlanText(topology.allowedAbilityPlans)}

## 可选的公开能力误导
misdirection 只能为 null，或从下列一行原样选择 targetId 与 apparentAbility：
${misdirectionText}

## 固定事实槽
只给这些 fact id 填文字；不要输出候选结论，也不要设计证据：
${factSlots}

## 输出 JSON
{
  "discovery": {
    "time": "发现时间",
    "body": "150-250字，只写当时能看见、触摸或测量的尸体与现场状态；不直接宣布真实死因和责任人"
  },
  "method": {
    "causeOfDeath": "真实生理或物理死因",
    "killingAction": "真正导致死亡的动作，可以是普通手段",
    "magicRole": "魔法在完整方案中实际承担什么；未使用就明确写未使用",
    "misdirection": null,
    "description": "200-300字，按时间顺序写完整作案经过、伪装与替代原理",
    "requiredAbilities": []
  },
  "motive": {
    "trigger": "具体的最后触发事件，100-150字",
    "backstory": "从责任人身世发展出的前因后果，300-450字",
    "confession": "被拆穿时的第一人称话语，100-200字"
  },
  "facts": [
    { "id": "上方固定的 f_ id", "text": "一句可由证物或证言判定真假的客观事实" }
  ]
}

如果使用误导，misdirection 改成：
{
  "description": "现场为何让人误以为该公开能力不可缺少，以及责任人实际如何不用它制造同样表象",
  "apparentAbility": "上方允许的能力原文",
  "targetId": "上方对应的匿名 id"
}

再次确认：facts 必须逐个包含全部固定 id；id 只放结构字段，任何可读文字都不能写内部 id。`;
}

export const CASE_TEXT_SYSTEM = `你是《魔女审判》的案件文本编辑。

案件真相和证据图已经由程序锁定。你只能为每个固定槽填写名称、客观描述和公开推理
说明；不得改变 supports、refutes、获取途径、目标结论、事实效果或破绽证据。

写作规则：
1. 真实证物必须与案件蓝图相容。支持错误结论的证物也必须真实，只是容易产生片面
   推断；反证负责指出缺失条件或另一种解释，叙述者不能撒谎。
2. 描述具体可观察的痕迹、记录、时序或证言内容，让玩家自己推断；不要直接写
   “所以她是凶手”“这证明结论正确/错误”。
3. 询问取得的线索必须是指定少女能够亲历、看见或听见的内容，不要让她凭空知道真相。
4. 事实效果 reason 会在事实成立后公开，只解释该公开事实为何支持该公开结论，
   不得泄露隐藏动机、完整手法、未公开证物或唯一真相标签。
5. 每套庭审记录的 name 和 description 是一件看起来正常、表面上能够否定目标结论
   的物证、记录或可观察痕迹。公开部分不能出现伪证、伪造、假证、捏造、说谎、
   破绽、揭穿、凶手提供等自曝词，也不能写成某人的说辞、证言、口供或自述。
6. exposureText 才解释它与指定真实证物之间的具体矛盾。
7. 所有真实证据和庭审记录名称互不相同；可读文字只能用姓名，不能出现任何内部 id。
8. 只输出指定 JSON，不要解释、代码围栏或思考过程。`;

function propositionMaps(draft) {
  return {
    propositions: new Map(draft.propositions.map((item) => [item.id, item])),
    evidence: new Map(draft.evidence.map((item) => [item.id, item])),
  };
}

function evidenceTask(slot, propositions) {
  const tasks = [
    ...slot.supports.map((propId) => {
      const proposition = propositions.get(propId);
      return proposition?.conclusion
        ? `支持责任结论「${proposition.text}」`
        : `证实客观事实「${proposition?.text || "未知事实"}」`;
    }),
    ...slot.refutes.map((propId) => {
      const proposition = propositions.get(propId);
      return `反驳责任结论「${proposition?.text || "未知结论"}」`;
    }),
  ];
  return `写一条真实线索，其客观内容必须能同时${tasks.join("，并且")}`;
}

function deliveryText(slot, prison, girls) {
  if (slot.via === EVIDENCE_VIA.SEARCH) {
    const location = prison.locations.find((item) => item.id === slot.location);
    return `搜查「${location?.name || "未知地点"}」取得`;
  }
  return `询问${girls[slot.askTarget]?.name || "一位在场少女"}取得`;
}

function methodView(draft, girls) {
  const misdirection = draft.method.misdirection
    ? {
        description: draft.method.misdirection.description,
        apparentAbility: draft.method.misdirection.apparentAbility,
        target: girls[draft.method.misdirection.targetId]?.name || "未知少女",
      }
    : null;
  return {
    causeOfDeath: draft.method.causeOfDeath,
    killingAction: draft.method.killingAction,
    magicRole: draft.method.magicRole,
    misdirection,
    description: draft.method.description,
    requiredAbilities: draft.method.requiredAbilities,
  };
}

export function buildCaseTextPrompt({
  prison,
  girls,
  victim,
  culprit,
  topology,
  draft,
}) {
  const { propositions, evidence } = propositionMaps(draft);
  const truth = propositions.get(draft.truthId);
  const evidenceSlots = topology.evidence
    .map(
      (slot) =>
        `- "${slot.id}"；${deliveryText(slot, prison, girls)}；${evidenceTask(slot, propositions)}`
    )
    .join("\n");
  const effectSlots = topology.factEffects
    .map((slot) => {
      const fact = propositions.get(slot.factPropId);
      const conclusion = propositions.get(slot.conclusionPropId);
      return `- factPropId "${slot.factPropId}"：事实「${fact?.text}」成立后，解释它为何支持结论「${conclusion?.text}」`;
    })
    .join("\n");
  const forgerySlots = topology.forgeryPlans
    .map((slot) => {
      const conclusion = propositions.get(slot.targetPropId);
      const flaw = evidence.get(slot.flawEvidenceId);
      const flawTask = flaw ? evidenceTask(flaw, propositions) : "指定真实证物";
      return `- id "${slot.id}"：公开外观要反驳「${conclusion?.text}」；它必须能被真实证物 "${slot.flawEvidenceId}"（${flawTask}）具体揭穿`;
    })
    .join("\n");

  return `请为下面这份已锁定的案件证据图填写文本。

## 案件内部蓝图
死者：${victim.name}
责任人：${culprit.name}
唯一真相：${truth?.text}
尸体发现：${draft.discovery.time}，${draft.discovery.body}
真实手法：${JSON.stringify(methodView(draft, girls), null, 2)}

这些内部答案只用于保持文本一致，绝不能在证物中直接宣布。

## 固定证据槽
${evidenceSlots}

## 固定事实效果
${effectSlots}

## 固定庭审记录与揭穿点
${forgerySlots}

## 输出 JSON
{
  "evidence": [
    {
      "id": "固定 e_ id",
      "name": "不超过10字的具体证物名",
      "description": "80-150字的客观内容；关系应能从字面推出来，但不替玩家宣判"
    }
  ],
  "factEffects": [
    {
      "factPropId": "固定 f_ id",
      "reason": "30-100字，只解释这个公开事实为何间接支持对应公开结论"
    }
  ],
  "forgeryPlans": [
    {
      "id": "固定 fp_ id",
      "name": "不超过10字、看不出异常的普通证物名",
      "description": "80-150字，表面上能够否定指定结论的物证、记录或痕迹",
      "exposureText": "60-120字，说明它与指定真实证物在什么具体细节上冲突"
    }
  ]
}

必须逐个填写全部固定 id，不能增加或遗漏。id 只能出现在结构字段中，任何 name、
description、reason、exposureText 都不能抄写 id。`;
}
