import { z } from 'zod';
import { MODEL_TYPES } from './lib/AIUtils/aiModels.js';
import { CronExpressionParser } from 'cron-parser';
import { DEFAULT_NAI_URL, normalizeNaiUrl } from './lib/nai/apiConfig.js';
import {
    DEFAULT_TAVILY_MAX_RESULTS,
    DEFAULT_TAVILY_MCP_URL,
    DEFAULT_TAVILY_SEARCH_DEPTH,
    MAX_TAVILY_SEARCH_RESULTS,
    TAVILY_SEARCH_DEPTH_OPTIONS,
    TAVILY_RAW_CONTENT_OPTIONS,
} from './lib/AIUtils/tavilyConfig.js';

const OPENAI_REASONING_EFFORT_OPTIONS = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
// Gemini 3 起只用 thinkingLevel，官方共五档，每个模型只支持其中一部分；没有“关闭”，
// 旧配置里的 off 按最接近的 minimal 处理。
const GEMINI_THINKING_LEVEL_OPTIONS = ['default', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const geminiThinkingLevel = z.preprocess(
    (value) => (value === 'off' ? 'minimal' : value),
    z.enum(GEMINI_THINKING_LEVEL_OPTIONS),
);

const nonEmptyString = (label) => z.string().trim().min(1, `${label}不能为空`);

const DEFAULT_MODEL_LIST_HELP = '可以选多个，排在前面的优先，失败时自动换下一个';
const modelList = (label, kind, help = DEFAULT_MODEL_LIST_HELP, directives = '') => z.array(z.string().trim().min(1))
    .default([])
    .describe(`${label}|${directives ? `${directives}|` : ''}#modelList:${kind}|${help}`);

function addUniqueFieldIssues(items, field, ctx, pathPrefix = []) {
    const seen = new Set();
    items.forEach((item, index) => {
        const value = item?.[field];
        if (!value) return;
        if (seen.has(value)) {
            ctx.addIssue({
                code: 'custom',
                path: [...pathPrefix, index, field],
                message: `“${value}”重复了`,
            });
        }
        seen.add(value);
    });
}

function cronString(defaultValue = '0 * * * *') {
    return z.string().default(defaultValue).refine((val) => {
        if (!val || !val.trim()) return false;
        const parts = val.trim().split(/\s+/);
        if (parts.length !== 5) return false;
        try {
            CronExpressionParser.parse(val);
            return true;
        } catch {
            return false;
        }
    }, { message: 'Cron 表达式格式无效，请使用标准 5 段式 cron 格式' });
}

export const commandNames = {
    "setuPlugin.handleApiRequest": "来张涩图",
    "GetImagePlugin.handleImage": "来张萝莉图",
    "VideoGeneration.generateVideo": "视频生成",
    "BiliUidAnalyzer.queryUid": "B站UID分析",
    "KeywordReply.添加词条": "添加词条",
    "KeywordReply.删除词条": "删除词条",
    "memesPlugin.memes": "表情包制作",
    "memesPlugin.randomMemes": "随机表情包",
    "pixivSearch.getPixivByPid": "pid（P站搜图）",
    "pixivSearch.searchPixiv": "来张插画",
    "AIChat.Chat": "角色扮演",
    "EditImage.dispatchHandler": "AI图片编辑",
    "NaiPainting.naiParams": "绘图",
    "Mimic.Mimic": "bot对话",
    "VoxCPMVoice.generateVoice": "语音生成",
    "pixivSearch.viewRanking": "p站排行榜",
    "pixivSearch.getRankingItem": "p站排行榜详情",
    "SearchImage.imageSearch": "搜图",
};

export const manualCommandNames = [
];

export const News60sSchema = z.object({
    Groups: z.array(z.number()).default([]).describe('推送群号列表|#groupSelect|选择需要推送60秒新闻的QQ群号'),
}).describe('60秒新闻推送');

export const GroupInsightSchema = z.object({
    autoDailyReport: z.boolean().default(true).describe('自动群聊日报|每天23:59为当天活跃群生成实时报告，不读取或写入报告缓存'),
    Groups: z.array(z.number()).default([]).describe('日报群号|#groupSelect|留空时向所有当天达到消息门槛的已记录群发送'),
}).describe('群聊洞见');

const ProfileSchema = z.object({
    prefixes: z.array(nonEmptyString('触发前缀')).min(1, '至少配置一个触发前缀').describe('触发前缀|消息以这些前缀开头时触发；第一个为主前缀，其余为别名，匹配时最长前缀优先'),
    name: z.string().default('').describe('人设|#roleSelect|使用哪个人设的提示词，在“人设”页面里编辑'),
    models: modelList('模型', 'chat'),
    toolGroup: z.string().default('').describe('工具组|#toolGroupSelect|允许 AI 调用哪些工具，留空则不使用工具'),
    groupContext: z.boolean().default(false).describe('读取群聊上下文|把最近的群聊消息一起发给 AI'),
    currentTime: z.boolean().default(true).describe('附带当前时间|在提示词末尾写上当前北京时间；不需要时间感的设定（如纯角色扮演、翻译）可以关掉'),
    history: z.boolean().default(true).describe('保存对话历史|关闭后每次对话都从头开始'),
    enableNaiPainting: z.boolean().default(false).describe('聊天自动配图|回复后用 NovelAI 按当前场景画一张图'),
    naiPrompt: z.string().default('').describe('配图附加提示词|#textarea|#showIf:enableNaiPainting=true|追加到自动生成的绘图标签后面'),
});

const ToolGroupSchema = z.object({
    name: z.string().default('').describe('工具组名称'),
    tools: z.array(z.string()).default([]).describe('工具|#toolMultiSelect|这个组里允许 AI 调用的工具'),
});

const AIObjectSchema = z.object({
    profiles: z.array(ProfileSchema).default([]).describe('触发设定|#group:触发设定|#nameField:prefixes|#summary:name,models|用什么前缀触发、用哪个人设、调用哪些模型'),
    toolGroups: z.array(ToolGroupSchema).default([]).describe('工具组|#group:工具组|#nameField:name|#summary:tools|把常用的工具组合起来，在触发设定和伪人里选择'),
    groupContextLength: z.number().int().min(0).default(20).describe('群聊上下文条数|#group:对话参数|开启“读取群聊上下文”时带上的最近消息数'),
    chatHistoryLength: z.number().int().min(0).default(20).describe('对话历史条数|#group:对话参数|每个用户保留的历史消息数'),
    maxToolCalls: z.number().int().min(1).default(20).describe('单次最多调用工具次数|#group:对话参数|超过后强制结束本次回复'),
    enableUserLock: z.boolean().default(false).describe('单人锁|#group:对话参数|同一用户在同一群里一次只处理一条消息（AI 对话和伪人共用）'),
    toolCallForward: z.boolean().default(true).describe('工具调用转发|#group:对话参数|AI 调用工具时用一条合并转发说明在做什么（搜索词、绘画提示词等），同时调用的多个工具并成一条；关闭后不发'),
    enableMarkdownProcess: z.boolean().default(true).describe('处理 Markdown|#group:Markdown 输出|短文本去掉格式，长文本渲染成图片；关闭则原样发送'),
    markdownPlainTextLimit: z.number().int().min(0).default(300).describe('转图片字数阈值|#group:Markdown 输出|#showIf:enableMarkdownProcess=true|少于这个字数时按纯文本发送'),
    markdownSplitImageLimit: z.number().int().min(0).default(0).describe('拆图字数阈值|#group:Markdown 输出|#showIf:enableMarkdownProcess=true|超过这个字数时拆成两张图片；0 表示不拆'),
    utilityModels: modelList('后台辅助模型', 'chat', '用于欢迎词、记忆整理、提醒改写、表情识图等后台任务；可以选多个，排在前面的优先', '#group:后台任务'),
    memoryIdleMinutes: z.number().int().min(1).max(1440).default(20).describe('记忆提取等待时间（分钟）|#group:后台任务|用户停止对话这么久后自动提取个人记忆（前缀角色和伪人都适用）；伪人的连续对话上下文也在这时清除'),
    geminiModels: modelList('Gemini 能力模型', 'chat:gemini', '用于向量检索和视频分析，只能选 Gemini / Vertex 供应商的模型；不选则这些功能不可用', '#group:后台任务'),
    searchModels: modelList('搜索模型', 'chat:search', '“联网搜索”工具交给这些模型去查，只能选开启了“联网搜索”的模型；可以选多个，排在前面的优先，失败时换下一个；不选则不提供这个工具', '#group:联网搜索'),
    gcsBucket: z.string().default('').describe('GCS Bucket|#group:后台任务|#advanced|Vertex 视频分析上传文件用的 Cloud Storage bucket'),
    gcsPrefix: z.string().default('sakura-message-videos').describe('GCS 目录|#group:后台任务|#advanced|Vertex 视频分析的临时文件目录'),
}).superRefine((config, ctx) => {
    const seen = new Set();
    config.profiles.forEach((profile, profileIndex) => {
        profile.prefixes.forEach((prefix, prefixIndex) => {
            if (seen.has(prefix)) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['profiles', profileIndex, 'prefixes', prefixIndex],
                    message: `触发前缀“${prefix}”重复`,
                });
            }
            seen.add(prefix);
        });
    });
}).describe('AI 对话|触发方式、工具和后台任务模型');

