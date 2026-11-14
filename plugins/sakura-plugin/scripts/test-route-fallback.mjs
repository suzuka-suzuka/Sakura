// node --experimental-test-module-mocks --test plugins/sakura-plugin/scripts/test-route-fallback.mjs
// 验证模型回退：尝试预算按模型分配、失败分类决定怎么回退、Key/供应商冷却。不连接外部服务。
import assert from "node:assert/strict";
import test, { beforeEach, mock } from "node:test";

globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {} };

const url = (relative) => new URL(relative, import.meta.url).href;

let configs = {};
mock.module(url("../lib/setting.js"), {
  defaultExport: { getConfig: (moduleName) => configs[moduleName] || {} },
});
mock.module(url("../lib/AIUtils/GroupContext.js"), {
  namedExports: { buildGroupPrompt: async () => "" },
});
mock.module(url("../lib/AIUtils/MCPManager.js"), { namedExports: { mcpManager: {} } });
mock.module(url("../lib/AIUtils/tools/tools.js"), {
  namedExports: {
    getToolsSchema: async () => ({ localTools: [], allowedMcpServerIds: [] }),
    toolGroupHasTool: () => false,
    executeToolCalls: async (_e, functionCalls) => ({
      historyContents: [{
        role: "function",
        parts: functionCalls.map((call) => ({
          functionResponse: { id: call.id, name: call.name, response: { ok: true } },
        })),
      }],
      queryParts: [],
    }),
  },
});
mock.module(url("../lib/AIUtils/memoryContext.js"), {
  namedExports: { buildMemoryContext: async () => "" },
});

// 假 OpenAI SDK：按 apiKey + 模型决定返回内容还是抛错。
const calls = [];
const payloads = [];
let behave = () => ({ choices: [{ message: { content: "ok" } }] });
mock.module("openai", {
  defaultExport: class {
    constructor(options) {
      this.apiKey = options.apiKey;
      this.chat = {
        completions: {
          create: async (payload) => {
            calls.push(`${payload.model}/${this.apiKey}`);
            payloads.push(structuredClone(payload));
            return behave(this.apiKey, payload.model, payload);
          },
        },
      };
    }
  },
});

const router = await import("../lib/AIUtils/providerRouter.js");
const { getAI, resetReasoningPassbackTargets } = await import("../lib/AIUtils/getAI.js");
const { runAgentLoop } = await import("../lib/AIUtils/AgentRunner.js");

const httpError = (status, message = `HTTP ${status}`) =>
  Object.assign(new Error(message), { status });
const timeoutError = () =>
  Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" });

function useConfig(providers, models) {
  configs = {
    Providers: {
      providers: providers.map(([name, apiKeys]) => ({
        name,
        protocol: "openai",
        baseURL: `https://${name}.example/v1`,
        apiKeys,
      })),
    },
    Models: {
      models: models.map(([model, provider]) => ({ provider, model, type: "chat" })),
    },
  };
}

const ask = (models) => getAI(models, { self_id: 1 }, [{ text: "你好" }], "", false, false, []);

beforeEach(() => {
  router.resetRouteCooldowns();
  resetReasoningPassbackTargets();
  calls.length = 0;
  payloads.length = 0;
  behave = () => ({ choices: [{ message: { content: "ok" } }] });
});

test("尝试预算保证列表里每个模型都轮得到，Key 多的模型不会挤掉后面的模型", () => {
  const manyKeys = Array.from({ length: 10 }, (_, index) => `a${index}`);
  useConfig([["甲", manyKeys], ["乙", ["b0"]], ["丙", ["c0", "c1"]]], [["m1", "甲"], ["m2", "乙"], ["m3", "丙"]]);

  const plan = router.createRouteExecutionPlan(["m1", "m2", "m3"], { selfId: 1 });
  const targets = plan.attempts.map((attempt) => attempt.target.id);
  assert.equal(plan.attempts.length, 8);
  assert.deepEqual(targets, ["m1", "m1", "m1", "m1", "m1", "m1", "m2", "m3"]);

  // 模型比预算还多时，每个模型仍各有一次。
  const names = Array.from({ length: 10 }, (_, index) => `x${index}`);
  useConfig([["甲", ["a0", "a1"]]], names.map((name) => [name, "甲"]));
  const wide = router.createRouteExecutionPlan(names, { selfId: 1 });
  assert.deepEqual(wide.attempts.map((attempt) => attempt.target.id), names);
});

