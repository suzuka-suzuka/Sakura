// 使用内存 SQLite 和模拟 OneBot 列表，不访问正式玩家库或真实群。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import Database from 'better-sqlite3';
import { GroupDataCleaner, dataCleanupGuards, canDeleteGroupData } from '../lib/GroupDataCleaner.js';

const schema = fs.readFileSync(new URL('../lib/Database.js', import.meta.url), 'utf8')
  .match(/this\.db\.exec\(`([\s\S]*?)`\)/)[1];

function bot(id = 900, groups = [100], members = [900, 2]) {
  return { self_id: id,
    getGroupList: async () => groups.map(group_id => ({ group_id })),
    getGroupMemberList: async () => members.map(user_id => ({ user_id })) };
}

function fixture(t, bots = [bot()], options = {}) {
  const db = new Database(':memory:');
  db.exec(schema);
  t.after(() => db.close());
  let online = bots;
  const cleaner = new GroupDataCleaner(db, { getBots: () => online,
    logger: { info() {}, warn() {} }, ...options });
  const seed = (group = 100, user = 1) => {
    for (const table of cleaner.tables()) {
      const required = db.prepare(`PRAGMA table_info("${table.name}")`).all().filter(column => column.notnull && column.dflt_value == null);
      const values = Object.fromEntries(required.map(column => [column.name,
        column.name === 'group_id' ? String(group) : MEMBER_IDS.has(column.name) ? String(user) : column.type === 'TEXT' ? 'fixture' : 1]));
      if (table.name === 'fishing_attempts') values.session_id = `${group}-${user}`;
      if (table.name === 'red_packet_claims') values.packet_id = db.prepare(
        'SELECT id FROM red_packets WHERE group_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1'
      ).get(String(group), String(user)).id;
      db.prepare(`INSERT INTO "${table.name}" (${Object.keys(values).join(',')}) VALUES (${Object.keys(values).map(() => '?').join(',')})`)
        .run(...Object.values(values));
    }
  };
  const count = (table, group = 100) => db.prepare(`SELECT count(*) AS n FROM "${table}" WHERE group_id = ?`).get(String(group)).n;
  return { db, cleaner, seed, count, setOnline: value => { online = value; } };
}
const MEMBER_IDS = new Set(['user_id', 'owner_id', 'from_user_id', 'to_user_id']);

test('整群清理覆盖所有群表，保留其他群和全局图片，重复清理幂等', t => {
  const f = fixture(t);
  f.seed(); f.seed(200, 1);
  f.db.prepare("INSERT INTO image_metadata (id, hash) VALUES ('image', 'hash')").run();
  assert.ok(f.cleaner.deleteData(100) > 0);
  for (const table of f.cleaner.tables()) {
    assert.equal(f.count(table.name), 0, table.name);
    assert.equal(f.count(table.name, 200), 1, table.name);
  }
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM image_metadata').get().n, 1);
  assert.equal(f.cleaner.deleteData(100), 0);
});

test('成员清理覆盖双方好感度和部署物，只影响该群该成员', t => {
  const f = fixture(t);
  f.seed(); f.seed(100, 2); f.seed(200, 1);
  f.db.prepare('INSERT INTO favorability VALUES (?, ?, ?, ?)').run('100', '2', '1', 50);
  f.db.prepare('UPDATE economy_transactions SET target_user_id = ? WHERE user_id = ?').run('1', '2');
  f.cleaner.deleteData(100, 1);
  for (const table of f.cleaner.tables()) {
    assert.equal(f.count(table.name), 1, table.name);
    assert.equal(f.count(table.name, 200), 1, table.name);
  }
  assert.equal(f.db.prepare("SELECT target_user_id FROM economy_transactions WHERE group_id = '100'").get().target_user_id, null);
});