export const AISchema = AIObjectSchema;

export const TavilyMCPSchema = z.object({
    apiKey: z.string().default('').describe('API Key|Tavily Remote MCP API Key'),
    baseURL: z.string().default(DEFAULT_TAVILY_MCP_URL).describe('Remote MCP URL|通常保持默认即可'),
    includeFavicon: z.boolean().default(true).describe('默认返回图标|作为 Tavily MCP 的默认参数'),
    includeImages: z.boolean().default(false).describe('默认返回图片|作为 Tavily MCP 的默认参数'),
    includeRawContent: z.enum(TAVILY_RAW_CONTENT_OPTIONS).default('false').describe('正文返回模式|false=不返回, markdown=返回Markdown正文, text=返回纯文本正文'),
    searchDepth: z.enum(TAVILY_SEARCH_DEPTH_OPTIONS).default(DEFAULT_TAVILY_SEARCH_DEPTH).describe('默认搜索深度|basic/advanced/fast/ultra-fast'),
    maxResults: z.number().int().min(1).max(MAX_TAVILY_SEARCH_RESULTS).default(DEFAULT_TAVILY_MAX_RESULTS).describe('默认结果数量|当前 Tavily 搜索结果上限为 20'),
}).describe('Tavily MCP');

export const ActiveChatSchema = z.object({
    Groups: z.array(z.number()).default([]).describe('主动聊天群号|#groupSelect|在这些群中启用主动聊天功能'),
}).describe('主动聊天');

export const AutoCleanupSchema = z.object({
    groups: z.array(z.number()).default([]).describe('自动清理群号|#groupSelect|清除小于1级和半年未发言的人'),
}).describe('自动清理');

const ProviderSchema = z.object({
    name: nonEmptyString('供应商名称').describe('名称|#placeholder:例如 OpenAI、中转站|添加模型时用这个名字选择供应商'),
    protocol: z.enum(['openai', 'gemini']).default('openai').describe('接口协议|#optionLabels:openai=OpenAI 兼容,gemini=Google Gemini'),
    baseURL: z.string().trim().default('').describe('API 地址|#placeholder:留空使用官方地址|OpenAI 兼容的中转地址通常以 /v1 结尾'),
    vertex: z.boolean().default(false).describe('使用 Vertex AI|#showIf:protocol=gemini|开启后用服务账号 JSON 鉴权，不再使用 API Key'),
    apiKeys: z.array(z.string().trim().min(1, 'API Key 不能为空')).default([]).describe('API Key|#secretList|#showIf:vertex!=true|可以添加多个，请求时轮流使用，失败自动换下一个'),
    serviceAccounts: z.array(z.string().trim().min(1)).default([]).describe('服务账号|#vertexCredentialList|#showIf:vertex=true|导入并验证服务账号 JSON，私钥不会写入普通配置'),
}).superRefine((provider, ctx) => {
    if (provider.vertex === true && provider.protocol !== 'gemini') {
        ctx.addIssue({ code: 'custom', path: ['vertex'], message: 'Vertex AI 只能用于 Gemini 协议' });
    }
    if (provider.protocol === 'gemini' && provider.vertex === true) {
        if (provider.serviceAccounts.length === 0) {
            ctx.addIssue({ code: 'custom', path: ['serviceAccounts'], message: `供应商“${provider.name}”至少需要一个服务账号` });
        }
    } else if (provider.apiKeys.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['apiKeys'], message: `供应商“${provider.name}”至少需要一个 API Key` });
    }
});