test("失败分类：鉴权/限流换 Key 并冷却，请求格式错误换模型，超时换供应商", () => {
  const { classifyRouteFailure: classify, ROUTE_FAILURE_ACTIONS: A } = router;

  assert.deepEqual(
    [classify(httpError(401)).action, classify(httpError(401)).cooldown.scope],
    [A.NEXT, "credential"]
  );
  assert.equal(classify(httpError(402)).cooldown.scope, "credential");
  assert.equal(classify(httpError(429, "Rate limit reached")).cooldown.ms, 60 * 1000);
  assert.equal(classify(httpError(429, "You exceeded your current quota")).cooldown.ms, 10 * 60 * 1000);
  // Gemini 的无效 Key 报 400。
  const badKey = classify(httpError(400, "API key not valid. Please pass a valid API key."));
  assert.equal(badKey.action, A.NEXT);
  assert.equal(badKey.cooldown.scope, "credential");

  assert.equal(classify(httpError(400, "maximum context length exceeded")).action, A.NEXT_MODEL);
  assert.equal(classify(httpError(413)).action, A.NEXT_MODEL);
  assert.equal(classify(httpError(422)).action, A.NEXT_MODEL);
  // 4xx 正文里出现 timeout 字样不算超时。
  assert.equal(classify(httpError(400, "invalid parameter: timeout")).action, A.NEXT_MODEL);

  for (const error of [timeoutError(), httpError(504), { message: "x", timedOut: true }]) {
    const failure = classify(error);
    assert.equal(failure.action, A.NEXT_PROVIDER);
    assert.equal(failure.cooldown.scope, "provider");
  }

  assert.equal(classify(httpError(500)).action, A.NEXT);
  assert.equal(classify(httpError(500)).cooldown, null);
  assert.equal(classify(new Error("socket hang up")).action, A.NEXT);
  assert.equal(classify(router.createRouteFailure("x", A.ABORT)).action, A.ABORT);
});

