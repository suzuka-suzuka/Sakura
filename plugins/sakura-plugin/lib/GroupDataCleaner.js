const MEMBER_COLUMNS = ['user_id', 'owner_id', 'from_user_id', 'to_user_id'];
const quote = name => `"${name.replaceAll('"', '""')}"`;

// 只操作带 group_id 的表，图片元数据等全局数据不参与清理。
export class GroupDataCleaner {
  constructor(db, { getBots, getConfiguredSelfIds = () => [], canDelete = () => true, logger = console }) {
    Object.assign(this, { db, getBots, getConfiguredSelfIds, canDelete, logger });
    this.running = false;
    this.db.prepare('CREATE TABLE IF NOT EXISTS data_cleanup_accounts (self_id TEXT PRIMARY KEY)').run();
  }

  tables() {
    const version = this.db.prepare('PRAGMA schema_version').get().schema_version;
    if (this.schemaVersion === version) return this.groupTables;
    this.groupTables = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .map(({ name }) => ({ name, columns: this.db.prepare(`PRAGMA table_info(${quote(name)})`).all().map(c => c.name) }))
      .filter(table => table.columns.includes('group_id'));
    this.schemaVersion = version;
    return this.groupTables;
  }

  groups() {
    return [...new Set(this.tables().flatMap(({ name }) =>
      this.db.prepare(`SELECT DISTINCT group_id FROM ${quote(name)}`).all().map(row => String(row.group_id))))];
  }

  members(groupId) {
    return [...new Set(this.tables().flatMap(({ name, columns }) => MEMBER_COLUMNS
      .filter(column => columns.includes(column)).flatMap(column => this.db.prepare(
        `SELECT DISTINCT ${quote(column)} AS user_id FROM ${quote(name)} WHERE group_id = ?`
      ).all(String(groupId)).map(row => String(row.user_id)))))];
  }

  deleteData(groupId, userId = null) {
    const group = String(groupId), user = userId == null ? null : String(userId);
    if (!this.canDelete(group, user)) return 0;
    return this.db.transaction(() => {
      let deleted = 0;
      // 发红包的人离群后，红包和对应的领取明细一起作废，避免过期退款重建账号。
      if (user != null) {
        deleted += this.db.prepare(`DELETE FROM red_packet_claims WHERE packet_id IN
          (SELECT id FROM red_packets WHERE group_id = ? AND user_id = ?)`).run(group, user).changes;
      }
      for (const { name, columns } of this.tables()) {
        const owned = MEMBER_COLUMNS.filter(column => columns.includes(column));
        if (user != null && owned.length === 0) continue;
        const predicate = user == null ? '' : ` AND (${owned.map(column => `${quote(column)} = ?`).join(' OR ')})`;
        deleted += this.db.prepare(`DELETE FROM ${quote(name)} WHERE group_id = ?${predicate}`)
          .run(group, ...owned.filter(() => user != null).map(() => user)).changes;
        // 保留仍在群内成员自己的流水，只去掉已经离群的交易对象。
        if (user != null && columns.includes('target_user_id')) {
          this.db.prepare(`UPDATE ${quote(name)} SET target_user_id = NULL WHERE group_id = ? AND target_user_id = ?`)
            .run(group, user);
        }
      }
      return deleted;
    }).immediate();
  }

  observeBots() {
    const bots = this.getBots();
    const insert = this.db.prepare('INSERT OR IGNORE INTO data_cleanup_accounts (self_id) VALUES (?)');
    for (const bot of bots) insert.run(String(bot.self_id));
    return bots;
  }

  isCurrent(bots) {
    const current = this.getBots();
    return current.length === bots.length && bots.every(bot => current.includes(bot));
  }