export const ProvidersSchema = z.object({
    providers: z.array(ProviderSchema).default([]).describe('供应商|#nameField:name|#summary:protocol,vertex,baseURL|API 地址和 Key 只在这里填一次，所有模型共用'),
}).superRefine((config, ctx) => {
    addUniqueFieldIssues(config.providers, 'name', ctx, ['providers']);
}).describe('供应商|填写 API 地址和 Key');

const MODEL_TYPE_LABELS = 'chat=对话,image=图片生成,video=视频生成';

const ModelSchema = z.object({
    provider: nonEmptyString('供应商').describe('供应商|#providerSelect'),
    model: nonEmptyString('模型').describe('模型|#modelSelect|从供应商的模型列表里选'),
    type: z.enum(MODEL_TYPES).default('chat').describe(`用途|#optionLabels:${MODEL_TYPE_LABELS}|决定它出现在哪些模型选择框里`),
    nativeWebSearch: z.boolean().default(false).describe('联网搜索|#showIf:type=chat|使用模型自带的联网搜索；OpenAI 兼容端点传 web_search，Gemini 传 Google Search'),
    openaiReasoningEffort: z.enum(OPENAI_REASONING_EFFORT_OPTIONS).default('default').describe('思考等级|#showIf:type=chat|#protocol:openai|#optionLabels:default=模型默认,none=不思考,minimal=最少,low=低,medium=中,high=高,xhigh=很高,max=最高'),
    geminiThinkingLevel: geminiThinkingLevel.default('default').describe('思考等级|#showIf:type=chat|#protocol:gemini|#optionLabels:default=模型默认,minimal=最少,low=低,medium=中,high=高,xhigh=很高|各模型支持的档位不同：最少只有 Gemini 3.x Flash / Flash-Lite 有，很高只有 Gemini 4 Hydrogen / Neon 有；选了模型不支持的档位会请求失败。Gemini 2.5 只能用模型默认'),
    videoApiFormat: z.enum(['grok', 'openai']).default('grok').describe('视频接口|#showIf:type=video|#protocol:openai|#optionLabels:grok=Grok/CPA,openai=OpenAI|Grok/CPA 走 /videos/generations；OpenAI 走标准 Videos API（/videos），适用于 Seedance、可灵等中转站'),
    name: z.string().trim().default('').describe('别名|#advanced|#placeholder:留空就用模型名|同一个模型要配两套参数，或者不同供应商有同名模型时才需要填'),
    stream: z.boolean().default(false).describe('流式响应|#advanced|#showIf:type=chat|边生成边接收，全部收完后再回复；某些中转站只有流式才稳定'),
    openaiEnableThinking: z.boolean().default(false).describe('enable_thinking 开关|#advanced|#showIf:type=chat|#protocol:openai|向兼容端点额外传入非标准的 enable_thinking 参数'),
    timeoutSeconds: z.number().int().min(0).max(3600).default(0).describe('超时（秒）|#advanced|0 表示按用途使用默认值：对话和图片 300 秒，视频 900 秒'),
});

export const ModelsSchema = z.object({
    models: z.array(ModelSchema).default([]).describe('模型|#modelEntries|#summary:provider,type|每个模型配置一次，之后在角色、伪人、图片生成等地方直接按名字选择'),
}).superRefine((config, ctx) => {
    const seen = new Map();
    config.models.forEach((entry, index) => {
        const key = entry.name || entry.model;
        if (!key) return;
        if (seen.has(key)) {
            ctx.addIssue({
                code: 'custom',
                path: ['models', index, entry.name ? 'name' : 'model'],
                message: `模型“${key}”重复了；同一个模型要配两套参数时，请给其中一个填写别名`,
            });
        }
        seen.set(key, index);
    });
}).describe('模型|一个模型配置一次，到处按名字选择');

const EditTaskSchema = z.object({
    trigger: z.string().default('').describe('触发词|发送这个词并附上图片时执行编辑'),
    prompt: z.string().default('').describe('提示词|#textarea|发给图片模型的编辑指令'),
});

const EditImageObjectSchema = z.object({
    imageModels: modelList('图片模型', 'image', '命令里没指定模型时使用；可以选多个，排在前面的优先', '#group:图片生成'),
    gptQuality: z.enum(['auto', 'low', 'medium', 'high', 'xhigh', 'max']).default('auto').describe('GPT 默认画质|#group:图片生成|#optionLabels:auto=自动,low=低,medium=中,high=高,xhigh=很高,max=最高'),
    gifModels: modelList('GIF 模型', 'image', '生成动图时使用；不选则沿用图片模型', '#group:GIF 动图'),
    gifFrameCount: z.number().int().min(2).max(16).default(9).describe('帧数|#group:GIF 动图|#step:1'),
    gifFrameDurationMs: z.number().int().min(20).max(2000).multipleOf(10).default(200).describe('每帧时长（毫秒）|#group:GIF 动图|#step:10'),
    videoModels: modelList('视频模型', 'video', '命令里没指定模型时使用；可以选多个，排在前面的优先', '#group:视频生成'),
    tasks: z.array(EditTaskSchema).default([]).describe('快捷编辑指令|#group:快捷编辑指令|#nameField:trigger|#summary:prompt|发送触发词加图片即可按预设提示词编辑'),
}).describe('图片与视频生成|模型、画质和快捷编辑指令');