test('删除发红包者时删除所有领取明细，领取者自己其他红包的记录仍保留', t => {
  const f = fixture(t); f.seed(); f.seed(100, 2);
  const packet = f.db.prepare("SELECT id FROM red_packets WHERE user_id = '1'").get().id;
  f.db.prepare('INSERT INTO red_packet_claims VALUES (?, ?, ?, ?, ?)').run(packet, '100', '2', 1, 1);
  f.cleaner.deleteData(100, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM red_packet_claims WHERE packet_id = ?').get(packet).n, 0);
  assert.equal(f.count('economy'), 1);
  assert.equal(f.count('red_packets'), 1);
});

test('删除任意表失败时整批回滚', t => {
  const f = fixture(t); f.seed();
  f.db.exec("CREATE TRIGGER reject_inventory BEFORE DELETE ON inventory BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END");
  assert.throws(() => f.cleaner.deleteData(100, 1), /fixture rollback/);
  for (const table of f.cleaner.tables()) assert.equal(f.count(table.name), 1, table.name);
});

test('历史核对删除不在任何 Bot 群列表中的群及已经退群的成员', async t => {
  const f = fixture(t); f.seed(); f.seed(100, 2); f.seed(200, 1);
  assert.equal(await f.cleaner.run(), true);
  assert.equal(f.count('economy'), 1);
  assert.equal(f.count('economy', 200), 0);
});

test('指定范围核对会删除离群成员，最后一个 Bot 离群后可清理整群', async t => {
  const f = fixture(t); f.seed(); f.seed(100, 2);
  await f.cleaner.run({ group_id: 100, user_id: 1, self_id: 900 });
  assert.equal(f.count('economy'), 1);
  f.setOnline([bot(900, [])]);
  await f.cleaner.run({ group_id: 100, user_id: 900, self_id: 900 });
  assert.equal(f.count('economy'), 0);
});

test('异常退群事件不触发整群清理', async t => {
  const f = fixture(t, [bot(900, [])]); f.seed();
  assert.equal(await f.cleaner.run({ group_id: 100, user_id: null, self_id: 900 }), false);
  assert.equal(f.count('economy'), 1);
});

test('缓存表结构后新增群表仍会被纳入清理', t => {
  const f = fixture(t); f.cleaner.tables();
  f.db.exec("CREATE TABLE extra_group_data (group_id TEXT, user_id TEXT); INSERT INTO extra_group_data VALUES ('100', '1')");
  f.cleaner.deleteData(100, 1);
  assert.equal(f.count('extra_group_data'), 0);
});

test('Bot 退群但另一个 Bot 仍在群内时保留该群', async t => {
  const f = fixture(t, [bot(900, []), bot(901, [100], [901, 1])]); f.seed();
  await f.cleaner.run({ group_id: 100, user_id: 900, self_id: 900 });
  assert.equal(f.count('economy'), 1);
});

test('多 Bot 成员列表取并集；延迟退群事件不会删除已重新入群的成员', async t => {
  const f = fixture(t, [bot(900, [100], [900, 2]), bot(901, [100], [901, 1])]); f.seed();
  await f.cleaner.run({ group_id: 100, user_id: 1, self_id: 900 });
  assert.equal(f.count('economy'), 1);
});

for (const value of [null, {}, [{ group_id: 0 }]]) {
  test(`群列表异常 ${JSON.stringify(value)} 时不删数据`, async t => {
    const b = bot(); b.getGroupList = async () => value;
    const f = fixture(t, [b]); f.seed();
    assert.equal(await f.cleaner.run(), false);
    assert.equal(f.count('economy'), 1);
  });
}

for (const value of [null, [], [{ user_id: 2 }], [{ user_id: 900 }, { user_id: null }]]) {
  test(`成员列表异常 ${JSON.stringify(value)} 时保留数据`, async t => {
    const b = bot(); b.getGroupMemberList = async () => value;
    const f = fixture(t, [b]); f.seed();
    await f.cleaner.run();
    assert.equal(f.count('economy'), 1);
  });
}

test('没有在线 Bot 或存在已配置的离线账号时不删数据', async t => {
  const f = fixture(t, [], { getConfiguredSelfIds: () => [901] }); f.seed();
  assert.equal(await f.cleaner.run(), false);
  f.setOnline([bot()]);
  assert.equal(await f.cleaner.run(), false);
  assert.equal(f.count('economy'), 1);
});

test('曾出现的 Bot 离线，重新创建清理器后也跳过整群删除', async t => {
  const f = fixture(t, [bot(900), bot(901, [])]); f.seed(); f.cleaner.observeBots();
  const next = new GroupDataCleaner(f.db, { getBots: () => [bot(900, [])] });
  assert.equal(await next.run(), false);
  assert.equal(f.count('economy'), 1);
});

test('核对过程中断线或同 QQ 实例被替换时不删数据', async t => {
  const b = bot(), f = fixture(t, [b]); f.seed();
  b.getGroupMemberList = async () => { f.setOnline([bot()]); return [{ user_id: 900 }]; };
  await f.cleaner.run();
  assert.equal(f.count('economy'), 1);
});

test('正在钓鱼时延后删除，结束后下一轮补清', async t => {
  let active = true;
  const guard = () => !active;
  dataCleanupGuards.add(guard); t.after(() => dataCleanupGuards.delete(guard));
  const f = fixture(t, [bot()], { canDelete: canDeleteGroupData }); f.seed();
  await f.cleaner.run(); assert.equal(f.count('economy'), 1);
  active = false;
  await f.cleaner.run(); assert.equal(f.count('economy'), 0);
});

test('同时触发多个账号的定时核对时只运行一轮', async t => {
  const b = bot(), f = fixture(t, [b]); f.seed();
  let resolve;
  b.getGroupList = () => new Promise(done => { resolve = done; });
  const first = f.cleaner.run();
  assert.equal(await f.cleaner.run(), false);
  resolve([{ group_id: 100 }]);
  await first;
  assert.equal(f.count('economy'), 0);
});

test('插件仅每天凌晨 4 点核对，退群和账号记录事件不触发清理', async () => {
  const calls = [], eventPatterns = [], context = vm.createContext({
    plugin: class { constructor(options) { Object.assign(this, options); } }, logger: {},
    OnEvent: (pattern, callback) => { eventPatterns.push(pattern); return Object.assign(callback, { pattern }); },
    Cron: (pattern, callback) => Object.assign(callback, { pattern }),
  });
  const source = new vm.SourceTextModule(fs.readFileSync(new URL('../apps/DataCleanup.js', import.meta.url), 'utf8'), { context });
  const imports = {
    '../lib/Database.js': { default: {} },
    '../lib/GroupDataCleaner.js': { GroupDataCleaner: class { run(e) { calls.push(e); } observeBots() {} }, canDeleteGroupData() {} },
    '../../../src/api/client.js': { getBots: () => [] },
    '../../../src/core/accountConfig.js': { default: { listConfiguredSelfIds: () => [] } },
  };
  await source.link(specifier => new vm.SyntheticModule(Object.keys(imports[specifier]), function () {
    for (const [name, value] of Object.entries(imports[specifier])) this.setExport(name, value);
  }, { context }));
  await source.evaluate();
  const app = new source.namespace.DataCleanup();
  assert.equal(app.handleDecrease, undefined);
  assert.deepEqual(eventPatterns, ['meta_event']);
  assert.equal(app.reconcileData.pattern, '0 4 * * *');
  assert.equal(app.recordAccounts(), false);
  assert.equal(calls.length, 0);
  await app.reconcileData();
  assert.equal(calls.length, 1);
  assert.equal(calls[0], undefined);
});
