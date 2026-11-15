import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';

// 使用真实配置页、保存请求和 WS 处理链；接口由浏览器内的夹具提供，不改写本地配置。
const root = fileURLToPath(new URL('../../../src/web/frontend/', import.meta.url));
const requireFrontend = createRequire(new URL('../../../src/web/frontend/package.json', import.meta.url));
const { build, transformWithEsbuild } = await import(pathToFileURL(requireFrontend.resolve('vite')).href);
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { PluginConfigPage } from './src/components/ConfigPage.jsx';
import { useConfig } from './src/hooks/useConfig.js';
import { useWebSocket } from './src/hooks/useWebSocket.js';
const page = { title: 'AI 配置', modules: ['AI'] };
function App() {
  const api = useConfig();
  useWebSocket(api.token, api.updateFromWs, api.updatePluginFromWs, api.logout);
  return <PluginConfigPage page={page} schemas={api.pluginSchemas['sakura-plugin'] || {}}
    configs={api.pluginConfigs['sakura-plugin']?.__default__ || {}}
    onSaveModule={(module, data) => api.savePluginConfig('sakura-plugin', module, data, null)} />;
}
createRoot(document.getElementById('root')).render(<App />);
`;
const bundle = await build({
    root, configFile: false, define: { 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' },
    build: { write: false, lib: { entry: root + '__save-test.jsx', name: 'SaveTest', formats: ['iife'] } },
    plugins: [{
        name: 'panel-save-regression',
        resolveId(id) { if (id.endsWith('__save-test.jsx')) return root + '__save-test.jsx'; },
        async load(id) {
            if (id.endsWith('__save-test.jsx')) {
                return (await transformWithEsbuild(entry, 'save-test.jsx', { loader: 'jsx', jsx: 'automatic' })).code;
            }
        },
    }],
});

let browser;
try {
    browser = await puppeteer.launch({ headless: true, args: ['--disable-gpu', '--no-sandbox'] });
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
    page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
    await page.setRequestInterception(true);
    page.on('request', request => request.respond({ contentType: 'text/html', body: '<div id="root"></div>' }));
    await page.goto('http://sakura.test');
    await page.evaluate(() => {
        const storage = new Map([['sakura_token', 'test-token']]);
        Object.defineProperty(window, 'localStorage', { value: {
            getItem: key => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, value),
            removeItem: key => storage.delete(key),
        } });
        Object.defineProperty(window, 'sessionStorage', { value: {
            getItem: () => null, setItem: () => {}, removeItem: () => {},
        } });
        window.WebSocket = class {
            constructor() { window.socket = this; }
            close() {}
        };
        window.serverConfig = {
            AI: { title: '原配置', provider: '供应商 A', toolGroup: '默认工具', chatModels: ['模型 A'] },
            Providers: { providers: [{ name: '供应商 A', protocol: 'openai' }] },
        };
        const schema = { AI: { type: 'object', children: {
            title: { type: 'string', label: '名称' },
            provider: { type: 'string', label: '供应商', uiType: 'providerSelect' },
            toolGroup: { type: 'string', label: '工具组', uiType: 'toolGroupSelect' },
            chatModels: { type: 'array', label: '模型', uiType: 'modelList:chat', items: { type: 'string' } },
        } } };
        const dynamicData = () => ({
            config: {
                providerSelect: { label: '供应商', sources: [{ module: 'Providers', path: 'providers', valueKey: 'name', detailKeys: ['protocol'] }] },
                toolGroupSelect: { label: '工具组', sources: [{ module: 'AI', path: 'toolGroups', valueKey: 'name' }] },
                modelEntrySelect: { label: '模型', sources: [{ module: 'Models', path: 'models', valueKey: 'name' }] },
            },
            options: {
                providerSelect: window.serverConfig.Providers.providers.map(provider => provider.name),
                toolGroupSelect: ['默认工具'], modelEntrySelect: ['模型 A'],
            },
            details: {
                providerSelect: Object.fromEntries(window.serverConfig.Providers.providers.map(provider => [provider.name, { protocol: provider.protocol }])),
                modelEntrySelect: { '模型 A': { type: 'chat', provider: '供应商 A' } },
            },
        });
        const response = data => ({ status: 200, json: async () => ({ success: true, data }) });
        window.optionRequests = [];
        window.savedEvents = [];
        window.fetch = async (url, init = {}) => {
            if (url.startsWith('/api/dynamic-options')) {
                return new Promise(resolve => window.optionRequests.push({
                    url, resolve, data: structuredClone(dynamicData()), done: false,
                }));
            }
            if (init.method === 'POST') {
                const moduleName = url.split('/')[4];
                const data = JSON.parse(init.body).data;
                window.serverConfig[moduleName] = data;
                window.savedEvents.push({ type: 'plugin_config_changed', pluginName: 'sakura-plugin', moduleName, data });
                return response(null);
            }
            if (url === '/api/plugins') return response({ 'sakura-plugin': ['AI', 'Providers'] });
            if (url === '/api/plugins/sakura-plugin/schema') return response(schema);
            if (url === '/api/plugins/sakura-plugin/config') return response(structuredClone(window.serverConfig));
            if (url === '/api/bot/info') return response({ accounts: [] });
            return response({});
        };
        window.finishOptions = (index, fail = false) => {
            const request = window.optionRequests[index];
            request.done = true;
            request.resolve(fail
                ? { status: 500, json: async () => ({ success: false, error: '模拟刷新失败' }) }
                : response(request.data));
        };
        window.pushChange = (moduleName, data, selfId = null, pluginName = 'sakura-plugin') => {
            if (selfId == null && pluginName === 'sakura-plugin') window.serverConfig[moduleName] = data;
            window.socket.onmessage({ data: JSON.stringify({ type: 'plugin_config_changed', pluginName, moduleName, data, selfId }) });
        };
    });
    await page.addScriptTag({ content: [bundle].flat()[0].output.find(item => item.type === 'chunk').code });
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const requestCount = () => page.evaluate(() => window.optionRequests.length);
    const finishOptions = async index => {
        await page.waitForFunction(index => window.optionRequests.length > index, {}, index);
        await page.evaluate(index => window.finishOptions(index), index);
        await settle();
    };
    await finishOptions(0);
    await page.waitForSelector('select');
    assert.equal(await requestCount(), 1, '多个字段的首次加载应合并为一次请求');

    await page.evaluate(() => {
        window.originalSelects = [...document.querySelectorAll('select')];
        window.originalProvider = document.querySelector('.model-pill-provider');
        window.flickers = [];
        new MutationObserver(() => {
            if (window.originalSelects.some(element => !element.isConnected)) window.flickers.push('下拉框被卸载');
            if (!window.originalProvider.isConnected) window.flickers.push('模型供应商标签消失');
        }).observe(document.getElementById('root'), { subtree: true, childList: true });
    });
    const assertStable = async message => {
        await settle();
        assert.deepEqual(await page.evaluate(() => window.flickers), [], message);
    };

    await page.type('input[type="text"]', '已修改');
    await page.click('.save-bar .btn-primary');
    await page.waitForFunction(() => window.savedEvents.length === 1 && window.optionRequests.length === 2);
    await assertStable('保存响应触发刷新时，已有字段应保持挂载');
    await finishOptions(1);
    await page.evaluate(() => window.socket.onmessage({ data: JSON.stringify(window.savedEvents[0]) }));
    await page.waitForFunction(() => window.optionRequests.length === 3);
    await assertStable('保存后的 WS 回声不能让字段第二次闪烁');
    await finishOptions(2);
    assert.equal(await page.$eval('input[type="text"]', element => element.value), '原配置已修改');
    assert.equal(await page.$('.save-bar'), null, '保存成功应清除未保存状态');

    const beforeUnrelated = await requestCount();
    await page.evaluate(() => {
        window.pushChange('memory', { enabled: true });
        window.pushChange('Providers', { providers: [] }, 2222);
        window.pushChange('Providers', { providers: [] }, null, 'another-plugin');
    });
    await settle();
    assert.equal(await requestCount(), beforeUnrelated, '无关模块、其他账号及其他插件不应刷新当前选项');

    // 真正的外部更新仍需生效；慢请求期间连续修改必须串行刷新，不能回写旧快照。
    await page.evaluate(() => window.pushChange('Providers', { providers: [{ name: '供应商 B', protocol: 'gemini' }] }));
    await page.waitForFunction(count => window.optionRequests.length > count, {}, beforeUnrelated);
    await page.evaluate(() => window.pushChange('Providers', { providers: [{ name: '供应商 C', protocol: 'openai' }] }));
    await settle();
    assert.equal(await requestCount(), beforeUnrelated + 1, '刷新期间的连续通知不应创建并行请求');
    await assertStable('慢请求期间也不能清空选项和模型标签');
    await finishOptions(beforeUnrelated);
    assert.equal(await page.$$eval('option', elements => elements.some(element => element.value === '供应商 B')), false, '过期请求不能回写中间值');
    await finishOptions(beforeUnrelated + 1);
    assert.equal(await page.$$eval('option', elements => elements.some(element => element.value === '供应商 C')), true, '外部更新后的最新选项应显示');

    const beforeFailure = await requestCount();
    await page.evaluate(() => window.pushChange('Providers', { providers: [{ name: '供应商 D', protocol: 'gemini' }] }));
    await page.waitForFunction(count => window.optionRequests.length > count, {}, beforeFailure);
    await page.evaluate(index => window.finishOptions(index, true), beforeFailure);
    await assertStable('后台刷新失败时应保留最后一次有效内容');
    assert.equal(await page.$$eval('option', elements => elements.some(element => element.value === '供应商 C')), true);
    await page.evaluate(() => window.pushChange('Providers', { providers: [{ name: '供应商 D', protocol: 'gemini' }] }));
    await finishOptions(beforeFailure + 1);
    assert.equal(await page.$$eval('option', elements => elements.some(element => element.value === '供应商 D')), true, '刷新失败后应允许重试');
    await assertStable('完成所有刷新后，字段应始终复用原节点');
    assert.deepEqual(errors, []);
    console.log('配置保存浏览器回归通过：保存与 WS 回声无闪烁、按模块和账号刷新、慢请求串行与过期响应丢弃、刷新失败保留内容并可重试。');
} finally {
    await browser?.close();
}