export const EditImageSchema = EditImageObjectSchema;

export const EmojiThiefSchema = z.object({
    Groups: z.array(z.number()).default([]).describe('启用群号|#groupSelect|在这些群中启用表情包学习'),
    rate: z.number().default(1).describe('回复概率|触发回复的概率'),
    vectorRate: z.number().default(0.1).describe('矢量概率|#step:0.01|学习表情的概率'),
    searchTopK: z.number().int().min(1).max(20).default(3).describe('检索候选数|#step:1|从相似度最高的这些表情中随机选择'),
    searchMinScore: z.number().min(0).max(1).default(0.65).describe('最低相似度|#step:0.01|低于此相似度的表情不会被发送'),
}).describe('表情包学习');


const VoxCPMVoiceRoleSchema = z.object({
    name: z.string().default('少女').describe('角色名|触发方式：角色名说 内容，可加 # 前缀'),
    prompt: z.string().default('一个可爱的少女').describe('声音描述|#textarea|作为 VoxCPM 的 Control Instruction，可留空仅使用参考语音'),
    referenceAudioPath: z.string().default('').describe('参考语音路径|添加角色时可自动保存到 data/voxcpm-voice/roles'),
});

export const VoxCPMVoiceSchema = z.object({
    defaultRole: z.string().default('少女').describe('默认角色名|#voiceRoleSelect|未指定角色时使用，例如“说 内容”；从角色列表中读取同名配置'),
    aiDefaultRole: z.string().default('少女').describe('AI默认角色名|#voiceRoleSelect|AI工具发送语音时固定使用；从角色列表中读取同名配置'),
    roles: z.array(VoxCPMVoiceRoleSchema).default([
        { name: '少女', prompt: '一个可爱的少女', referenceAudioPath: '' },
    ]).describe('角色列表|#nameField:name|配置“角色名说 内容”的角色声音描述；未指定角色时可用“说 内容”'),
}).describe('VoxCPM 语音生成');

export const BilicookieSchema = z.object({
    cookie: z.string().default('').describe('B站Cookie|#textarea|用于解析B站链接的Cookie'),
    autoResolve: z.boolean().default(true).describe('自动解析|是否自动解析群内的B站链接'),
}).describe('B站解析');

export const DouyinSchema = z.object({
    enable: z.boolean().default(true).describe('启用抖音解析|关闭后不再响应抖音链接和解析指令'),
    autoResolve: z.boolean().default(true).describe('自动解析|是否自动解析消息中的抖音链接；关闭后仍可使用“#抖音解析”'),
    browserFallback: z.boolean().default(true).describe('浏览器自动回退|优先直接请求作品与评论接口；受限时使用本机无头 Chrome 读取作品详情或刷新评论访问 Cookie'),
    cookie: z.string().default('').describe('抖音Cookie|#textarea|可留空匿名尝试；遇到访问验证时填写浏览器登录 www.douyin.com 后的完整 Cookie'),
    cooldownSeconds: z.number().int().min(0).max(300).default(15).describe('解析冷却(秒)|同一群或私聊两次解析之间的最短间隔；主人不受限制'),
    maxVideoSizeMB: z.number().int().min(1).max(500).default(80).describe('视频大小上限(MB)|超过后只发送作品信息和原链接'),
    maxVideoDurationSeconds: z.number().int().min(0).max(3600).default(600).describe('视频时长上限(秒)|设为0表示不限制，超过后不下载视频'),
    maxGalleryImages: z.number().int().min(1).max(20).default(12).describe('图文图片上限|单个作品最多下载并发送的图片数量'),
    commentsEnabled: z.boolean().default(true).describe('展示评论卡片|获取作品前10条一级评论，卡片和评论配图会作为同一节点追加到合并转发消息'),
    maxComments: z.number().int().min(1).max(10).default(10).describe('一级评论上限|每个作品最多渲染的一级评论卡片数量'),
    maxCommentReplies: z.number().int().min(0).max(3).default(3).describe('二级评论上限|每张一级评论卡片最多展示的二级评论数量'),
}).describe('抖音解析');

export const CoolSchema = z.object({
    Groups: z.array(z.number()).default([]).describe('启用群号'),
    randomIntervalMin: z.number().default(30).describe('最小间隔(秒)|随机冷却的最小间隔'),
    randomIntervalMax: z.number().default(60).describe('最大间隔(秒)|随机冷却的最大间隔'),
}).describe('冷群发图');

export const NaiSchema = z.object({
    key: z.string().trim().default('').describe('API Key|填写官方或第三方接口的 API Key'),
    url: z.string().trim().default(DEFAULT_NAI_URL).refine((value) => {
        try { normalizeNaiUrl(value); return true; } catch { return false; }
    }, '请填写 HTTP 或 HTTPS 基础地址，不含账号、查询参数或片段').describe('API URL|填写官方或第三方基础地址，接口路径会自动追加'),
    model: z.string().default('nai-diffusion-4-5-full').describe('模型'),
    quality: z.string().default('very aesthetic, masterpiece').describe('质量提示词|#textarea|默认追加到正面提示词末尾，逗号分隔；留空则不追加'),
    negative: z.string().default('nsfw, lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page').describe('负面提示词|默认负面提示词'),
    chatDrawCount: z.number().int().min(1).max(4).default(1).describe('聊天绘图数量|一次聊天生成 1–4 张；多张拆成连续单张请求，每张生成后立即排队发送且不阻塞下一张生图'),
    chatDrawPrompt: z.string().default(`**[RP Visual Snapshot — tag only, no image-tool call]**
Continue the roleplay response normally. Do not call an image-generation tool for this snapshot. At the absolute end of the response, append exactly one compact <draw>...</draw> block for the backend to render asynchronously. The closing </draw> tag must be the final characters of the response.

Inside <draw>, describe only one concrete visible frame from the current moment, in this order:
1. Visible character count and identity.
2. Stable visible appearance when needed, then current clothing and accessories.
3. Pose, action, physical interaction, expression, gaze, and any visible situational changes.
4. Immediate environment, time, weather, and important props.
5. Framing, camera angle, relative placement, lighting, color mood, and relevant visual effects.

Rules:
- Use accurate English NovelAI/Danbooru-style tags separated by commas. For a complex interaction or spatial relationship, add one complete English sentence after the tag anchors; do not use broken sentence fragments.
- For a known anime/game character, begin with the recognized English character tag. For an original character, begin with 1girl, 1boy, or another accurate count and include the stable visible traits established by the role.
- Describe the current scene, not a generic character sheet. Preserve continuity with the roleplay history and do not invent extra people, clothing changes, camera text, watermarks, dialogue boxes, or a new art style.
- Include only visually observable information. Do not put thoughts, personality, backstory, sounds, smells, or spoken dialogue into the image prompt. Spoken dialogue is not visible image text unless the user explicitly asks for text in the picture.
- Keep it concise: one line, normally 12–30 comma-separated visual items. Do not use Markdown fences and do not output more than one <draw> block.

Example:
<draw>1girl, original character, long silver hair, blue eyes, oversized white shirt, sitting on the edge of a bed, leaning toward viewer, one hand reaching forward, warm blush, gentle smile, looking at viewer, cozy bedroom at night, bedside lamp, cowboy shot, eye-level, slightly left of center, warm backlighting, shallow depth of field</draw>`).describe('聊天自动绘图指令|#textarea|角色开启NAI绘图时追加到系统提示词；只追加绘图标签并按聊天绘图数量异步生成，不调用绘图工具；留空则不追加'),
}).describe('NovelAI 绘画');

