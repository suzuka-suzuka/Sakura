// node --test plugins/sakura-plugin/scripts/test-current-config-schema.mjs
// 只验证现行配置和请求参数，不连接外部服务。
import assert from "node:assert/strict";
import test from "node:test";
import {
  AISchema,
  RoutesSchema,
  EconomySchema,
  TavilyMCPSchema,
} from "../configSchema.js";
import { resolveGenerationSettings } from "../lib/AIUtils/providerRouter.js";

test("AI 角色和辅助路由直接使用现行字段，旧字段不再改名", () => {
  const parsed = AISchema.parse({
    utilityRoute: "utility",
    geminiRoute: "gemini",
    profiles: [{ prefixes: ["%", "%角色"], route: "chat", history: false, groupContext: true, toolGroup: "工具" }],
  });
  assert.equal(parsed.utilityRoute, "utility");
  assert.equal(parsed.geminiRoute, "gemini");
  assert.deepEqual(parsed.profiles[0].prefixes, ["%", "%角色"]);
  assert.equal(parsed.profiles[0].history, false);
  assert.equal(parsed.profiles[0].groupContext, true);
  assert.equal(parsed.profiles[0].toolGroup, "工具");
  const obsolete = AISchema.parse({ appsRoute: "obsolete", toolsRoute: "obsolete" });
  assert.equal(obsolete.utilityRoute, "default");
  assert.equal(obsolete.geminiRoute, "");
  assert.equal(AISchema.safeParse({ profiles: [{ prefix: "%", Channel: "chat" }] }).success, false);
});

test("路由目标的零值、思考参数和流式开关进入实际请求配置", () => {
  const route = RoutesSchema.parse({ routes: [{ id: "chat", targets: [{
    id: "target", provider: "provider", model: "model",
    temperature: 0, topP: 0, openaiReasoningEffort: "none",
    openaiEnableThinking: true, stream: true,
    geminiThinkingLevel: "high", geminiThinkingBudget: -2,
  }] }] }).routes[0];
  assert.deepEqual(resolveGenerationSettings(route, route.targets[0]), {
    temperature: 0, topP: 0, openaiEnableThinking: true,
    openaiReasoningEffort: "none", stream: true,
    geminiThinkingLevel: "high", geminiThinkingBudget: undefined,
  });
});

test("路由公共参数和旧目标覆盖参数不再影响请求", () => {
  const route = { temperature: 0.7, topP: 0.8, reasoningLevel: "high" };
  const target = { temperatureOverride: 0.3, topPOverride: 0.4 };
  const settings = resolveGenerationSettings(route, target);
  assert.equal(settings.temperature, undefined);
  assert.equal(settings.topP, undefined);
  assert.equal(settings.openaiReasoningEffort, undefined);
  assert.equal(settings.geminiThinkingLevel, undefined);
  for (const field of ["openaiReasoningEffort", "geminiThinkingLevel"]) {
    assert.equal(RoutesSchema.safeParse({ routes: [{ id: "chat", targets: [{
      id: "target", provider: "provider", model: "model", [field]: "inherit",
    }] }] }).success, false);
  }
});

test("Gemini 显式预算优先，关闭思考仍传零预算", () => {
  const explicit = resolveGenerationSettings({}, { geminiThinkingLevel: "high", geminiThinkingBudget: -1 });
  assert.equal(explicit.geminiThinkingBudget, -1);
  assert.equal(explicit.geminiThinkingLevel, undefined);
  const disabled = resolveGenerationSettings({}, { geminiThinkingLevel: "off", geminiThinkingBudget: -2 });
  assert.equal(disabled.geminiThinkingBudget, 0);
  assert.equal(disabled.geminiThinkingLevel, undefined);
});

test("收费配置保留当前指令名称和金额，不再对名称做历史映射", () => {
  const commandCosts = [
    { command: "角色扮演", cost: 7 },
    { command: "bot对话", cost: 9 },
    { command: "视频生成", cost: 11 },
    { command: "AI聊天", cost: 13 },
  ];
  assert.deepEqual(EconomySchema.parse({ commandCosts }).commandCosts, commandCosts);
});

test("Tavily 正文模式使用当前枚举，布尔旧格式不再转换", () => {
  for (const includeRawContent of ["false", "markdown", "text"]) {
    assert.equal(TavilyMCPSchema.parse({ includeRawContent }).includeRawContent, includeRawContent);
  }
  assert.equal(TavilyMCPSchema.safeParse({ includeRawContent: true }).success, false);
  assert.equal(TavilyMCPSchema.safeParse({ includeRawContent: false }).success, false);
});
