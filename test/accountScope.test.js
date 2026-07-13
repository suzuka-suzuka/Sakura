import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeAccountSelfId,
    resolvePluginScopeSelfId,
} from '../src/web/frontend/src/utils/accountScope.js';

test('empty values remain the global scope instead of becoming account zero', () => {
    assert.equal(normalizeAccountSelfId(null), null);
    assert.equal(normalizeAccountSelfId(undefined), null);
    assert.equal(normalizeAccountSelfId(''), null);
    assert.equal(normalizeAccountSelfId(0), null);
    assert.equal(normalizeAccountSelfId('10001'), 10001);
});

test('zero or one online account always uses global plugin scope', () => {
    assert.equal(resolvePluginScopeSelfId([], 10001), null);
    assert.equal(
        resolvePluginScopeSelfId([{ self_id: 10001, status: 'online' }], 10001),
        null
    );
});

test('multiple online accounts use the preferred valid account', () => {
    const accounts = [
        { self_id: 10001, status: 'online' },
        { self_id: 10002, status: 'online' },
    ];
    assert.equal(resolvePluginScopeSelfId(accounts, 10002), 10002);
});

test('multiple accounts fall back to the first online account', () => {
    const accounts = [
        { self_id: 10001, status: 'online' },
        { self_id: 10002, status: 'offline' },
        { self_id: 10003, status: 'online' },
    ];
    assert.equal(resolvePluginScopeSelfId(accounts, 10002), 10001);
});