const CommandCostSchema = z.object({
    command: z.string().describe('指令名称'),
    cost: z.number().int().min(0).default(0).describe('消耗樱花币'),
});

const defaultCommandCosts = [
    { command: "来张涩图", cost: 5 },
    { command: "来张萝莉图", cost: 5 },
    { command: "视频生成", cost: 20 },
    { command: "B站UID分析", cost: 5 },
    { command: "添加词条", cost: 50 },
    { command: "删除词条", cost: 50 },
    { command: "表情包制作", cost: 5 },
    { command: "随机表情包", cost: 5 },
    { command: "pid（P站搜图）", cost: 5 },
    { command: "来张插画", cost: 5 },
    { command: "角色扮演", cost: 10 },
    { command: "AI图片编辑", cost: 20 },
    { command: "绘图", cost: 30 },
    { command: "bot对话", cost: 10 },
    { command: "语音生成", cost: 5 },
    { command: "p站排行榜", cost: 20 },
    { command: "p站排行榜详情", cost: 5 },
    { command: "搜图", cost: 5 },
];

const EconomyObjectSchema = z.object({
    enable: z.boolean().default(true).describe('启用经济系统'),
    Groups: z.array(z.number()).default([]).describe('经济群号|#groupSelect|启用后指令将消耗樱花币'),
    gamegroups: z.array(z.number()).default([]).describe('游戏群号|#groupSelect|启用经济游戏功能的群'),
    fishingEncounterChance: z.number().min(0).max(1).default(0.1).describe('钓鱼遭遇概率|#step:0.01|通过重量判定、困难度判定前的水路遭遇概率；好运护符和首领不触发，0关闭，1每次触发'),
    commandCosts: z.array(CommandCostSchema).default(defaultCommandCosts).describe('指令消耗配置|#commandCost|配置各指令消耗的樱花币数量'),
}).describe('经济系统');

export const EconomySchema = EconomyObjectSchema;

const ForwardRuleSchema = z.object({
    sourceGroupIds: z.array(z.number()).default([]).describe('来源群号|#groupSelect|转发消息来源的群号列表'),
    targetGroupIds: z.array(z.number()).default([]).describe('目标群号|#groupSelect|消息转发到的目标群号列表'),
    enableImage: z.boolean().default(true).describe('转发图片'),
    enableVideo: z.boolean().default(true).describe('转发视频'),
    enableRecord: z.boolean().default(true).describe('转发聊天记录'),
});

export const ForwardMessageSchema = z.object({
    forwardRules: z.array(ForwardRuleSchema).default([]).describe('转发规则列表|配置消息从哪些群转发到哪些群'),
}).describe('消息转发');

export const GroupnoticeSchema = z.object({
    joinEnable: z.boolean().default(false).describe('入群通知|新成员加入时发送通知'),
    leaveEnable: z.boolean().default(false).describe('退群通知|成员退出时发送通知'),
}).describe('群通知');



const GroupConfigSchema = z.object({
    group: z.number().default(0).describe('群号|#groupSelect|选择此独立配置生效的群'),
    name: z.string().default('小叶').describe('角色|#roleSelect'),
    alternateName: z.string().default('雌小鬼').describe('反差角色|#roleSelect'),
    replyProbability: z.number().default(0.05).describe('回复概率|#step:0.01|0-1之间的小数'),
    triggerWords: z.array(z.string()).default(['小叶']).describe('触发词列表'),
    enableAtReply: z.boolean().default(true).describe('At回复|被@时是否回复'),
    alternatePromptProbability: z.number().default(0.1).describe('反差人格概率|#step:0.01|0-1之间'),
    recalltime: z.number().default(10).describe('撤回时间(秒)|自动撤回消息的秒数'),
    models: modelList('模型', 'chat', '留空则使用上面的默认模型'),
    toolGroup: z.string().default('').describe('工具组|#toolGroupSelect|选择此群使用的工具组'),
    splitMessage: z.boolean().default(true).describe('拆分消息|是否拆分长消息'),
});

