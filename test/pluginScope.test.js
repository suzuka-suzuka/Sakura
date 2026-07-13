import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getCronPluginScopeIds,
    resolveRuntimePluginSelfId,
} from '../src/core/pluginScope.js';

test('zero or one online bot always resolves plugin config to global scope', () => {
    assert.equal(resolveRuntimePluginSelfId([], 10001), null);
    assert.equal(resolveRuntimePluginSelfId([10001], 10001), null);
    assert.equal(resolveRuntimePluginSelfId([10001, 10001], 10001), null);
    assert.deepEqual(getCronPluginScopeIds([10001]), []);
});

test('multiple online bots resolve only valid account scopes', () => {
    assert.equal(resolveRuntimePluginSelfId([10001, 10002], 10002), 10002);
    assert.equal(resolveRuntimePluginSelfId([10001, 10002], 99999), null);
    assert.deepEqual(getCronPluginScopeIds([10001, 10002]), [10001, 10002]);
});
