import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";
import chalk from "chalk";
import { watch } from "chokidar";
import { GroupAdminTool } from "./GroupAdminTool.js";
import { MessageContentAnalyzerTool } from "./MessageContentAnalyzerTool.js";
import { SearchMusicTool } from "./SearchMusicTool.js";
import { ImageGeneratorTool } from "./ImageGeneratorTool.js";
import { SendMusicTool } from "./SendMusicTool.js";
import { IllustrationTool } from "./IllustrationTool.js";
import { ReminderTool } from "./ReminderTool.js";
import { BlackListTool } from "./BlackListTool.js";
import { EconomyTool } from "./EconomyTool.js";
import { EmojiTool } from "./EmojiTool.js";
import { NaiTool } from "./NaiTool.js";
import { MemoryTool } from "./MemoryTool.js";
import { ImageSearchTool } from "./ImageSearchTool.js";
import { VoxCPMVoiceTool } from "./VoxCPMVoiceTool.js";
import { NaiGuideTool } from "./NaiGuideTool.js";
import { OnlineSearchTool } from "./OnlineSearchTool.js";
import { mcpManager } from "../MCPManager.js";
import Setting from "../../setting.js";
import {
  buildToolCallbackPayload,
  splitToolMediaResult,
} from "../toolResultProtocol.js";
import { buildToolResultLogPart } from "../toolResultLog.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const availableTools = [
  new GroupAdminTool(),
  new MessageContentAnalyzerTool(),
  new SearchMusicTool(),
  new ImageGeneratorTool(),
  new SendMusicTool(),
  new IllustrationTool(),
  new ReminderTool(),
  new BlackListTool(),
  new EconomyTool(),
  new EmojiTool(),
  new NaiTool(),
  new NaiGuideTool(),    // 随 Nai 一起开放
  new MemoryTool(),      // 添加用户或群公共记忆
  new ImageSearchTool(), // 统一搜图工具
  new VoxCPMVoiceTool(),
  new OnlineSearchTool(), // 委托搜索模型联网搜索
];

const toolMap = new Map(availableTools.map((tool) => [tool.name, tool]));

// 工具显示名称映射到配置中的key
const TOOL_CONFIG_KEYS = {
  "GroupAdmin": "GroupAdmin",
  "messageContentAnalyzer": "MessageContentAnalyzer",
  "searchMusic": "SearchMusic",
  "ImageGenerator": "ImageGenerator",
  "sendMusic": "SendMusic",
  "Illustration": "Illustration",
  "Reminder": "Reminder",
  "BlackList": "BlackList",
  "Economy": "Economy",
  "SendEmoji": "Emoji",
  "NaiPainting": "Nai",
  "NaiGuide": "Nai",
  "Memory": "Memory",
  "ImageSearch": "ImageSearch",
  "SendVoice": "VoxCPMVoice",
  "OnlineSearch": "OnlineSearch",
};

// MCP config key → server ID 映射
const MCP_KEY_TO_SERVER = {
  "McpFetch": "fetch",
  "McpTavily": "tavily",
};

// 所有可选工具（本地 + MCP）的 key 和中文 label，供前端和 API 使用
export const AVAILABLE_TOOL_OPTIONS = [
  { key: "OnlineSearch", label: "联网搜索" },
  { key: "McpTavily", label: "Tavily搜索(MCP)" },
  { key: "GroupAdmin", label: "群组管理" },
  { key: "MessageContentAnalyzer", label: "消息分析" },
  { key: "SearchMusic", label: "音乐搜索" },
  { key: "ImageGenerator", label: "图片生成" },
  { key: "SendMusic", label: "音乐发送" },
  { key: "Illustration", label: "插画工具" },
  { key: "Reminder", label: "提醒工具" },
  { key: "BlackList", label: "黑名单" },
  { key: "Economy", label: "经济系统" },
  { key: "Emoji", label: "表情包" },
  { key: "Nai", label: "NAI绘画" },
  { key: "Memory", label: "记忆工具" },
  { key: "ImageSearch", label: "图片搜索" },
  { key: "McpFetch", label: "网络请求(MCP)" },
  { key: "VoxCPMVoice", label: "语音发送" },
];

/**
 * 根据工具组名从配置中获取允许的工具 key 集合
 * @param {string} toolGroupName 工具组名
 * @returns {{ allowedTools: Set<string>, allowedMcpServerIds: string[] }}
 */
