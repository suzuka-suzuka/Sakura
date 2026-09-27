import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build, transformWithEsbuild } from 'vite';
import puppeteer from 'puppeteer';

// 使用真实配置组件和 Chrome 键盘事件，不连接机器人或改写配置文件。
const root = fileURLToPath(new URL('../', import.meta.url));
const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import ConfigField from './src/components/ConfigField.jsx';
function App() {
  const [values, setValues] = useState({ rate: 0, bounded: 100, signed: 0, stepped: 0,
    union: 0, list: [], cron: '0 * * * *', costs: [] });
  const fields = {
    rate: { type: 'number', min: 0, max: 1 },
    bounded: { type: 'number', min: 100, max: 999 },
    signed: { type: 'number' },
    stepped: { type: 'number', step: 0.01 },
    union: { type: 'number|string' },
    list: { type: 'array', items: { type: 'number|string' } },
    cron: { type: 'string', uiType: 'cron' },
    costs: { type: 'array', uiType: 'commandCost' }
  };
  return <form onSubmit={e => { e.preventDefault(); window.saved = values; }}>
    {Object.entries(fields).map(([name, meta]) => <div id={name} key={name}>
      <ConfigField name={name} meta={meta} value={values[name]}
        onChange={value => setValues(prev => ({ ...prev, [name]: value }))} />
    </div>)}
    <button id="save">保存</button><output>{JSON.stringify(values)}</output>
  </form>;
}
createRoot(document.getElementById('root')).render(<App />);
`;
const bundle = await build({
    root, configFile: false, define: { 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' },
    build: { write: false, lib: { entry: root + '__input-test.jsx', name: 'InputTest', formats: ['iife'] } },
    plugins: [{
        name: 'config-input-regression',
        resolveId(id) { if (id.endsWith('__input-test.jsx')) return root + '__input-test.jsx'; },
        async load(id) {
            if (id.endsWith('__input-test.jsx')) {
                return (await transformWithEsbuild(entry, 'input-test.jsx', { loader: 'jsx', jsx: 'automatic' })).code;
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
    await page.setContent('<div id="root"></div>');
    await page.evaluate(() => {
        Object.defineProperty(window, 'localStorage', { value: {
            getItem: () => null, setItem: () => {}, removeItem: () => {},
        } });
        Object.defineProperty(window, 'sessionStorage', { value: window.localStorage });
        window.fetch = async () => ({ json: async () => ({ success: true, data: ['测试指令'] }) });
    });
    await page.addScriptTag({ content: [bundle].flat()[0].output.find(item => item.type === 'chunk').code });
    await page.waitForSelector('#costs input');
    const values = () => page.$eval('output', element => JSON.parse(element.textContent));
    const text = selector => page.$eval(selector, element => element.value);
    async function replace(selector, value) {
        await page.click(selector);
        await page.keyboard.down('Control');
        await page.keyboard.press('A');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        assert.equal(await text(selector), '', '清空后不应自动补零或星号');
        await page.type(selector, value);
    }
    await replace('#rate input', '0.');
    assert.equal(await text('#rate input'), '0.');
    await page.type('#rate input', '01');
    assert.equal((await values()).rate, 0.01);
    await replace('#bounded input', '250');
    assert.equal((await values()).bounded, 250);
    await replace('#signed input', '-0.05');
    assert.equal((await values()).signed, -0.05);
    await replace('#stepped input', '0.01');
    assert.equal((await values()).stepped, 0.01);
    await replace('#union input', '0.010');
    assert.equal(await text('#union input'), '0.010');
    assert.equal((await values()).union, 0.01);
    await replace('#list input', '文本条目');
    await page.keyboard.press('Enter');
    assert.deepEqual((await values()).list, ['文本条目']);
    await replace('#cron .cron-segment-input', '15');
    assert.equal((await values()).cron, '15 * * * *');
    await replace('#costs input', '25');
    assert.deepEqual((await values()).costs, [{ command: '测试指令', cost: 25 }]);
    await page.click('#save');
    assert.equal((await page.evaluate(() => window.saved)).rate, 0.01);
    await replace('#signed input', '-');
    assert.equal(await page.$eval('form', form => form.checkValidity()), false);
    await page.evaluate(() => { window.saved = null; });
    await page.click('#save');
    assert.equal(await page.evaluate(() => window.saved), null);
    await replace('#signed input', '1e309');
    assert.equal(await page.$eval('form', form => form.checkValidity()), false);
    await replace('#signed input', '2');
    await replace('#costs input', '1.5');
    assert.equal(await page.$eval('form', form => form.checkValidity()), false);
    await replace('#costs input', '0');
    assert.deepEqual((await values()).costs, []);
    assert.deepEqual(errors, []);
    console.log('配置输入浏览器回归通过：小数、负数、上下限、步长、混合类型、列表、Cron、指令消耗和保存校验。');
} finally {
    await browser?.close();
}