export const MimicSchema = z.object({
    Groups: z.array(z.number()).default([]).describe('启用群|#group:基本|#groupSelect|伪人只在这些群里说话'),
    name: z.string().default('小叶').describe('人设|#group:基本|#roleSelect'),
    alternateName: z.string().default('雌小鬼').describe('反差人设|#group:基本|#roleSelect|偶尔切换成这个人设回复'),
    models: modelList('模型', 'chat', '可以选多个，排在前面的优先，失败时自动换下一个', '#group:基本'),
    toolGroup: z.string().default('').describe('工具组|#group:基本|#toolGroupSelect|伪人可以调用的工具'),
    triggerWords: z.array(z.string()).default(['小叶']).describe('触发词|#group:回复规则|消息里包含这些词时一定回复'),
    enableAtReply: z.boolean().default(true).describe('被 @ 时回复|#group:回复规则'),
    replyProbability: z.number().min(0).max(1).default(0.05).describe('随机回复概率|#group:回复规则|#step:0.01|0 到 1 之间，0.05 表示 5%'),
    alternatePromptProbability: z.number().min(0).max(1).default(0.1).describe('反差人设概率|#group:回复规则|#step:0.01|回复时使用反差人设的概率'),
    splitMessage: z.boolean().default(true).describe('拆分长消息|#group:回复规则|像真人一样分几条发送'),
    recalltime: z.number().default(10).describe('反差回复撤回时间（秒）|#group:回复规则'),
    GroupConfigs: z.array(GroupConfigSchema).default([]).describe('单独设置的群|#group:按群单独设置|#nameField:group|#summary:name,models|这些群使用下面的设置，覆盖上面的默认值'),
}).describe('伪人|像群友一样随机参与聊天');

const RankingConfigSchema = z.object({
    mode: z.string().describe('排行榜类型'),
    minLikeRate: z.number().default(0.1).describe('最低点赞率|#step:0.01'),
    minBookmarkRate: z.number().default(0.1).describe('最低收藏率|#step:0.01'),
    minBookmarks: z.number().default(500).describe('最低收藏数'),
});

const defaultRankingConfigs = [
    { mode: '日榜', minLikeRate: 0.1, minBookmarkRate: 0.1, minBookmarks: 600 },
    { mode: '周榜', minLikeRate: 0.15, minBookmarkRate: 0.2, minBookmarks: 2000 },
    { mode: '月榜', minLikeRate: 0.05, minBookmarkRate: 0.075, minBookmarks: 5000 },
    { mode: '男性日榜', minLikeRate: 0.1, minBookmarkRate: 0.1, minBookmarks: 700 },
    { mode: '女性日榜', minLikeRate: 0.1, minBookmarkRate: 0.1, minBookmarks: 500 },
    { mode: '原创日榜', minLikeRate: 0.1, minBookmarkRate: 0.1, minBookmarks: 400 },
    { mode: '新人日榜', minLikeRate: 0.1, minBookmarkRate: 0.1, minBookmarks: 200 },
    { mode: 'r18日榜', minLikeRate: 0.1, minBookmarkRate: 0.1, minBookmarks: 800 },
    { mode: 'r18周榜', minLikeRate: 0.15, minBookmarkRate: 0.2, minBookmarks: 2500 },
];

// 标签订阅配置 Schema
const TagSubscriptionSchema = z.object({
    groupId: z.number().default(0).describe('群号|#groupSelect|订阅推送的目标群'),
    tags: z.array(z.string()).default([]).describe('订阅标签列表|要订阅的 Pixiv 标签'),
});

// 画师订阅配置 Schema
const ArtistSubscriptionSchema = z.object({
    groupId: z.number().default(0).describe('群号|#groupSelect|订阅推送的目标群'),
    artistIds: z.array(z.string()).default([]).describe('画师ID列表|要订阅的画师 UID'),
});

export const PixivSchema = z.object({
    refresh_token: z.string().default('').describe('Pixiv Refresh Token|#textarea'),
    cookie: z.string().default('').describe('Pixiv Cookie|#textarea|用于 Web API 搜索，支持深层分页'),
    proxy: z.string().default('').describe('图片反代域名|填写则通过该域名下载图片，留空则从 Pixiv 原站下载'),
    fallbackLinkProxy: z.string().default('').describe('失败兜底链接反代域名|图片发送失败时，填写则只发送该域名的反代图片链接，留空则只发送 Pixiv 作品页；仅填域名，不含协议和路径'),
    recallTime: z.number().default(30).describe('自动撤回时间(秒)|R18作品及风控翻转图片的撤回时间，设为0则不撤回'),
    excludeAI: z.boolean().default(true).describe('排除AI作品|是否过滤AI生成的作品'),
    minBookmarks: z.number().default(600).describe('最低收藏数|低于此值的作品不显示'),
    minBookmarkViewRatio: z.number().default(0.09).describe('最低收藏率|#step:0.01|收藏/浏览比低于此值的不显示'),
    defaultTags: z.array(z.string()).default([]).describe('默认标签|搜索时使用的默认标签'),
    rankingConfigs: z.array(RankingConfigSchema).default(defaultRankingConfigs).describe('排行榜筛选配置|#fixed|#nameField:mode|为每个排行榜单独配置筛选参数'),
    rankingPushGroups: z.array(z.number()).default([]).describe('周榜定时推送群|#groupSelect|每周日11点自动推送周榜的群'),
    // 标签订阅配置
    tagSubscriptions: z.array(TagSubscriptionSchema).default([]).describe('标签订阅|#nameField:groupId|为每个群配置要订阅的标签'),
    tagSubMaxPages: z.number().default(5).describe('标签订阅扫描页数|每次检查时最多扫描的页数'),
    tagSubFreshnessPeriod: z.number().default(86400).describe('标签订阅保质期(秒)|只推送发布时间在此范围内的作品'),
    tagSubMinBookmark: z.number().default(300).describe('标签订阅最低收藏|作品收藏数必须达到此值'),
    tagSubMinBookRate: z.number().default(0.09).describe('标签订阅最低收藏率|#step:0.01|收藏/浏览比'),
    tagSubMinBookPerHour: z.number().default(50).describe('标签订阅每小时收藏增速|作品每小时需新增的收藏数'),
    // 画师订阅配置
    artistSubscriptions: z.array(ArtistSubscriptionSchema).default([]).describe('画师订阅|#nameField:groupId|为每个群配置要订阅的画师'),
    artistSubFreshnessPeriod: z.number().default(43200).describe('画师订阅保质期(秒)|只推送发布时间在此范围内的作品'),
    subMaxPushPerRun: z.number().int().min(1).default(3).describe('订阅每轮推送上限|#min:1|每个标签/画师每次检查时，每个群最多推送的作品数；超出的按发布时间顺延到下一轮'),
}).describe('Pixiv 功能');