function resolveToolGroup(toolGroupName) {
  const aiConfig = Setting.getConfig("AI") || {};
  const toolGroups = aiConfig.toolGroups || [];
  const group = toolGroups.find(g => g.name === toolGroupName);
  if (!group) return { allowedTools: new Set(), allowedMcpServerIds: [] };

  const allowedTools = new Set(group.tools || []);
  const allowedMcpServerIds = [];
  for (const [mcpKey, serverId] of Object.entries(MCP_KEY_TO_SERVER)) {
    if (allowedTools.has(mcpKey)) {
      allowedMcpServerIds.push(serverId);
    }
  }
  return { allowedTools, allowedMcpServerIds };
}

export function toolGroupHasTool(toolGroupName, toolKey) {
  if (!toolGroupName || !toolKey) return false;
  return resolveToolGroup(toolGroupName).allowedTools.has(toolKey);
}

function resolveLocalToolInstances(e, allowedTools) {
  return availableTools.filter(tool => {
    const configKey = TOOL_CONFIG_KEYS[tool.name];
    if (!configKey || !allowedTools.has(configKey)) return false;
    // 工具可以声明自己当前不可用（例如缺少必要配置），这时不提供给模型。
    return typeof tool.isAvailable !== "function" || tool.isAvailable(e) !== false;
  });
}

// ─── 搜索类工具 ───────────────────────────────────────────
// 当前模型自带联网搜索时，只用自带搜索，不再提供这些工具。

const SEARCH_LOCAL_TOOL_NAMES = new Set(["OnlineSearch"]);
const SEARCH_MCP_SERVERS = {
  tavily: (toolName) => /^tavily[_-]/i.test(String(toolName || "")),
};

/**
 * 本轮（最后一条用户文字消息之后）已经调用过的工具名。
 * 这一轮中途换到自带搜索的模型时，这些工具仍要声明，历史里的调用和结果才能对上。
 */
function toolNamesCalledInCurrentTurn(history = []) {
  const names = new Set();
  if (!Array.isArray(history)) return names;

  let start = 0;
  for (let index = history.length - 1; index >= 0; index--) {
    const item = history[index];
    if (
      item?.role === "user" &&
      Array.isArray(item.parts) &&
      item.parts.some((part) => typeof part?.text === "string" && part.text.trim())
    ) {
      start = index + 1;
      break;
    }
  }

  for (const item of history.slice(start)) {
    if (item?.role !== "model" || !Array.isArray(item.parts)) continue;
    for (const part of item.parts) {
      if (part?.functionCall?.name) names.add(String(part.functionCall.name));
    }
  }
  return names;
}

export function filterSearchTools(
  { localToolInstances = [], allowedMcpServerIds = [] },
  { nativeWebSearch = false, history = [] } = {}
) {
  if (!nativeWebSearch) return { localToolInstances, allowedMcpServerIds };

  const calledNames = toolNamesCalledInCurrentTurn(history);
  const hidden = [];
  const filteredLocal = localToolInstances.filter((tool) => {
    if (!SEARCH_LOCAL_TOOL_NAMES.has(tool.name) || calledNames.has(tool.name)) return true;
    hidden.push(tool.name);
    return false;
  });
  const filteredServers = allowedMcpServerIds.filter((serverId) => {
    const isServerTool = SEARCH_MCP_SERVERS[serverId];
    if (!isServerTool || [...calledNames].some(isServerTool)) return true;
    hidden.push(serverId);
    return false;
  });

  if (hidden.length > 0) {
    logger.debug?.(`[Tools] 模型自带联网搜索，已隐藏搜索类工具：${hidden.join(", ")}`);
  }
  return { localToolInstances: filteredLocal, allowedMcpServerIds: filteredServers };
}

function buildToolContext(toolGroupName, localToolInstances) {
  const enabledTools = new Set();
  for (const tool of localToolInstances) {
    enabledTools.add(tool.name);
    const configKey = TOOL_CONFIG_KEYS[tool.name];
    if (configKey) enabledTools.add(configKey);
  }

  return {
    toolGroupName: String(toolGroupName || ""),
    enabledTools: [...enabledTools],
  };
}

function resolveToolContext(e, toolGroupName) {
  if (!toolGroupName) {
    return { toolGroupName: "", enabledTools: [] };
  }
  const { allowedTools } = resolveToolGroup(toolGroupName);
  const localToolInstances = resolveLocalToolInstances(e, allowedTools);
  return buildToolContext(toolGroupName, localToolInstances);
}

/**
 * @param {object} [options]
 * @param {boolean} [options.nativeWebSearch] 本次请求的模型是否开着自带联网搜索；是则隐藏搜索类工具
 * @param {Array} [options.history] 本次请求的对话历史，用于保留本轮已调用过的工具
 */
