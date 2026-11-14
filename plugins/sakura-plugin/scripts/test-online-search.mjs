// node --experimental-test-module-mocks --test plugins/sakura-plugin/scripts/test-online-search.mjs
// 验证“联网搜索”工具：委托搜索模型执行、结果格式，以及模型自带搜索时隐藏搜索类工具。不连接外部服务。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach, mock } from "node:test";
import { fileURLToPath } from "node:url";

globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {} };

const url = (relative) => new URL(relative, import.meta.url).href;
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "sakura-online-search-"));

let configs = {};
mock.module(url("../lib/path.js"), {
  namedExports: { plugindata: fixture, pluginRoot: fileURLToPath(new URL("../", import.meta.url)) },
});
mock.module(url("../lib/setting.js"), {
  defaultExport: { getConfig: (moduleName) => configs[moduleName] || {} },
});
mock.module(url("../lib/AIUtils/MCPManager.js"), { namedExports: { mcpManager: {} } });

// 除了联网搜索工具，其余工具用替身隔离。
const toolSource = fs.readFileSync(new URL("../lib/AIUtils/tools/tools.js", import.meta.url), "utf8");
for (const [, name, file] of toolSource.matchAll(/import \{ (\w+) \} from "\.\/([^"/]+Tool\.js)";/g)) {
  if (name === "OnlineSearchTool") continue;
  mock.module(url(`../lib/AIUtils/tools/${file}`), { namedExports: { [name]: class {
    name = name;
    function() { return { name, parameters: { type: "object", properties: {} } }; }
  } } });
}

const aiCalls = [];
let aiReply = null;
mock.module(url("../lib/AIUtils/getAI.js"), {
  namedExports: {
    getAI: async (...args) => {
      aiCalls.push(args);
      return typeof aiReply === "function" ? aiReply(...args) : aiReply;
    },
  },
});

const { getToolsSchema } = await import("../lib/AIUtils/tools/tools.js");
const { OnlineSearchTool, formatSearchResult } = await import("../lib/AIUtils/tools/OnlineSearchTool.js");