export const BotSchema = z.object({
    botname: z.string().default('小叶').describe('机器人名称|机器人在各功能中使用的名称'),
}).describe('机器人基础设定');

export const PokeSchema = z.object({
    enable: z.boolean().default(true).describe('启用戳一戳'),
    personas: z.array(z.string()).default(['猫娘', '雌小鬼']).describe('人格列表|#roleSelectArray|戳一戳回复使用的人格'),
    masterReplies: z.string().default('').describe('主人回复|#textarea|对主人的特殊回复模板'),
    genericTextReplies: z.string().default('').describe('通用文字回复|#textarea'),
    countRepliesGroup: z.string().default('').describe('群计数回复|#textarea'),
    countRepliesUser: z.string().default('').describe('用户计数回复|#textarea'),
    pokeBackTextReplies: z.string().default('').describe('反戳回复|#textarea'),
}).describe('戳一戳');

export const R18Schema = z.object({
    Groups: z.array(z.number()).default([]).describe('R18群号|#groupSelect|允许发送R18内容的群号'),
}).describe('R18 管理');

export const RecallSchema = z.object({
    Groups: z.array(z.number()).default([]).describe('防撤回启用的群|#groupSelect|在这些群中监听消息撤回'),
}).describe('防撤回');

const RepeatRuleSchema = z.object({
    repeatCount: z.number().int().min(2).default(3).describe('触发次数|#min:2|从首条消息开始计数，达到此连续复读次数时触发'),
    action: z.enum(['follow', 'shuffle', 'text', 'image', 'random_interrupt', 'mute'])
        .default('follow')
        .describe('触发动作|#optionLabels:follow=跟读,shuffle=打乱文字,text=文字打断,image=图片打断,random_interrupt=随机打断,mute=禁言'),
    text: z.string().default('').describe('回复文字|#textarea|文字打断时留空则从下方文字池随机选择；禁言时作为成功提示，留空则不提示'),
    muteDuration: z.number().int().min(1).max(2592000).default(60).describe('禁言时间(秒)|#min:1|#max:2592000|仅禁言动作使用，最大30天'),
});

const DEFAULT_REPEAT_RULES = [
    { repeatCount: 3, action: 'follow', text: '', muteDuration: 60 },
    { repeatCount: 5, action: 'random_interrupt', text: '', muteDuration: 60 },
    { repeatCount: 7, action: 'mute', text: '好孩子不要复读哦！', muteDuration: 60 },
];

const DEFAULT_REPEAT_BREAK_MESSAGES = [
    '复读机来了！',
    '复读一时爽，一直复读一直爽……才怪！',
    '请停止你的复读行为！',
    '好了好了，知道你能复读了',
    '检测到复读姬能量波动异常，正在进行强制关停！',
];

export const RepeatSchema = z.object({
    enable: z.boolean().default(true).describe('启用复读|是否启用自动复读功能'),
    rules: z.array(RepeatRuleSchema)
        .default(DEFAULT_REPEAT_RULES)
        .describe('触发规则|#repeatRules|#nameField:repeatCount|可添加任意次数；同一次数只能配置一条规则'),
    breakMessages: z.array(nonEmptyString('打断文字'))
        .default(DEFAULT_REPEAT_BREAK_MESSAGES)
        .describe('文字打断内容|文字打断或随机打断时，从这里随机选择'),
}).superRefine((config, ctx) => {
    addUniqueFieldIssues(config.rules, 'repeatCount', ctx, ['rules']);
}).describe('复读');

const RoleSchema = z.object({
    name: nonEmptyString('角色名称').describe('角色名称'),
    prompt: z.string().default('').describe('角色提示词|#textarea|定义此角色的系统提示词'),
});

export const RolesSchema = z.object({
    roles: z.array(RoleSchema).default([]).describe('角色列表|预设的AI角色模板'),
}).superRefine((config, ctx) => {
    addUniqueFieldIssues(config.roles, 'name', ctx, ['roles']);
}).describe('AI 角色模板');

export const SummarySchema = z.object({
    enable: z.boolean().default(true).describe('启用图片外显'),
    Summaries: z.array(z.string()).default([]).describe('图片外显内容'),
}).describe('图片外显');

export const SearchImageSchema = z.object({
    defaultChannel: z.enum(['ascii2d', 'google', 'saucenao']).default('ascii2d').describe('默认搜图渠道|不带前缀的“搜图”指令默认使用的渠道'),
    maxResults: z.number().default(3).describe('结果条数|转发消息中展示的最大结果数量'),
    googleLogin: z.boolean().default(true).describe('Google 登录|检测到未登录时是否等待手动登录；已有 google-lens-profile 时始终复用登录态'),
    sauceNaoApiKey: z.string().default('').describe('SauceNAO API Key|SauceNAO 搜图使用的 API Key'),
}).describe('搜图');

export const TeatimeSchema = z.object({
    Groups: z.array(z.number()).default([]).describe('下午茶群号|#groupSelect'),
    cron: cronString('0 15 * * *').describe('定时推送的时间表达式|#cron|5段格式: 分 时 日 月 周'),
}).describe('下午茶推送');

const ReminderTaskItemSchema = z.object({
    id: z.string().default('').describe('任务ID|用于标识单条定时任务'),
    enable: z.boolean().default(true).describe('启用任务|是否启用该定时提醒'),
    cron: cronString('0 8 * * *').describe('Cron表达式|#cron|5段格式: 分 时 日 月 周'),
    groupId: z.number().default(0).describe('目标群号|#groupSelect|填写后向该群推送，0 表示不使用群推送'),
    qq: z.string().default('').describe('目标QQ|在群内可用于@某人；不填则仅发送文本'),
    content: z.string().default('早安~').describe('提醒内容|#textarea|定时任务发送的文本内容'),
    note: z.string().default('').describe('便条|#textarea|AI 设置提醒时记下的背景和原话，到点生成文案时参考；可留空'),
    createdAt: z.string().default('').describe('创建时间|ISO 时间字符串'),
    source: z.string().default('').describe('来源|任务来源标记'),
}).describe('定时提醒项');