export async function getToolsSchema(e, toolGroupName, options = {}) {
  if (!toolGroupName) return { localTools: [], allowedMcpServerIds: [] };

  const { allowedTools, allowedMcpServerIds: groupMcpServerIds } = resolveToolGroup(toolGroupName);
  if (allowedTools.size === 0) return { localTools: [], allowedMcpServerIds: [] };

  const { localToolInstances, allowedMcpServerIds } = filterSearchTools(
    {
      localToolInstances: resolveLocalToolInstances(e, allowedTools),
      allowedMcpServerIds: groupMcpServerIds,
    },
    options
  );
  const toolContext = buildToolContext(toolGroupName, localToolInstances);
  const localTools = await Promise.all(
    localToolInstances.map(tool => tool.function(e, toolContext))
  );

  return { localTools, allowedMcpServerIds };
}

function normalizeToolAlias(toolName) {
  return String(toolName || "").replace(/-/g, "_");
}

// MCP 工具没有工具类，按名字给动作名和要展示的参数。
const firstUrl = (args = {}) => args.url || args.urls?.[0] || args.website;
const MCP_TOOL_NOTICE = {
  tavily_search: ["网页搜索", (args) => args.query || args.topic],
  tavily_extract: ["网页提取", firstUrl],
  tavily_map: ["站点地图", firstUrl],
  tavily_crawl: ["站点爬取", firstUrl],
  tavily_research: ["深度研究", (args) => args.query || args.topic],
  tavily_skill: ["技能检索", (args) => args.query || args.topic],
  fetch: ["网页抓取", (args) => args.url],
};

function buildNotice(action, detail) {
  if (!action) return null;
  // 节点里放完整详情，不截断；只有转发外显的预览会缩短
  const text = typeof detail === "string" ? detail.trim() : "";
  // 动作名已经是转发标题，节点里只放详情；没有详情时才写动作名
  return { action, lines: [{ text: text || action }] };
}

/**
 * 一次工具调用在工具调用转发里展示什么；返回 null 表示不展示。
 * @returns {import("../toolProgress.js").ToolCallNotice|null}
 */
function describeToolCall({ name, args } = {}) {
  const toolArgs = args || {};
  const tool = toolMap.get(name);
  if (tool) {
    const action = typeof tool.getProgressText === "function" ? tool.getProgressText(toolArgs) : null;
    if (!action) return null;
    // NAI 把主提示词和每个角色的提示词分开列出来
    if (name === "NaiPainting") {
      const mainPrompt = String(toolArgs.prompt || "").trim() || "（未提供 Prompt）";
      const characters = (Array.isArray(toolArgs.characters) ? toolArgs.characters : [])
        .map((character) => String(character?.prompt || "").trim())
        .filter(Boolean);
      return {
        action: "NAI 绘画",
        lines: [
          { nickname: "主 Prompt", text: mainPrompt },
          ...characters.map((text, index) => ({ nickname: `角色 ${index + 1} Prompt`, text })),
        ],
      };
    }
    const detail = typeof tool.getProgressDetail === "function" ? tool.getProgressDetail(toolArgs) : "";
    return buildNotice(action, detail);
  }

  const alias = normalizeToolAlias(name);
  const mcpNotice = MCP_TOOL_NOTICE[alias];
  if (mcpNotice) {
    const [action, getDetail] = mcpNotice;
    return buildNotice(action, getDetail(toolArgs));
  }
  return buildNotice(alias, "");
}

/** 一批工具调用要展示的内容；不需要展示的工具不在其中 */
export function describeToolCalls(functionCalls = []) {
  return functionCalls.map(describeToolCall).filter(Boolean);
}

/**
 * 执行单个工具调用
 */