after(() => {
  assert.ok(path.resolve(fixture).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(fixture, { recursive: true, force: true });
});

const event = { self_id: 1, user_id: 2, isMaster: false };

function useConfig({ searchModels = ["grok"], tools = ["OnlineSearch", "McpTavily"] } = {}) {
  configs = {
    AI: { searchModels, toolGroups: [{ name: "常用", tools }] },
    Models: {
      models: [
        { provider: "中转", model: "grok", type: "chat", nativeWebSearch: true },
        { provider: "中转", model: "gem", type: "chat", nativeWebSearch: true },
        { provider: "中转", model: "deepseek", type: "chat", nativeWebSearch: false },
        { provider: "中转", model: "grok-image", type: "image", nativeWebSearch: true },
      ],
    },
  };
}

const localNames = (schema) => schema.localTools.map((tool) => tool.name);
const callTurn = (name, { previousTurn = false } = {}) => {
  const call = [
    { role: "model", parts: [{ functionCall: { id: "c1", name, args: {} } }], toolCallIds: ["c1"] },
    { role: "function", parts: [{ functionResponse: { id: "c1", name, response: {} } }] },
  ];
  return previousTurn
    ? [{ role: "user", parts: [{ text: "上一轮" }] }, ...call, { role: "model", parts: [{ text: "答" }] }, { role: "user", parts: [{ text: "这一轮" }] }]
    : [{ role: "user", parts: [{ text: "这一轮" }] }, ...call];
};

beforeEach(() => {
  aiCalls.length = 0;
  aiReply = { text: "整理后的结论", citations: [] };
  useConfig();
});

test("没有自带搜索的模型：工具组里勾了哪个搜索工具就提供哪个", async () => {
  const schema = await getToolsSchema(event, "常用", { nativeWebSearch: false });
  assert.deepEqual(localNames(schema), ["OnlineSearch"]);
  assert.deepEqual(schema.allowedMcpServerIds, ["tavily"]);

  useConfig({ tools: ["McpTavily"] });
  const tavilyOnly = await getToolsSchema(event, "常用", { nativeWebSearch: false });
  assert.deepEqual(localNames(tavilyOnly), []);
  assert.deepEqual(tavilyOnly.allowedMcpServerIds, ["tavily"]);
});

test("自带搜索的模型：联网搜索和 Tavily 都不提供", async () => {
  const schema = await getToolsSchema(event, "常用", { nativeWebSearch: true });
  assert.deepEqual(localNames(schema), []);
  assert.deepEqual(schema.allowedMcpServerIds, []);

  // 不传选项时保持原来的行为。
  const legacy = await getToolsSchema(event, "常用");
  assert.deepEqual(localNames(legacy), ["OnlineSearch"]);
});

test("本轮已经调用过的搜索工具，换到自带搜索的模型后仍然声明", async () => {
  const tavilyUsed = await getToolsSchema(event, "常用", {
    nativeWebSearch: true,
    history: callTurn("tavily_search"),
  });
  assert.deepEqual(localNames(tavilyUsed), []);
  assert.deepEqual(tavilyUsed.allowedMcpServerIds, ["tavily"]);

  const onlineUsed = await getToolsSchema(event, "常用", {
    nativeWebSearch: true,
    history: callTurn("OnlineSearch"),
  });
  assert.deepEqual(localNames(onlineUsed), ["OnlineSearch"]);
  assert.deepEqual(onlineUsed.allowedMcpServerIds, []);

  // 上一轮调用过的不算。
  const earlier = await getToolsSchema(event, "常用", {
    nativeWebSearch: true,
    history: callTurn("tavily_search", { previousTurn: true }),
  });
  assert.deepEqual(earlier.allowedMcpServerIds, []);
});

test("没有配置搜索模型时不提供联网搜索工具", async () => {
  useConfig({ searchModels: [] });
  const schema = await getToolsSchema(event, "常用", { nativeWebSearch: false });
  assert.deepEqual(localNames(schema), []);
  assert.deepEqual(schema.allowedMcpServerIds, ["tavily"]);
});

test("工具把问题交给开启了自带搜索的模型，不带上下文、历史和工具", async () => {
  useConfig({ searchModels: ["grok", "deepseek", "missing", "grok-image", "gem"] });
  aiReply = {
    text: "某游戏 3.2 版本于 11 月 12 日上线。",
    citations: [
      { url: "https://news.example/a", title: "官方公告" },
      { url: "https://x.com/dev/status/1", title: "" },
    ],
  };

  const output = await new OnlineSearchTool().func({ query: "某游戏最新版本是多少", context: "多余参数会被忽略" }, event);

  assert.equal(aiCalls.length, 1);
  const [models, e, queryParts, prompt, groupContext, tools, history] = aiCalls[0];
  assert.deepEqual(models, ["grok", "gem"]);
  assert.equal(e, event);
  assert.deepEqual(queryParts, [{ text: "某游戏最新版本是多少" }]);
  assert.match(prompt, /当前时间：\d{4}/);
  assert.equal(groupContext, false);
  assert.equal(tools, false);
  assert.deepEqual(history, []);

  assert.match(output, /^检索时间：/);
  assert.match(output, /3\.2 版本/);
  // 默认只列来源名称：有标题用标题，没有标题时 X 用账号，不带 URL。
  assert.match(output, /来源：官方公告、@dev$/);
  assert.equal(output.includes("https://"), false);

  const withLinks = await new OnlineSearchTool().func({ query: "出处", includeLinks: true }, event);
  assert.match(withLinks, /来源：\n1\. 官方公告 — https:\/\/news\.example\/a\n2\. @dev — https:\/\/x\.com\/dev\/status\/1$/);
});

test("Grok 的来源标题就是链接：X 帖子按账号命名并去重，其他网站用域名", () => {
  const urls = [
    "https://x.com/baumusyokunin/status/2121105591687111058",
    "https://x.com/sakuramiko35/status/2110295825251467281",
    "https://x.com/sakuramiko35/status/2116399317456236887",
    "https://twitter.com/i/web/status/1",
    "https://www.example.com/news/1",
  ];
  const result = { text: "结论", citations: urls.map((url) => ({ url, title: url })) };

  const plain = formatSearchResult(result);
  assert.match(plain, /来源：@baumusyokunin、@sakuramiko35、twitter\.com、example\.com$/);
  assert.equal(plain.includes("https://"), false);
});

test("Gemini 的跳转链接只保留名称，要链接时也不给出", () => {
  const redirect = (id) => `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${id}`;
  const result = {
    text: "结论",
    citations: [
      { url: redirect("a"), title: "ign.com" },
      { url: redirect("b"), title: "ign.com" },
      { url: redirect("c"), title: "" },
      { url: "https://www.example.com/post", title: "" },
    ],
  };

  assert.match(formatSearchResult(result), /来源：ign\.com、example\.com$/);
  const linked = formatSearchResult(result, { includeLinks: true });
  assert.match(linked, /1\. ign\.com（无可用链接）\n2\. example\.com — https:\/\/www\.example\.com\/post$/);
  assert.equal(linked.includes("vertexaisearch"), false);
});

test("工具的失败与边界情况", async () => {
  const tool = new OnlineSearchTool();
  assert.match(await tool.func({ query: "  " }, event), /需要提供要搜索的问题/);
  assert.equal(aiCalls.length, 0);

  aiReply = "模型“grok”请求失败：HTTP 503";
  assert.match(await tool.func({ query: "问题" }, event), /^联网搜索失败：模型“grok”请求失败/);

  useConfig({ searchModels: ["deepseek"] });
  assert.match(await tool.func({ query: "问题" }, event), /联网搜索不可用/);

  assert.equal(formatSearchResult({ text: "" }).includes("没有返回内容"), true);
  assert.equal(formatSearchResult({ text: "结论" }).includes("来源"), false);
});
