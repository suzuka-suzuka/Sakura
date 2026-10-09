import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { plugindata } from './path.js';

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

      CREATE TABLE IF NOT EXISTS red_packets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'lucky',
        total_amount INTEGER NOT NULL,
        total_count INTEGER NOT NULL,
        claimed_count INTEGER NOT NULL DEFAULT 0,
        shares TEXT NOT NULL,
        blessing TEXT,
        minted INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_red_packets_group_status
      ON red_packets (group_id, status, created_at);

      CREATE INDEX IF NOT EXISTS idx_red_packets_status_expire
      ON red_packets (status, expires_at);

      CREATE TABLE IF NOT EXISTS red_packet_claims (
        packet_id INTEGER NOT NULL,
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        amount INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (packet_id, user_id)
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
        ghost_debt_turns_remaining INTEGER DEFAULT 0,
        ghost_debt_mark INTEGER DEFAULT 0,
        deep_pressure_layers INTEGER DEFAULT 0,
        blindness_layers INTEGER DEFAULT 0,
        nightmare_immunity_charges INTEGER DEFAULT 0,
        nightmare_immunity_updated_at INTEGER DEFAULT 0,
        koi_wish INTEGER DEFAULT 0,
        star_wish TEXT,
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

      CREATE TABLE IF NOT EXISTS fishing_location_unlocks (
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        location TEXT NOT NULL,
        unlocked_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, user_id, location)
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
        PRIMARY KEY (group_id, user_id, rod_id)
      );

      CREATE TABLE IF NOT EXISTS pond_torpedoes (
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        timestamp INTEGER,
        location TEXT NOT NULL DEFAULT 'pond',
        PRIMARY KEY (group_id, user_id, location)
      );

      CREATE INDEX IF NOT EXISTS idx_pond_torpedoes_group_location
      ON pond_torpedoes (group_id, location);

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

    // 为已有数据库补充期限字段，具体剩余竿数由放贷时初始化，不改写已有玩家状态。
    if (!this.db.pragma('table_info(fishing_stats)').some(column => column.name === 'ghost_debt_turns_remaining')) {
      this.db.exec('ALTER TABLE fishing_stats ADD COLUMN ghost_debt_turns_remaining INTEGER DEFAULT 0');
    }
  }

  prepare(sql) {
    return this.db.prepare(sql);
  }

  transaction(fn) {
    return this.db.transaction(fn);
  }
}

export default new DB();