async function executeSingleTool(functionCall, e, toolContext) {
  const { name: toolName, args: toolArgs, id: toolCallId } = functionCall;

  let toolResultData = null;
  let mediaParts = [];
  const toolToExecute = toolMap.get(toolName);

  if (toolToExecute) {
    logger.info(`正在执行工具："${toolName}" ${JSON.stringify(toolArgs)}`);
    try {
      const rawResult = await toolToExecute.func(toolArgs, e, toolContext);
      const splitResult = splitToolMediaResult(rawResult);
      const resultForResponse = splitResult.response;

      if (typeof resultForResponse === "string") {
        toolResultData = { message: resultForResponse };
      } else {
        toolResultData = JSON.parse(JSON.stringify(resultForResponse || {}));
      }
      mediaParts = splitResult.mediaParts;
    } catch (toolError) {
      logger.error(`工具 "${toolName}" 执行失败:`, toolError);
      toolResultData = {
        error: `工具执行失败: ${toolError.message || "未知错误"}`,
      };
    }
  } else {
    // 尝试通过 MCP 执行
    logger.info(`尝试通过 MCP 执行工具："${toolName}"`);
    try {
      const rawResult = await mcpManager.callTool(toolName, toolArgs, Boolean(e?.isMaster));
      toolResultData = { message: rawResult };
    } catch (mcpError) {
      logger.warn(`MCP 工具 "${toolName}" 执行失败: ${mcpError.message}`);
      toolResultData = { error: `MCP 工具执行失败: ${mcpError.message}` };
    }
  }

  const functionResponsePart = {
    functionResponse: {
      name: String(toolName),
      response: toolResultData,
    },
  };

  if (toolCallId) {
    functionResponsePart.functionResponse.id = toolCallId;
  }
  // 工具返回的图片直接挂在这次工具结果上，模型在同一次请求里就能看到。
  if (mediaParts.length > 0) {
    functionResponsePart.functionResponse.parts = mediaParts;
  }

  const functionResponsePartForLog = buildToolResultLogPart(functionResponsePart);
  logger.info(
    `${toolName}工具执行结果: ${JSON.stringify(
      functionResponsePartForLog,
      null,
      2
    )}`
  );

  return { functionResponsePart };
}

/**
 * @param {object} [options]
 * @param {import("../toolProgress.js").ToolCallForward|null} [options.progress] 本次 Agent 运行的工具调用转发
 */
export async function executeToolCalls(
  e,
  initialFunctionCalls,
  toolGroupName = "",
  { progress = null } = {}
) {
  if (!initialFunctionCalls || initialFunctionCalls.length === 0) {
    return { historyContents: [] };
  }

  const toolContext = resolveToolContext(e, toolGroupName);

  progress?.add(describeToolCalls(initialFunctionCalls));
  const toolExecutionResults = await Promise.all(
    initialFunctionCalls.map((fc) => executeSingleTool(fc, e, toolContext))
  );

  return buildToolCallbackPayload(toolExecutionResults);
}

// ─── 热重载 ──────────────────────────────────────────────

const IGNORED_FILES = new Set(["tools.js", "AbstractTool.js"]);

/**
 * 动态重载单个工具文件
 * 利用 import() 的 query-string 绕过 ESM 模块缓存
 */
async function reloadTool(filename) {
  const filePath = join(__dirname, filename);
  const fileUrl = pathToFileURL(filePath).href + `?t=${Date.now()}`;

  const mod = await import(fileUrl);

  // 约定：每个文件导出一个名称以 Tool 结尾的类
  const ToolClass = Object.values(mod).find(
    (v) => typeof v === "function" && /Tool$/.test(v.name)
  );
  if (!ToolClass) {
    logger.warn(chalk.yellow(`[Tools] ${filename} 中未找到 *Tool 类，跳过`));
    return;
  }

  const instance = new ToolClass();
  if (!instance.name) {
    logger.warn(chalk.yellow(`[Tools] ${filename} 实例缺少 name 属性，跳过`));
    return;
  }

  const idx = availableTools.findIndex((t) => t.name === instance.name);
  if (idx !== -1) {
    availableTools[idx] = instance;
    toolMap.set(instance.name, instance);
    logger.info(
      chalk.green(`[Tools] 🔄 已重载: ${chalk.bold(instance.name)} (${filename})`)
    );
  } else {
    availableTools.push(instance);
    toolMap.set(instance.name, instance);
    logger.info(
      chalk.cyan(`[Tools] ➕ 新工具已加载: ${chalk.bold(instance.name)} (${filename})`)
    );
  }
}

/**
 * 启动热重载 —— 使用 chokidar 监听当前 tools 目录，自动刷新变更的工具
 */
function setupTools() {
  try {
    const debounceMap = new Map();

    const handleChange = (filePath) => {
      const filename = filePath.split(/[\\/]/).pop();
      if (!filename?.endsWith(".js") || IGNORED_FILES.has(filename)) return;

      // 防抖 500ms，编辑器连续保存时只触发一次
      if (debounceMap.has(filename)) clearTimeout(debounceMap.get(filename));

      debounceMap.set(
        filename,
        setTimeout(async () => {
          debounceMap.delete(filename);
          try {
            await reloadTool(filename);
          } catch (err) {
            logger.error(
              chalk.red(`[Tools] ❌ 重载失败 ${filename}: ${err.message}`)
            );
          }
        }, 500)
      );
    };

    const watcher = watch(join(__dirname, "*.js"), {
      ignoreInitial: true,
      persistent: false,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 },
    });

    watcher
      .on("change", handleChange)
      .on("add", handleChange);

  } catch (err) {
    logger.warn(chalk.red("[Tools] 启动失败: " + err.message));
  }
}

setupTools();