  async snapshot() {
    const bots = this.observeBots();
    if (bots.length === 0) {
      this.logger.warn('[数据清理] 跳过本轮：没有在线 Bot');
      return null;
    }
    const known = [...this.getConfiguredSelfIds(), ...this.db.prepare('SELECT self_id FROM data_cleanup_accounts').all().map(row => row.self_id)];
    const offline = new Set(known.map(String).filter(id => !bots.some(bot => String(bot.self_id) === id)));
    const complete = offline.size === 0;
    if (!complete) this.logger.warn(`[数据清理] 有 ${offline.size} 个已配置或历史 Bot 离线：保留无法确认的整群数据，继续核对在线 Bot 所在群的成员`);
    const groups = new Map();
    for (const bot of bots) {
      const list = await bot.getGroupList();
      if (!Array.isArray(list) || list.some(row => !validId(row?.group_id))) {
        this.logger.warn('[数据清理] 跳过本轮：群列表格式异常');
        return null;
      }
      for (const row of list) {
        const id = String(row.group_id);
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(bot);
      }
    }
    if (!this.isCurrent(bots)) {
      this.logger.warn('[数据清理] 跳过本轮：核对期间在线 Bot 发生变化');
      return null;
    }
    return { bots, groups, complete };
  }

  async liveMembers(owners, groupId) {
    const members = new Set();
    for (const bot of owners) {
      const list = await bot.getGroupMemberList({ group_id: Number(groupId), no_cache: true });
      if (!Array.isArray(list) || list.some(row => !validId(row?.user_id)) ||
          !list.some(row => String(row.user_id) === String(bot.self_id))) return null;
      for (const row of list) members.add(String(row.user_id));
    }
    return members;
  }

  async cleanGroup(snapshot, groupId, userId = null) {
    const owners = snapshot.groups.get(String(groupId));
    // 历史账号离线只影响整群归属判断，不应阻塞当前群的成员清理。
    if (!owners) {
      if (!snapshot.complete) {
        this.logger.warn(`[数据清理] 跳过群 ${groupId}：存在离线 Bot，无法确认所有 Bot 均已离群`);
        return 0;
      }
      return this.isCurrent(snapshot.bots) ? this.deleteData(groupId) : 0;
    }
    const members = await this.liveMembers(owners, groupId);
    if (!members || !this.isCurrent(snapshot.bots)) {
      this.logger.warn(`[数据清理] 跳过群 ${groupId}：成员列表异常或在线 Bot 发生变化`);
      return 0;
    }
    const stale = userId == null ? this.members(groupId) : [String(userId)];
    let deleted = 0;
    for (const user of stale) {
      if (!members.has(user)) deleted += this.deleteData(groupId, user);
    }
    return deleted;
  }

  async run(event = null) {
    // Cron 按 Bot 账号分别调用，但数据库是共享的，一次只允许一轮核对。
    if (this.running) return false;
    if (event && ![event.group_id, event.user_id, event.self_id].every(validId)) return false;
    this.running = true;
    try {
      const snapshot = await this.snapshot();
      if (!snapshot) return false;
      const groups = event ? [String(event.group_id)] : this.groups();
      let totalDeleted = 0;
      for (const group of groups) {
        try {
          const user = event && String(event.user_id) !== String(event.self_id) ? event.user_id : null;
          const deleted = await this.cleanGroup(snapshot, group, user);
          totalDeleted += deleted;
          if (deleted > 0) this.logger.info(`[数据清理] 群 ${group}${user == null ? '' : ` 成员 ${user}`}：删除 ${deleted} 条记录`);
        } catch (error) {
          this.logger.warn(`[数据清理] 跳过群 ${group}：${error.message}`);
        }
      }
      this.logger.info(`[数据清理] 本轮核对结束：检查 ${groups.length} 个群，删除 ${totalDeleted} 条记录`);
      return true;
    } catch (error) {
      this.logger.warn(`[数据清理] 本轮核对失败：${error.message}`);
      return false;
    } finally {
      this.running = false;
    }
  }
}

function validId(value) {
  return /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

// 钓鱼还有定时回调时延后删除，下一轮核对会补清，避免结算重新写出离群账号。
export const dataCleanupGuards = new Set();
export function canDeleteGroupData(groupId, userId) {
  return [...dataCleanupGuards].every(guard => guard(groupId, userId));
}