test("400 请求错误跳过同模型的其余 Key，直接换下一个模型", async () => {
  useConfig([["甲", ["a1", "a2", "a3"]], ["乙", ["b1"]]], [["m1", "甲"], ["m2", "乙"]]);
  behave = (_key, model) => {
    if (model === "m1") throw httpError(400, "maximum context length exceeded");
    return { choices: [{ message: { content: "来自 m2" } }] };
  };

  const result = await ask(["m1", "m2"]);
  assert.equal(result.text, "来自 m2");
  assert.equal(calls.length, 2);
  assert.match(calls[0], /^m1\//);
  assert.equal(calls[1], "m2/b1");
});

test("超时跳过同供应商的其他模型，下一次请求时该供应商排到最后", async () => {
  useConfig([["甲", ["a1"]], ["乙", ["b1"]]], [["m1", "甲"], ["m3", "甲"], ["m2", "乙"]]);
  behave = (_key, model) => {
    if (model === "m1") throw timeoutError();
    return { choices: [{ message: { content: model } }] };
  };

  assert.equal((await ask(["m1", "m3", "m2"])).text, "m2");
  assert.deepEqual(calls, ["m1/a1", "m2/b1"]);

  calls.length = 0;
  assert.equal((await ask(["m1", "m3", "m2"])).text, "m2");
  assert.deepEqual(calls, ["m2/b1"], "冷却中的供应商应排到后面");
});

test("所有尝试都在冷却时仍按原顺序尝试，而不是直接报错", async () => {
  useConfig([["甲", ["a1"]]], [["m1", "甲"]]);
  behave = () => { throw timeoutError(); };
  assert.match(await ask(["m1"]), /请求失败/);

  behave = () => ({ choices: [{ message: { content: "恢复了" } }] });
  calls.length = 0;
  assert.equal((await ask(["m1"])).text, "恢复了");
  assert.deepEqual(calls, ["m1/a1"]);
});

test("鉴权失败的 Key 进入冷却，之后的请求优先用其他 Key", async () => {
  useConfig([["甲", ["a1", "a2"]]], [["m1", "甲"]]);
  behave = (key) => {
    if (key === "a1") throw httpError(401, "Incorrect API key provided");
    return { choices: [{ message: { content: key } }] };
  };

  const order = [];
  for (let round = 0; round < 3; round++) {
    calls.length = 0;
    assert.equal((await ask(["m1"])).text, "a2");
    order.push([...calls]);
  }
  assert.deepEqual(order[0], ["m1/a1", "m1/a2"]);
  // 轮询本该让第三次从 a1 开始，但 a1 在冷却，应直接用 a2。
  assert.deepEqual(order[2], ["m1/a2"]);
});

test("确定性错误直接终止，不再逐个尝试", async () => {
  useConfig([["甲", ["a1", "a2"]], ["乙", ["b1"]]], [["m1", "甲"], ["m2", "乙"]]);
  const result = await getAI(["m1", "m2"], { self_id: 1 }, [], "", false, false, []);
  assert.match(result, /无有效查询或历史内容/);
  assert.deepEqual(calls, []);
});

test("换到其他供应商时不等待，同一供应商换 Key 才等待", async () => {
  useConfig([["甲", ["a1", "a2"]], ["乙", ["b1"]]], [["m1", "甲"], ["m2", "乙"]]);
  const plan = router.createRouteExecutionPlan(["m1", "m2"], { selfId: 1 });
  const sleeps = [];
  const outcome = await router.executeRoutePlan({
    plan,
    run: async (attempt) => {
      if (attempt.target.id === "m1") throw httpError(500);
      return attempt.credential.apiKey;
    },
    sleep: async (ms) => { sleeps.push(ms); },
    log: () => {},
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.value, "b1");
  assert.deepEqual(sleeps, [1000], "a1→a2 等一次，a2→b1 不等");
});

// ---- DeepSeek 等思考模式接口要求回传 reasoning_content ----

const PASSBACK_ERROR = "The `reasoning_content` in the thinking mode must be passed back to the API.";
const assistantMessages = (payload) => payload.messages.filter((message) => message.role === "assistant");
const toolCallReply = (id, reasoning) => ({
  choices: [{
    message: {
      content: "",
      ...(reasoning && { reasoning_content: reasoning }),
      tool_calls: [{ id, type: "function", function: { name: "Search", arguments: "{}" } }],
    },
  }],
});

// 模拟 DeepSeek：带工具调用的 assistant 消息缺 reasoning_content 就报 400。
function deepseek(payload, reply) {
  const missing = assistantMessages(payload).some(
    (message) => message.tool_calls && !Object.hasOwn(message, "reasoning_content")
  );
  if (missing) throw httpError(400, PASSBACK_ERROR);
  return reply;
}

test("A 模型调用工具后失败、回退 DeepSeek：补齐 reasoning_content 重试成功，之后不再先失败", async () => {
  useConfig([["甲", ["a1"]], ["深度", ["d1"]]], [["a", "甲"], ["ds", "深度"]]);
  let aRounds = 0;
  behave = (_key, model, payload) => {
    if (model === "a") {
      aRounds += 1;
      if (aRounds === 1) return toolCallReply("call_a1");
      throw httpError(503, "upstream overloaded");
    }
    return deepseek(payload, { choices: [{ message: { content: "DeepSeek 接手了" } }] });
  };

  const history = [];
  const result = await runAgentLoop({
    e: { self_id: 1, user_id: 2 },
    route: ["a", "ds"],
    queryParts: [{ text: "查一下" }],
    prompt: "",
    groupContext: false,
    toolGroup: "默认",
    history,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.finalText, "DeepSeek 接手了");
  assert.deepEqual(calls, ["a/a1", "a/a1", "ds/d1", "ds/d1"]);
  const retried = assistantMessages(payloads.at(-1));
  assert.equal(retried[0].reasoning_content, "", "A 的工具调用没有推理内容，回传空串");

  // 已经学会，下次直接带上，不再先吃一次 400。
  calls.length = 0;
  payloads.length = 0;
  // 去掉最后的回答，停在工具结果处，模拟下一轮工具调用后的请求。
  const again = await getAI(["ds"], { self_id: 1 }, [], "", false, false, history.slice(0, -1));
  assert.equal(again.text, "DeepSeek 接手了");
  assert.deepEqual(calls, ["ds/d1"]);
});

test("DeepSeek 自己的工具调用轮：推理内容存进历史并在下一轮原样回传", async () => {
  useConfig([["深度", ["d1"]]], [["ds", "深度"]]);
  let round = 0;
  behave = (_key, _model, payload) => {
    round += 1;
    if (round === 1) return toolCallReply("call_d1", "先查资料再回答");
    return deepseek(payload, { choices: [{ message: { content: "完成" } }] });
  };

  const history = [];
  const result = await runAgentLoop({
    e: { self_id: 1, user_id: 2 },
    route: ["ds"],
    queryParts: [{ text: "查一下" }],
    prompt: "",
    groupContext: false,
    toolGroup: "默认",
    history,
  });

  assert.equal(result.finalText, "完成");
  const toolTurn = history.find((item) => item.role === "model" && item.toolCallIds);
  assert.equal(toolTurn.reasoningContent, "先查资料再回答");
  assert.equal(assistantMessages(payloads.at(-1))[0].reasoning_content, "先查资料再回答");
});

test("不认识 reasoning_content 的接口不会被带上这个字段", async () => {
  useConfig([["官方", ["o1"]]], [["gpt", "官方"]]);
  behave = (_key, _model, payload) => {
    if (assistantMessages(payload).some((message) => Object.hasOwn(message, "reasoning_content"))) {
      throw httpError(400, "Additional properties are not allowed ('reasoning_content' was unexpected)");
    }
    return { choices: [{ message: { content: "ok" } }] };
  };
  const history = [
    { role: "user", parts: [{ text: "hi" }] },
    {
      role: "model",
      sourceProtocol: "openai",
      parts: [{ functionCall: { id: "call_1", name: "Search", args: {} } }],
      toolCallIds: ["call_1"],
      reasoningContent: "别的模型的推理",
    },
    { role: "function", parts: [{ functionResponse: { id: "call_1", name: "Search", response: {} } }] },
  ];
  const result = await getAI(["gpt"], { self_id: 1 }, [], "", false, false, history);
  assert.equal(result.text, "ok");
  assert.deepEqual(calls, ["gpt/o1"]);
});
