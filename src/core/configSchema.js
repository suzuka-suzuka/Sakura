import { z } from 'zod';

const ForwardConnectionSchema = z.object({
    name: z.string().default('Forward 1').describe('连接名称'),
    enable: z.boolean().default(true).describe('启用此正向连接'),
    url: z.string().default('ws://127.0.0.1:3001').describe('OneBot 正向 WebSocket 地址'),
    accessToken: z.string().default('').describe('访问令牌，留空则不校验'),
    reconnectDelay: z.number().int().min(0).max(60000).default(5000).describe('重连间隔(ms)，0 为不重连'),
    heartbeatInterval: z.number().int().min(0).max(300000).default(30000).describe('心跳间隔(ms)，0 为不发送'),
});

const ReverseConnectionSchema = z.object({
    name: z.string().default('Reverse 1').describe('连接名称'),
    enable: z.boolean().default(false).describe('启用此反向监听'),
    port: z.number().int().min(1).max(65535).default(3002).describe('反向 WebSocket 监听端口'),
    accessToken: z.string().default('').describe('访问令牌，留空则不校验'),
});

const MilkyConnectionSchema = z.object({
    name: z.string().default('Milky 1').describe('连接名称'),
    enable: z.boolean().default(false).describe('启用此 Milky 连接'),
    url: z.string().default('http://127.0.0.1:3000').describe('Milky HTTP 地址'),
    accessToken: z.string().default('').describe('访问令牌，留空则不校验'),
    reconnectDelay: z.number().int().min(0).max(60000).default(5000).describe('重连间隔(ms)，0 为不重连'),
    heartbeatInterval: z.number().int().min(0).max(300000).default(30000).describe('心跳间隔(ms)，0 为不发送'),
});

export const ACCOUNT_CONFIG_KEYS = [
    'master',
    'whiteUsers',
    'whiteGroups',
    'blackGroups',
    'blackUsers',
];

export const ConfigSchema = z.object({
    logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
        .default('info')
        .describe('日志等级'),

    blockPrivate: z.boolean()
        .default(true)
        .describe('是否屏蔽私聊，主人不受影响'),

    ws: z.object({
        forward: z.array(ForwardConnectionSchema)
            .default([ForwardConnectionSchema.parse({})])
            .describe('正向连接列表'),

        reverse: z.array(ReverseConnectionSchema)
            .default([ReverseConnectionSchema.parse({})])
            .describe('反向连接列表'),

        milky: z.array(MilkyConnectionSchema)
            .default([MilkyConnectionSchema.parse({})])
            .describe('Milky 连接列表'),
    }).default(() => ({
        forward: [ForwardConnectionSchema.parse({})],
        reverse: [ReverseConnectionSchema.parse({})],
        milky: [MilkyConnectionSchema.parse({})],
    })).describe('连接配置'),

    redis: z.object({
        host: z.string().default('127.0.0.1').describe('Redis 地址'),
        port: z.number().int().min(1).max(65535).default(6379).describe('Redis 端口'),
        password: z.string().default('').describe('Redis 密码'),
        db: z.number().int().min(0).max(15).default(0).describe('Redis 数据库编号'),
        execPath: z.string().default('').describe('Redis 启动命令或路径，留空则不自动启动'),
    }).default(() => ({
        host: '127.0.0.1',
        port: 6379,
        password: '',
        db: 0,
        execPath: '',
    })).describe('Redis 配置'),

    web: z.object({
        port: z.number().int().min(1).max(65535).default(1135).describe('配置面板端口'),
        password: z.string().default('admin').describe('配置面板登录密码'),
    }).default(() => ({
        port: 1135,
        password: 'admin',
    })).describe('配置面板设置'),
});

export const AccountConfigSchema = z.object({
    master: z.union([z.number(), z.string()])
        .default('')
        .describe('主人 QQ'),

    whiteUsers: z.array(z.number())
        .default([])
        .describe('白名单 QQ'),

    whiteGroups: z.array(z.number())
        .default([])
        .describe('群白名单，填写后仅处理这些群'),

    blackGroups: z.array(z.number())
        .default([])
        .describe('群黑名单，仅在群白名单为空时生效'),

    blackUsers: z.array(z.number())
        .default([])
        .describe('用户黑名单'),
});

export const FIELD_UI_HINTS = {
    master: { hideSpinner: true },
    whiteGroups: { uiType: 'groupSelect' },
    blackGroups: { uiType: 'groupSelect' },
    'ws.forward': {
        label: 'Oenbot正向',
        nameField: 'name',
    },
    'ws.reverse': {
        label: 'Oenbot反向',
        nameField: 'name',
    },
    'ws.milky': {
        label: 'Milky 协议',
        nameField: 'name',
    },
    'redis.port': { step: 1, min: 1, max: 65535 },
    'redis.db': { step: 1, min: 0, max: 15 },
    'web.port': { step: 1, min: 1, max: 65535 },
};

export function getDefaultConfig() {
    return ConfigSchema.parse({});
}

export function getDefaultAccountConfig() {
    return AccountConfigSchema.parse({});
}

export function schemaToMeta(schema, fieldPath = '') {
    if (!schema) return null;

    const desc = schema.description || '';
    const { innerSchema, defaultValue } = unwrapDefault(schema);
    const baseType = innerSchema.type;

    if (baseType === 'object' && innerSchema.shape) {
        const children = {};
        for (const [key, childSchema] of Object.entries(innerSchema.shape)) {
            const childPath = fieldPath ? `${fieldPath}.${key}` : key;
            children[key] = schemaToMeta(childSchema, childPath);
        }
        return { type: 'object', description: desc, default: defaultValue, children, ...getHints(fieldPath) };
    }

    if (baseType === 'array') {
        const element = innerSchema.def?.element;
        const itemPath = fieldPath ? `${fieldPath}[]` : '[]';
        const items = element ? schemaToMeta(element, itemPath) : { type: 'unknown' };
        return { type: 'array', description: desc, default: defaultValue, items, ...getHints(fieldPath) };
    }

    if (baseType === 'enum') {
        const options = innerSchema.options || Object.keys(innerSchema.def?.entries || {});
        return { type: 'enum', description: desc, default: defaultValue, options, ...getHints(fieldPath) };
    }

    if (baseType === 'union') {
        const opts = innerSchema.options || innerSchema.def?.options || [];
        const types = opts.map((item) => item.type || 'unknown');
        return { type: types.join('|'), description: desc, default: defaultValue, ...getHints(fieldPath) };
    }

    if (['string', 'number', 'boolean'].includes(baseType)) {
        return { type: baseType, description: desc, default: defaultValue, ...getHints(fieldPath) };
    }

    return { type: baseType || 'unknown', description: desc, default: defaultValue, ...getHints(fieldPath) };
}

function getHints(fieldPath) {
    return FIELD_UI_HINTS[fieldPath] || {};
}

function unwrapDefault(schema) {
    let current = schema;
    let defaultValue;

    while (current?.type === 'default') {
        defaultValue = current.def?.defaultValue;
        current = current.def?.innerType;
    }

    while (current?.type === 'optional' || current?.type === 'nullable') {
        current = current.def?.innerType;
    }

    return { innerSchema: current || schema, defaultValue };
}
