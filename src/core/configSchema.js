import { z } from 'zod';

// =================== Zod Schema 定义 ===================
// 这是框架核心配置 (config/config.yaml) 的唯一 Schema 定义
// 所有默认值都在此处通过 .default() 定义，不再需要 defSet/config.yaml

export const ConfigSchema = z.object({
    // 主人QQ
    master: z.union([z.number(), z.string()])
        .describe('主人QQ：拥有最高权限'),

    // 日志等级
    logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
        .default('info')
        .describe('日志等级'),

    // 屏蔽私聊
    blockPrivate: z.boolean()
        .default(true)
        .describe('屏蔽私聊：是否屏蔽所有私聊消息（主人不受影响）'),

    // 白名单用户
    whiteUsers: z.array(z.number())
        .default([])
        .describe('白名单用户：拥有部分高级权限'),

    // 群组白名单
    whiteGroups: z.array(z.number())
        .default([])
        .describe('群组白名单：如果填写，则只监听这些群（优先级最高）'),

    // 群组黑名单
    blackGroups: z.array(z.number())
        .default([])
        .describe('群组黑名单：仅当白名单为空时生效，屏蔽这些群'),

    // 用户黑名单
    blackUsers: z.array(z.number())
        .default([])
        .describe('用户黑名单：屏蔽这些用户（全局生效）'),

    // WebSocket 正向连接配置
    ws: z.object({
        url: z.string()
            .default('ws://127.0.0.1:3001')
            .describe('WebSocket 地址'),
        accessToken: z.string()
            .default('')
            .describe('访问令牌，留空则不验证'),
        reconnection: z.object({
            enable: z.boolean().default(true).describe('启用重连'),
            attempts: z.number().int().min(1).max(999).default(99).describe('重连次数'),
            delay: z.number().int().min(1000).max(60000).default(5000).describe('重连间隔(ms)'),
        }).default({}).describe('重连配置'),
    }).default({}).describe('WebSocket 正向连接配置'),

    // Redis 配置
    redis: z.object({
        host: z.string().default('127.0.0.1').describe('Redis 地址'),
        port: z.number().int().min(1).max(65535).default(6379).describe('Redis 端口'),
        password: z.string().default('').describe('Redis 密码'),
        db: z.number().int().min(0).max(15).default(0).describe('Redis 数据库编号'),
        execPath: z.string().default('').describe('Redis 启动命令或路径，留空则不自动启动'),
    }).default({}).describe('Redis 配置'),

    // 配置面板
    web: z.object({
        port: z.number().int().min(1).max(65535).default(1135).describe('配置面板端口'),
        password: z.string().default('admin').describe('面板登录密码'),
    }).default({}).describe('配置面板设置'),
});

// =================== 字段 UI 提示 ===================
// 控制前端表单渲染行为：step(步进值), min/max(范围), hideSpinner(隐藏上下箭头)
// key 格式: 字段路径如 'ws.reconnection.attempts'

export const FIELD_UI_HINTS = {
    'master': { hideSpinner: true },
    'whiteGroups': { uiType: 'groupSelect' },
    'blackGroups': { uiType: 'groupSelect' },
    'ws.reconnection.attempts': { step: 1, min: 1, max: 999 },
    'ws.reconnection.delay': { step: 1000, min: 1000, max: 60000 },
    'redis.port': { step: 1, min: 1, max: 65535 },
    'redis.db': { step: 1, min: 0, max: 15 },
    'web.port': { step: 1, min: 1, max: 65535 },
};

/**
 * 从 ConfigSchema 获取完整的默认配置对象
 * 用于在 config.yaml 不存在时，生成初始配置文件
 */
export function getDefaultConfig() {
    return ConfigSchema.parse({ master: 123456789 });
}

// =================== Schema 元数据提取 (Zod v4) ===================

/**
 * 将 Zod schema 递归转换为 JSON 元数据，供前端渲染表单
 * 返回格式: { type, description, default, children?, items?, options?, step?, min?, max?, hideSpinner? }
 * 
 * 适配 Zod v4 API:
 *   - schema.type → 类型名 ('string'|'number'|'boolean'|'object'|'array'|'enum'|'union'|'default')
 *   - schema.description → 描述
 *   - schema.def.innerType → default/optional 的内部类型
 *   - schema.def.element → array 的元素类型
 *   - schema.options → enum/union 的选项
 *   - schema.shape → object 的字段
 */
export function schemaToMeta(schema, fieldPath = '') {
    if (!schema) return null;

    const desc = schema.description || '';
    const { innerSchema, defaultValue } = unwrapDefault(schema);

    const baseType = innerSchema.type;

    // ZodObject
    if (baseType === 'object' && innerSchema.shape) {
        const children = {};
        for (const [key, childSchema] of Object.entries(innerSchema.shape)) {
            const childPath = fieldPath ? `${fieldPath}.${key}` : key;
            children[key] = schemaToMeta(childSchema, childPath);
        }
        return { type: 'object', description: desc, default: defaultValue, children };
    }

    // ZodArray
    if (baseType === 'array') {
        const element = innerSchema.def?.element;
        const itemMeta = element ? schemaToMeta(element) : { type: 'unknown' };
        const hints = getHints(fieldPath);
        return { type: 'array', description: desc, default: defaultValue, items: itemMeta, ...hints };
    }

    // ZodEnum
    if (baseType === 'enum') {
        const options = innerSchema.options || Object.keys(innerSchema.def?.entries || {});
        return { type: 'enum', description: desc, default: defaultValue, options };
    }

    // ZodUnion
    if (baseType === 'union') {
        const opts = innerSchema.options || innerSchema.def?.options || [];
        const types = opts.map(o => o.type || 'unknown');
        return { type: types.join('|'), description: desc, default: defaultValue, ...getHints(fieldPath) };
    }

    // 基础类型: string, number, boolean
    if (['string', 'number', 'boolean'].includes(baseType)) {
        return { type: baseType, description: desc, default: defaultValue, ...getHints(fieldPath) };
    }

    return { type: baseType || 'unknown', description: desc, default: defaultValue };
}

function getHints(fieldPath) {
    return FIELD_UI_HINTS[fieldPath] || {};
}

/**
 * 解包 ZodDefault 包装层，提取默认值和内部 schema
 * Zod v4 中 .default() 会包装成 type='default' 的 schema
 */
function unwrapDefault(schema) {
    let current = schema;
    let defaultValue = undefined;

    while (current?.type === 'default') {
        defaultValue = current.def?.defaultValue;
        current = current.def?.innerType;
    }

    // 继续解包 optional/nullable
    while (current?.type === 'optional' || current?.type === 'nullable') {
        current = current.def?.innerType;
    }

    return { innerSchema: current || schema, defaultValue };
}
