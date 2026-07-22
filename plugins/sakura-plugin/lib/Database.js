import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { plugindata } from './path.js';

const REMOVED_FISHING_ITEMS = Object.freeze([
  'item_sign_koi',
  '锦鲤许愿签',
  'item_charm_starlight',
  '星光护符',
  'item_card_star_double',
  '双倍星辉卡',
  'item_scale_leviathan',
  '利维坦的逆鳞',
  'item_snack_petal',
  '花瓣小鱼干',
]);

class DB {
  constructor() {
    this.dbPath = path.join(plugindata, 'sakura.sqlite');

    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.init();
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS economy (
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        coins INTEGER DEFAULT 0,
        experience INTEGER DEFAULT 0,
        level INTEGER DEFAULT 1,
        bag_level INTEGER DEFAULT 1,
        PRIMARY KEY (group_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS economy_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        target_user_id TEXT,
        type TEXT NOT NULL,
        amount INTEGER NOT NULL,
        balance_after INTEGER,
        note TEXT,
        related_id TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_economy_transactions_user_time
      ON economy_transactions (group_id, user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS economy_daily_claims (
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        claim_type TEXT NOT NULL,
        claim_date TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, user_id, claim_type, claim_date)
      );

      CREATE INDEX IF NOT EXISTS idx_economy_daily_claims_created_at
      ON economy_daily_claims (created_at);

      CREATE TABLE IF NOT EXISTS economy_one_time_claims (
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        claim_type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, user_id, claim_type)
      );

      CREATE TABLE IF NOT EXISTS inventory (
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        count INTEGER DEFAULT 0,
        PRIMARY KEY (group_id, user_id, item_id)
      );

      CREATE TABLE IF NOT EXISTS fishing_stats (
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        rod TEXT,
        line TEXT,
        bait TEXT,
        total_attempts INTEGER DEFAULT 0,
        total_catch INTEGER DEFAULT 0,
        total_earnings INTEGER DEFAULT 0,
        torpedo_hits INTEGER DEFAULT 0,
        profession TEXT,
        profession_level INTEGER DEFAULT 0,
        fishing_exp INTEGER DEFAULT 0,
        fishing_stamina INTEGER DEFAULT 10,
        fishing_stamina_updated_at INTEGER DEFAULT 0,
        nightmare_curse_layers INTEGER DEFAULT 0,
        nightmare_curse_prank_revealed INTEGER DEFAULT 0,
        bride_thread_layers INTEGER DEFAULT 0,
        bride_nightmare_multiplier REAL DEFAULT 1,
        lost_soul INTEGER DEFAULT 0,
        ghost_debt INTEGER DEFAULT 0,
        deep_pressure_layers INTEGER DEFAULT 0,
        nightmare_immunity_charges INTEGER DEFAULT 0,
        nightmare_immunity_updated_at INTEGER DEFAULT 0,
        location TEXT,
        PRIMARY KEY (group_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS fishing_counts (
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        fish_id TEXT NOT NULL,
        count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        max_weight REAL DEFAULT 0,
        shiny_count INTEGER DEFAULT 0,
        PRIMARY KEY (group_id, user_id, fish_id)
      );

      CREATE TABLE IF NOT EXISTS fishing_attempts (
        session_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        fish_id TEXT,
        success INTEGER NOT NULL DEFAULT 0,
        earnings INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_fishing_attempts_created_at
      ON fishing_attempts (created_at);

      CREATE TABLE IF NOT EXISTS rod_stats (
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        rod_id TEXT NOT NULL,
        damage INTEGER DEFAULT 0,
        mastery INTEGER DEFAULT 0,
        control_loss INTEGER DEFAULT 0,
        PRIMARY KEY (group_id, user_id, rod_id)
      );

      CREATE TABLE IF NOT EXISTS pond_torpedoes (
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        timestamp INTEGER,
        location TEXT NOT NULL DEFAULT 'pond',
        PRIMARY KEY (group_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS favorability (
        group_id TEXT NOT NULL,
        from_user_id TEXT NOT NULL,
        to_user_id TEXT NOT NULL,
        value INTEGER DEFAULT 0,
        PRIMARY KEY (group_id, from_user_id, to_user_id)
      );
      
      CREATE TABLE IF NOT EXISTS user_buffs (
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        buff_id TEXT NOT NULL,
        name TEXT,
        effect TEXT,
        activated_at INTEGER,
        expire_time INTEGER,
        PRIMARY KEY (group_id, user_id, buff_id)
      );

      CREATE TABLE IF NOT EXISTS image_metadata (
        id TEXT PRIMARY KEY,
        hash TEXT NOT NULL UNIQUE,
        file_path TEXT,
        file_name TEXT,
        description TEXT,
        metadata TEXT,
        created_at INTEGER
      );
    `);
    this.migrate();
  }

  // 老库补列：CREATE TABLE IF NOT EXISTS 不会给已存在的表加新列
  migrate() {
    const economyColumns = this.db.prepare('PRAGMA table_info(economy)').all();
    if (!economyColumns.some((column) => column.name === 'bag_level')) {
      this.db.exec('ALTER TABLE economy ADD COLUMN bag_level INTEGER DEFAULT 1');
    }

    const fishingStatsColumns = this.db.prepare('PRAGMA table_info(fishing_stats)').all();
    if (!fishingStatsColumns.some((column) => column.name === 'total_catch')) {
      this.db.exec('ALTER TABLE fishing_stats ADD COLUMN total_catch INTEGER DEFAULT 0');
    }
    if (!fishingStatsColumns.some((column) => column.name === 'total_attempts')) {
      this.db.exec('ALTER TABLE fishing_stats ADD COLUMN total_attempts INTEGER DEFAULT 0');
      // 旧 total_catch 混合了成功渔获和部分失败遭遇：尽可能保留为历史总垂钓下限，
      // 再用逐鱼 success_count 校正“成功渔获”的准确口径。
      this.db.exec(`
        UPDATE fishing_stats
        SET total_attempts = MAX(
              COALESCE(total_catch, 0),
              COALESCE((
                SELECT SUM(fc.count)
                FROM fishing_counts AS fc
                WHERE fc.group_id = fishing_stats.group_id
                  AND fc.user_id = fishing_stats.user_id
              ), 0)
            ),
            total_catch = COALESCE((
              SELECT SUM(fc.success_count)
              FROM fishing_counts AS fc
              WHERE fc.group_id = fishing_stats.group_id
                AND fc.user_id = fishing_stats.user_id
            ), 0)
      `);
    }
    if (!fishingStatsColumns.some((column) => column.name === 'fishing_exp')) {
      this.db.exec('ALTER TABLE fishing_stats ADD COLUMN fishing_exp INTEGER DEFAULT 0');
    }
    if (!fishingStatsColumns.some((column) => column.name === 'fishing_stamina')) {
      this.db.exec('ALTER TABLE fishing_stats ADD COLUMN fishing_stamina INTEGER DEFAULT 10');
    }
    if (!fishingStatsColumns.some((column) => column.name === 'fishing_stamina_updated_at')) {
      this.db.exec('ALTER TABLE fishing_stats ADD COLUMN fishing_stamina_updated_at INTEGER DEFAULT 0');
    }
    if (!fishingStatsColumns.some((column) => column.name === 'nightmare_curse_layers')) {
      this.db.exec('ALTER TABLE fishing_stats ADD COLUMN nightmare_curse_layers INTEGER DEFAULT 0');
    }
    if (!fishingStatsColumns.some((column) => column.name === 'nightmare_curse_prank_revealed')) {
      this.db.exec('ALTER TABLE fishing_stats ADD COLUMN nightmare_curse_prank_revealed INTEGER DEFAULT 0');
    }
    if (!fishingStatsColumns.some((column) => column.name === 'bride_thread_layers')) {
      this.db.exec('ALTER TABLE fishing_stats ADD COLUMN bride_thread_layers INTEGER DEFAULT 0');
    }
    if (!fishingStatsColumns.some((column) => column.name === 'bride_nightmare_multiplier')) {
      this.db.exec('ALTER TABLE fishing_stats ADD COLUMN bride_nightmare_multiplier REAL DEFAULT 1');
      // 旧版冥婚红线只要仍有层数，就迁移为新版花嫁噩梦权重翻倍。
      this.db.exec(`
        UPDATE fishing_stats
        SET bride_nightmare_multiplier = 2,
            bride_thread_layers = 0
        WHERE COALESCE(bride_thread_layers, 0) > 0
      `);
    }
    if (!fishingStatsColumns.some((column) => column.name === 'lost_soul')) {
      this.db.exec('ALTER TABLE fishing_stats ADD COLUMN lost_soul INTEGER DEFAULT 0');
    }
    if (!fishingStatsColumns.some((column) => column.name === 'ghost_debt')) {
      this.db.exec('ALTER TABLE fishing_stats ADD COLUMN ghost_debt INTEGER DEFAULT 0');
    }
    if (!fishingStatsColumns.some((column) => column.name === 'deep_pressure_layers')) {
      this.db.exec('ALTER TABLE fishing_stats ADD COLUMN deep_pressure_layers INTEGER DEFAULT 0');
    }
    if (!fishingStatsColumns.some((column) => column.name === 'nightmare_immunity_charges')) {
      this.db.exec('ALTER TABLE fishing_stats ADD COLUMN nightmare_immunity_charges INTEGER DEFAULT 0');
    }
    if (!fishingStatsColumns.some((column) => column.name === 'nightmare_immunity_updated_at')) {
      this.db.exec('ALTER TABLE fishing_stats ADD COLUMN nightmare_immunity_updated_at INTEGER DEFAULT 0');
    }

    const fishingCountsColumns = this.db.prepare('PRAGMA table_info(fishing_counts)').all();
    if (!fishingCountsColumns.some((column) => column.name === 'max_weight')) {
      this.db.exec('ALTER TABLE fishing_counts ADD COLUMN max_weight REAL DEFAULT 0');
    }
    if (!fishingCountsColumns.some((column) => column.name === 'shiny_count')) {
      this.db.exec('ALTER TABLE fishing_counts ADD COLUMN shiny_count INTEGER DEFAULT 0');
    }

    if (!fishingStatsColumns.some((column) => column.name === 'location')) {
      this.db.exec('ALTER TABLE fishing_stats ADD COLUMN location TEXT');
    }

    const rodStatsColumns = this.db.prepare('PRAGMA table_info(rod_stats)').all();
    if (!rodStatsColumns.some((column) => column.name === 'control_loss')) {
      this.db.exec('ALTER TABLE rod_stats ADD COLUMN control_loss INTEGER DEFAULT 0');
    }

    const torpedoColumns = this.db.prepare('PRAGMA table_info(pond_torpedoes)').all();
    if (!torpedoColumns.some((column) => column.name === 'location')) {
      // 旧版鱼雷没有钓点概念，统一迁移到初始钓点樱花池塘。
      this.db.exec("ALTER TABLE pond_torpedoes ADD COLUMN location TEXT NOT NULL DEFAULT 'pond'");
    }
    this.db.exec(`
      UPDATE pond_torpedoes
      SET location = 'pond'
      WHERE location IS NULL
         OR location NOT IN ('pond', 'river', 'lake', 'coast', 'abyss', 'mystic');

      CREATE INDEX IF NOT EXISTS idx_pond_torpedoes_group_location
      ON pond_torpedoes (group_id, location);
    `);

    // 新道具体系不兼容已删除物品：启动迁移时直接从所有旧背包和旧Buff表清掉。
    const removedItemPlaceholders = REMOVED_FISHING_ITEMS.map(() => '?').join(', ');
    this.db.prepare(`
      DELETE FROM inventory
      WHERE item_id IN (${removedItemPlaceholders})
    `).run(...REMOVED_FISHING_ITEMS);
    this.db.prepare(`
      DELETE FROM user_buffs
      WHERE buff_id IN (${removedItemPlaceholders})
    `).run(...REMOVED_FISHING_ITEMS);
  }

  prepare(sql) {
    return this.db.prepare(sql);
  }

  transaction(fn) {
    return this.db.transaction(fn);
  }
}

export default new DB();