export const ReminderTaskSchema = z.object({
    tasks: z.array(ReminderTaskItemSchema).default([]).describe('提醒任务列表|#nameField:id|可配置多个重复提醒任务'),
}).describe('重复提醒任务');

export const pluginMeta = {
    displayName: '樱花插件',
    icon: '🌸',
};


export const configSchema = {
    'bot': BotSchema,
    'Providers': ProvidersSchema,
    'Models': ModelsSchema,
    'AI': AISchema,
    'roles': RolesSchema,
    'mimic': MimicSchema,
    'ActiveChat': ActiveChatSchema,
    'TavilyMCP': TavilyMCPSchema,
    'EditImage': EditImageSchema,
    'nai': NaiSchema,
    'pixiv': PixivSchema,
    'r18': R18Schema,
    'SearchImage': SearchImageSchema,
    'summary': SummarySchema,
    'VoxCPMVoice': VoxCPMVoiceSchema,
    'bilicookie': BilicookieSchema,
    'douyin': DouyinSchema,
    'poke': PokeSchema,
    'repeat': RepeatSchema,
    'EmojiThief': EmojiThiefSchema,
    'groupnotice': GroupnoticeSchema,
    'recall': RecallSchema,
    'AutoCleanup': AutoCleanupSchema,
    'forwardMessage': ForwardMessageSchema,
    '60sNews': News60sSchema,
    'teatime': TeatimeSchema,
    'cool': CoolSchema,
    'GroupInsight': GroupInsightSchema,
    'reminderTask': ReminderTaskSchema,
    'economy': EconomySchema,
};

/**
 * 面板导航：分组 → 页面 → 页面里展示的配置模块。
 * 同一页面里的模块共用一个保存按钮；icon 对应面板内置图标名。
 */
export const schemaNavigation = [
    {
        title: 'AI',
        pages: [
            {
                key: 'models',
                title: '模型与供应商',
                icon: 'cpu',
                description: '先添加供应商并填好 Key，再添加模型；角色、伪人、图片生成等地方都直接按模型名选择。',
                modules: ['Providers', 'Models'],
            },
            { key: 'ai-chat', title: 'AI 对话', icon: 'message', description: '触发前缀、工具组、对话参数和后台任务模型。', modules: ['AI'] },
            { key: 'roles', title: '人设', icon: 'users', description: '角色的系统提示词，在触发设定、伪人和戳一戳里按名字引用。', modules: ['roles'] },
            { key: 'mimic', title: '伪人', icon: 'ghost', modules: ['mimic'] },
            { key: 'ai-extra', title: '主动聊天与联网', icon: 'brain', modules: ['ActiveChat', 'TavilyMCP'] },
        ],
    },
    {
        title: '图片与媒体',
        pages: [
            { key: 'image-gen', title: '图片与视频生成', icon: 'image', modules: ['EditImage'] },
            { key: 'nai', title: 'NovelAI 绘画', icon: 'brush', modules: ['nai'] },
            { key: 'pixiv', title: 'Pixiv 图库', icon: 'gallery', modules: ['pixiv', 'r18'] },
            { key: 'search-image', title: '搜图与图片外显', icon: 'search', modules: ['SearchImage', 'summary'] },
            { key: 'voice', title: '语音生成', icon: 'mic', modules: ['VoxCPMVoice'] },
            { key: 'link-parse', title: '链接解析', icon: 'link', modules: ['bilicookie', 'douyin'] },
        ],
    },
    {
        title: '群聊',
        pages: [
            { key: 'bot', title: '机器人名称', icon: 'bot', modules: ['bot'] },
            { key: 'poke', title: '戳一戳', icon: 'hand', modules: ['poke'] },
            { key: 'repeat', title: '复读', icon: 'repeat', modules: ['repeat'] },
            { key: 'emoji', title: '表情包学习', icon: 'smile', modules: ['EmojiThief'] },
            { key: 'group-manage', title: '群管理', icon: 'shield', modules: ['groupnotice', 'recall', 'AutoCleanup', 'forwardMessage'] },
        ],
    },
    {
        title: '推送与定时',
        pages: [
            { key: 'push', title: '定时推送', icon: 'bell', modules: ['60sNews', 'teatime', 'cool', 'GroupInsight'] },
            { key: 'reminder', title: '重复提醒', icon: 'clock', modules: ['reminderTask'] },
        ],
    },
    {
        title: '游戏',
        pages: [
            { key: 'economy', title: '经济系统', icon: 'coins', modules: ['economy'] },
        ],
    },
];

export const dynamicOptionsConfig = {
    roleSelect: {
        label: '人设',
        sources: [
            { module: 'roles', path: 'roles', valueKey: 'name' }
        ],
    },
    roleSelectArray: {
        label: '人设',
        isArray: true,
        sources: [
            { module: 'roles', path: 'roles', valueKey: 'name' }
        ],
    },
    providerSelect: {
        label: '供应商',
        sources: [
            {
                module: 'Providers',
                path: 'providers',
                valueKey: 'name',
                detailKeys: ['protocol', 'vertex'],
            },
        ],
    },
    modelEntrySelect: {
        label: '模型',
        sources: [
            {
                module: 'Models',
                path: 'models',
                valueKey: ['name', 'model'],
                detailKeys: ['type', 'provider', 'model', 'nativeWebSearch'],
            },
        ],
    },
    toolGroupSelect: {
        label: '工具组',
        sources: [
            { module: 'AI', path: 'toolGroups', valueKey: 'name' },
        ],
    },
    voiceRoleSelect: {
        label: '语音角色',
        sources: [
            { module: 'VoxCPMVoice', path: 'roles', valueKey: 'name' },
        ],
    },
};

export { migrateConfigDirectory as migrateConfig } from './lib/AIUtils/configMigration.js';
