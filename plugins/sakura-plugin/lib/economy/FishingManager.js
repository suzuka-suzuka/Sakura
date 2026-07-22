import Setting from "../setting.js";
import InventoryManager from "./InventoryManager.js";
import db from "../Database.js";
import {
  calculateFishingStamina,
  FISHING_BENEFIT_DURATION_SECONDS,
  FISHING_LOCATIONS,
  FISHING_STAMINA_COST,
  FISHING_STAMINA_MAX,
  FISHING_STAMINA_RECOVERY_MS,
  getFishingStaminaCost,
  getFishingLevelByExp,
  getFishingStaminaMax,
  getNightmareCurseDisplay,
  NIGHTMARE_CURSE_HIDDEN_LAYERS,
  normalizeFishingLocation,
  TORPEDO_PRICE_BOOST_MULTIPLIER,
} from "../fishing/rules.js";

export default class FishingManager {
  constructor(groupId) {
    this.groupId = String(groupId);
  }

  // ==================== 职业系统 ====================

  static getProfessionYaml() {
    return Setting.getEconomy('profession') || {};
  }

  static getUnlockRequirements() {
    const yaml = FishingManager.getProfessionYaml();
    const requirements = yaml.unlock_requirements || {};
    const chooseLevel = Number(requirements.choose_fishing_level);
    const advanceLevel = Number(requirements.advance_fishing_level);
    const safeChooseLevel = Number.isFinite(chooseLevel) && chooseLevel > 0
      ? Math.floor(chooseLevel)
      : 8;
    const safeAdvanceLevel = Number.isFinite(advanceLevel) && advanceLevel >= safeChooseLevel
      ? Math.floor(advanceLevel)
      : Math.max(12, safeChooseLevel);
    return {
      choose_fishing_level: safeChooseLevel,
      advance_fishing_level: safeAdvanceLevel,
    };
  }

  static getProfessionConfig(professionId) {
    const yaml = FishingManager.getProfessionYaml();
    const professions = yaml.professions || {};
    return professions[professionId] || null;
  }

  static getAllProfessions() {
    const yaml = FishingManager.getProfessionYaml();
    const professions = yaml.professions || {};
    return Object.keys(professions).map(id => ({
      id,
      ...professions[id]
    }));
  }

  static getNightmareImmunityRules(professionId, professionLevel) {
    if (professionId !== 'abyss_hunter' || professionLevel <= 0) return null;
    const config = FishingManager.getProfessionConfig('abyss_hunter');
    const levelConfig = config?.levels?.[professionLevel];
    const maxCharges = Math.max(
      0,
      Math.floor(Number(levelConfig?.nightmare_immunity_max_charges) || 0),
    );
    const rechargeHours = Math.max(
      0,
      Number(levelConfig?.nightmare_immunity_recharge_hours) || 0,
    );
    if (maxCharges <= 0 || rechargeHours <= 0) return null;
    return {
      maxCharges,
      rechargeHours,
      rechargeMs: rechargeHours * 60 * 60 * 1000,
    };
  }

  _ensureUser(userId) {
    userId = String(userId);
    const row = db.prepare('SELECT 1 FROM fishing_stats WHERE group_id = ? AND user_id = ?').get(this.groupId, userId);
    if (!row) {
      db.prepare(`
              INSERT INTO fishing_stats
              (group_id, user_id, total_catch, total_earnings, torpedo_hits, profession, profession_level, fishing_stamina, fishing_stamina_updated_at)
              VALUES (?, ?, 0, 0, 0, NULL, 0, ?, 0)
          `).run(this.groupId, userId, FISHING_STAMINA_MAX);
    }
  }

  getUserData(userId) {
    userId = String(userId);
    this._ensureUser(userId);
    return db.prepare('SELECT * FROM fishing_stats WHERE group_id = ? AND user_id = ?').get(this.groupId, userId);
  }

  getUserProfession(userId) {
    const userData = this.getUserData(userId);
    const professionId = userData.profession;
    const level = userData.profession_level || 0;

    let title = null;
    if (professionId && level > 0) {
      const config = FishingManager.getProfessionConfig(professionId);
      if (config && config.levels && config.levels[level]) {
        title = config.levels[level].title;
      }
    }

    return {
      profession: professionId,
      level: level,
      title: title
    };
  }

  getUserFishingLevel(userId) {
    const userData = this.getUserData(userId);
    return getFishingLevelByExp(userData.fishing_exp || 0);
  }

  getFishingLocation(userId) {
    const userData = this.getUserData(userId);
    return normalizeFishingLocation(userData.location);
  }

  setFishingLocation(userId, locationId) {
    userId = String(userId);
    if (!FISHING_LOCATIONS[locationId]) return false;
    this._ensureUser(userId);
    db.prepare('UPDATE fishing_stats SET location = ? WHERE group_id = ? AND user_id = ?')
      .run(locationId, this.groupId, userId);
    return true;
  }

  _readFishingStamina(userId, now) {
    const row = db.prepare(`
        SELECT fishing_exp, fishing_stamina, fishing_stamina_updated_at, deep_pressure_layers
        FROM fishing_stats
        WHERE group_id = ? AND user_id = ?
    `).get(this.groupId, userId);
    const fishingLevel = getFishingLevelByExp(row?.fishing_exp || 0);
    const maxStamina = getFishingStaminaMax(fishingLevel);
    const snapshot = calculateFishingStamina(
      row?.fishing_stamina,
      row?.fishing_stamina_updated_at,
      now,
      maxStamina,
    );
    return {
      ...snapshot,
      max: maxStamina,
      deepPressureLayers: Math.max(0, Math.floor(Number(row?.deep_pressure_layers) || 0)),
    };
  }

  _writeFishingStamina(userId, stamina, updatedAt) {
    db.prepare(`
        UPDATE fishing_stats
        SET fishing_stamina = ?, fishing_stamina_updated_at = ?
        WHERE group_id = ? AND user_id = ?
    `).run(stamina, updatedAt, this.groupId, userId);
  }

  _formatFishingStaminaStatus(snapshot) {
    const cost = getFishingStaminaCost();
    return {
      current: snapshot.stamina,
      max: snapshot.max,
      cost,
      canFish: snapshot.stamina >= cost,
      deepPressureLayers: Math.max(0, Math.floor(Number(snapshot.deepPressureLayers) || 0)),
      recovered: snapshot.recovered || 0,
      nextRecoveryMs: snapshot.nextRecoveryMs || 0,
      nextRecoveryMinutes: snapshot.nextRecoveryMs > 0
        ? Math.max(1, Math.ceil(snapshot.nextRecoveryMs / 60000))
        : 0,
    };
  }

  getFishingStaminaStatus(userId, now = Date.now()) {
    userId = String(userId);
    this._ensureUser(userId);
    const transaction = db.transaction(() => {
      const snapshot = this._readFishingStamina(userId, now);
      this._writeFishingStamina(userId, snapshot.stamina, snapshot.updatedAt);
      return this._formatFishingStaminaStatus(snapshot);
    });
    return transaction.immediate();
  }

  consumeFishingStamina(userId, now = Date.now()) {
    userId = String(userId);
    this._ensureUser(userId);
    const transaction = db.transaction(() => {
      const snapshot = this._readFishingStamina(userId, now);
      const cost = getFishingStaminaCost();
      if (snapshot.stamina < cost) {
        this._writeFishingStamina(userId, snapshot.stamina, snapshot.updatedAt);
        return {
          success: false,
          ...this._formatFishingStaminaStatus(snapshot),
        };
      }

      const remaining = snapshot.stamina - cost;
      const deepPressureConsumed = snapshot.deepPressureLayers > 0;
      const remainingDeepPressure = deepPressureConsumed
        ? snapshot.deepPressureLayers - 1
        : 0;
      this._writeFishingStamina(userId, remaining, snapshot.updatedAt);
      if (deepPressureConsumed) {
        db.prepare(`
            UPDATE fishing_stats
            SET deep_pressure_layers = MAX(0, COALESCE(deep_pressure_layers, 0) - 1)
            WHERE group_id = ? AND user_id = ?
        `).run(this.groupId, userId);
      }
      const formatted = this._formatFishingStaminaStatus({
        ...snapshot,
        stamina: remaining,
        deepPressureLayers: remainingDeepPressure,
        recovered: 0,
        nextRecoveryMs: remaining < snapshot.max
          ? (snapshot.nextRecoveryMs || FISHING_STAMINA_RECOVERY_MS)
          : 0,
      });
      return {
        success: true,
        ...formatted,
        cost,
        nextCost: formatted.cost,
        deepPressureConsumed,
      };
    });
    return transaction.immediate();
  }

  drainFishingStamina(userId, amount, now = Date.now()) {
    userId = String(userId);
    const safeAmount = Math.max(0, Math.floor(Number(amount) || 0));
    this._ensureUser(userId);
    const transaction = db.transaction(() => {
      const snapshot = this._readFishingStamina(userId, now);
      const drained = Math.min(snapshot.stamina, safeAmount);
      const remaining = snapshot.stamina - drained;
      this._writeFishingStamina(userId, remaining, snapshot.updatedAt);
      return {
        ...this._formatFishingStaminaStatus({
          ...snapshot,
          stamina: remaining,
          recovered: 0,
          nextRecoveryMs: remaining < snapshot.max
            ? (snapshot.nextRecoveryMs || FISHING_STAMINA_RECOVERY_MS)
            : 0,
        }),
        drained,
        exhausted: remaining <= 0,
      };
    });
    return transaction.immediate();
  }

  restoreFishingStamina(userId, amount = FISHING_STAMINA_COST, now = Date.now()) {
    userId = String(userId);
    const safeAmount = Math.max(0, Math.floor(Number(amount) || 0));
    this._ensureUser(userId);
    const transaction = db.transaction(() => {
      const snapshot = this._readFishingStamina(userId, now);
      const restored = Math.min(snapshot.max, snapshot.stamina + safeAmount);
      const numericNow = Number(now);
      const safeNow = Number.isFinite(numericNow) && numericNow >= 0
        ? Math.floor(numericNow)
        : Date.now();
      const updatedAt = restored >= snapshot.max ? safeNow : snapshot.updatedAt;
      this._writeFishingStamina(userId, restored, updatedAt);
      return this._formatFishingStaminaStatus({
        ...snapshot,
        stamina: restored,
        updatedAt,
        recovered: restored - snapshot.stamina,
        nextRecoveryMs: restored < snapshot.max
          ? (snapshot.nextRecoveryMs || FISHING_STAMINA_RECOVERY_MS)
          : 0,
      });
    });
    return transaction.immediate();
  }

  forceFishingStaminaToOne(userId, now = Date.now()) {
    userId = String(userId);
    this._ensureUser(userId);
    const transaction = db.transaction(() => {
      const snapshot = this._readFishingStamina(userId, now);
      const numericNow = Number(now);
      const safeNow = Number.isFinite(numericNow) && numericNow >= 0
        ? Math.floor(numericNow)
        : Date.now();
      this._writeFishingStamina(userId, 1, safeNow);
      return {
        previous: snapshot.stamina,
        ...this._formatFishingStaminaStatus({
          ...snapshot,
          stamina: 1,
          updatedAt: safeNow,
          recovered: 0,
          nextRecoveryMs: snapshot.max > 1 ? FISHING_STAMINA_RECOVERY_MS : 0,
        }),
      };
    });
    return transaction.immediate();
  }

  canChooseProfession(userId) {
    const userData = this.getUserData(userId);
    const requirements = FishingManager.getUnlockRequirements();
    const fishingLevel = getFishingLevelByExp(userData.fishing_exp || 0);
    return fishingLevel >= requirements.choose_fishing_level && !userData.profession;
  }

  canAdvanceProfession(userId) {
    const userData = this.getUserData(userId);
    const requirements = FishingManager.getUnlockRequirements();
    const fishingLevel = getFishingLevelByExp(userData.fishing_exp || 0);
    return fishingLevel >= requirements.advance_fishing_level &&
      userData.profession &&
      userData.profession_level === 1;
  }

  chooseProfession(userId, professionId) {
    userId = String(userId);
    const userData = this.getUserData(userId);
    const requirements = FishingManager.getUnlockRequirements();
    const fishingLevel = getFishingLevelByExp(userData.fishing_exp || 0);

    if (userData.profession) {
      return { success: false, msg: "你已经有职业了，无法再选择其他职业！" };
    }

    if (fishingLevel < requirements.choose_fishing_level) {
      return {
        success: false,
        msg: `钓鱼等级不足！需要 Lv.${requirements.choose_fishing_level}，当前 Lv.${fishingLevel}`,
      };
    }

    const professionConfig = FishingManager.getProfessionConfig(professionId);
    if (!professionConfig) {
      return { success: false, msg: "无效的职业！" };
    }

    const levelConfig = professionConfig.levels[1];
    const immunityRules = FishingManager.getNightmareImmunityRules(professionId, 1);
    db.prepare(`
        UPDATE fishing_stats
        SET profession = ?, profession_level = 1,
            nightmare_immunity_charges = ?, nightmare_immunity_updated_at = ?
        WHERE group_id = ? AND user_id = ?
    `).run(
      professionId,
      immunityRules?.maxCharges || 0,
      immunityRules ? Date.now() : 0,
      this.groupId,
      userId,
    );

    return {
      success: true,
      msg: `成功选择职业【${professionConfig.icon}${professionConfig.name}】！`,
      profession: professionConfig,
      title: levelConfig.title
    };
  }

  advanceProfession(userId) {
    userId = String(userId);
    const userData = this.getUserData(userId);
    const requirements = FishingManager.getUnlockRequirements();
    const fishingLevel = getFishingLevelByExp(userData.fishing_exp || 0);

    if (!userData.profession) {
      return { success: false, msg: "你还没有职业，请先选择一个职业！" };
    }

    if (userData.profession_level >= 2) {
      return { success: false, msg: "你的职业已经达到最高等级！" };
    }

    if (fishingLevel < requirements.advance_fishing_level) {
      return {
        success: false,
        msg: `钓鱼等级不足！进阶需要 Lv.${requirements.advance_fishing_level}，当前 Lv.${fishingLevel}`,
      };
    }

    const professionConfig = FishingManager.getProfessionConfig(userData.profession);

    const levelConfig = professionConfig.levels[2];
    const immunityRules = FishingManager.getNightmareImmunityRules(userData.profession, 2);
    // 进阶时将新的储存上限充满，让二级职业的差异立即可见。
    db.prepare(`
        UPDATE fishing_stats
        SET profession_level = 2,
            nightmare_immunity_charges = ?, nightmare_immunity_updated_at = ?
        WHERE group_id = ? AND user_id = ?
    `).run(
      immunityRules?.maxCharges || 0,
      immunityRules ? Date.now() : 0,
      this.groupId,
      userId,
    );

    return {
      success: true,
      msg: `职业【${professionConfig.icon}${professionConfig.name}】进阶成功！现在是【${levelConfig.title}】！`,
      profession: professionConfig,
      title: levelConfig.title
    };
  }

  getTreasureWeightMultiplier(userId) {
    const userData = this.getUserData(userId);
    if (userData.profession !== 'treasure_hunter' || userData.profession_level <= 0) {
      return 1;
    }
    const config = FishingManager.getProfessionConfig('treasure_hunter');
    if (!config || !config.levels || !config.levels[userData.profession_level]) {
      return 1;
    }
    const multiplier = Number(
      config.levels[userData.profession_level].treasure_weight_multiplier,
    );
    return Number.isFinite(multiplier) ? Math.max(1, multiplier) : 1;
  }

  getLineBonusFromMastery(userId, rodId) {
    const userData = this.getUserData(userId);
    if (userData.profession !== 'fishing_master' || userData.profession_level <= 0) {
      return 0;
    }
    const mastery = this.getRodMastery(userId, rodId);
    const config = FishingManager.getProfessionConfig('fishing_master');
    if (!config || !config.levels || !config.levels[userData.profession_level]) {
      return 0;
    }
    const multiplier = config.levels[userData.profession_level].mastery_multiplier || 0;
    return Math.floor(mastery * multiplier);
  }

  getMerchantCoinMultiplier(userId) {
    const userData = this.getUserData(userId);
    if (userData.profession !== 'merchant' || userData.profession_level <= 0) {
      return 1;
    }
    const config = FishingManager.getProfessionConfig('merchant');
    if (!config || !config.levels || !config.levels[userData.profession_level]) {
      return 1;
    }
    const bonus = config.levels[userData.profession_level].coin_bonus || 0;
    return 1 + bonus;
  }

  _calculateNightmareImmunityState(userData, now = Date.now()) {
    const rules = FishingManager.getNightmareImmunityRules(
      userData?.profession,
      Math.max(0, Math.floor(Number(userData?.profession_level) || 0)),
    );
    const numericNow = Number(now);
    const safeNow = Number.isFinite(numericNow) && numericNow >= 0
      ? Math.floor(numericNow)
      : Date.now();
    if (!rules) {
      return {
        active: false,
        ready: false,
        charges: 0,
        maxCharges: 0,
        rechargeHours: 0,
        rechargeMs: 0,
        nextRecoveryMs: 0,
        nextRecoveryAt: 0,
        updatedAt: 0,
        now: safeNow,
        changed: false,
        recovered: 0,
      };
    }

    const rawCharges = Math.max(
      0,
      Math.floor(Number(userData?.nightmare_immunity_charges) || 0),
    );
    let charges = Math.min(rules.maxCharges, rawCharges);
    let updatedAt = Math.max(
      0,
      Math.floor(Number(userData?.nightmare_immunity_updated_at) || 0),
    );
    let changed = charges !== rawCharges;
    let recovered = 0;

    // 旧职业数据没有充能时间戳，首次读取时按当前职业等级补满。
    if (updatedAt <= 0) {
      charges = rules.maxCharges;
      updatedAt = safeNow;
      changed = true;
    } else if (charges < rules.maxCharges) {
      const elapsed = Math.max(0, safeNow - updatedAt);
      const recoverable = Math.floor(elapsed / rules.rechargeMs);
      if (recoverable > 0) {
        recovered = Math.min(rules.maxCharges - charges, recoverable);
        charges += recovered;
        updatedAt = charges >= rules.maxCharges
          ? safeNow
          : updatedAt + recovered * rules.rechargeMs;
        changed = true;
      }
    }

    const elapsedSinceTick = Math.max(0, safeNow - updatedAt);
    const nextRecoveryMs = charges < rules.maxCharges
      ? Math.max(1, rules.rechargeMs - Math.min(rules.rechargeMs, elapsedSinceTick))
      : 0;
    return {
      active: true,
      ready: charges > 0,
      charges,
      maxCharges: rules.maxCharges,
      rechargeHours: rules.rechargeHours,
      rechargeMs: rules.rechargeMs,
      nextRecoveryMs,
      nextRecoveryAt: nextRecoveryMs > 0 ? safeNow + nextRecoveryMs : 0,
      updatedAt,
      now: safeNow,
      changed,
      recovered,
    };
  }

  _writeNightmareImmunityState(userId, charges, updatedAt) {
    db.prepare(`
        UPDATE fishing_stats
        SET nightmare_immunity_charges = ?, nightmare_immunity_updated_at = ?
        WHERE group_id = ? AND user_id = ?
    `).run(charges, updatedAt, this.groupId, String(userId));
  }

  _formatNightmareImmunityStatus(status) {
    return {
      active: status.active,
      ready: status.ready,
      charges: status.charges,
      maxCharges: status.maxCharges,
      rechargeHours: status.rechargeHours,
      rechargeMs: status.rechargeMs,
      nextRecoveryMs: status.nextRecoveryMs,
      nextRecoveryAt: status.nextRecoveryAt,
      recovered: status.recovered,
    };
  }

  getNightmareImmunityStatus(userId, now = Date.now()) {
    userId = String(userId);
    this._ensureUser(userId);
    const transaction = db.transaction(() => {
      const userData = db.prepare(`
          SELECT profession, profession_level,
                 nightmare_immunity_charges, nightmare_immunity_updated_at
          FROM fishing_stats
          WHERE group_id = ? AND user_id = ?
      `).get(this.groupId, userId);
      const status = this._calculateNightmareImmunityState(userData, now);
      if (status.active && status.changed) {
        this._writeNightmareImmunityState(userId, status.charges, status.updatedAt);
      }
      return this._formatNightmareImmunityStatus(status);
    });
    return transaction.immediate();
  }

  consumeNightmareImmunity(userId, now = Date.now()) {
    userId = String(userId);
    this._ensureUser(userId);
    const transaction = db.transaction(() => {
      const userData = db.prepare(`
          SELECT profession, profession_level,
                 nightmare_immunity_charges, nightmare_immunity_updated_at
          FROM fishing_stats
          WHERE group_id = ? AND user_id = ?
      `).get(this.groupId, userId);
      const before = this._calculateNightmareImmunityState(userData, now);
      if (!before.active || before.charges <= 0) {
        if (before.active && before.changed) {
          this._writeNightmareImmunityState(userId, before.charges, before.updatedAt);
        }
        return {
          ...this._formatNightmareImmunityStatus(before),
          consumed: false,
          immune: false,
        };
      }

      const updatedAt = before.charges >= before.maxCharges
        ? before.now
        : before.updatedAt;
      this._writeNightmareImmunityState(userId, before.charges - 1, updatedAt);
      const after = this._calculateNightmareImmunityState({
        ...userData,
        nightmare_immunity_charges: before.charges - 1,
        nightmare_immunity_updated_at: updatedAt,
      }, before.now);
      return {
        ...this._formatNightmareImmunityStatus(after),
        consumed: true,
        immune: true,
      };
    });
    return transaction.immediate();
  }

  getNightmareStatus(userId) {
    const userData = this.getUserData(userId);
    return {
      curse: getNightmareCurseDisplay(
        userData.nightmare_curse_layers,
        userData.nightmare_curse_prank_revealed,
      ),
      brideNightmareMultiplier: Math.max(
        1,
        Number(userData.bride_nightmare_multiplier) || 1,
      ),
      ghostDebt: Math.max(0, Math.floor(Number(userData.ghost_debt) || 0)),
      deepPressureLayers: Math.max(0, Math.floor(Number(userData.deep_pressure_layers) || 0)),
    };
  }

  applyBrideNightmareMultiplier(userId, multiplier = 2) {
    userId = String(userId);
    const safeMultiplier = Math.max(1, Number(multiplier) || 1);
    this._ensureUser(userId);
    const before = this.getNightmareStatus(userId).brideNightmareMultiplier;
    const row = db.prepare(`
        UPDATE fishing_stats
        SET bride_nightmare_multiplier = MAX(
          1,
          COALESCE(bride_nightmare_multiplier, 1)
        ) * ?
        WHERE group_id = ? AND user_id = ?
        RETURNING bride_nightmare_multiplier
    `).get(safeMultiplier, this.groupId, userId);
    const total = Math.max(1, Number(row?.bride_nightmare_multiplier) || 1);
    return {
      applied: total > before,
      before,
      total,
    };
  }

  addGhostDebt(userId, amount) {
    userId = String(userId);
    const safeAmount = Math.max(0, Math.floor(Number(amount) || 0));
    this._ensureUser(userId);
    const before = this.getNightmareStatus(userId).ghostDebt;
    if (safeAmount <= 0) return { added: 0, total: before };
    const row = db.prepare(`
        UPDATE fishing_stats
        SET ghost_debt = COALESCE(ghost_debt, 0) + ?
        WHERE group_id = ? AND user_id = ?
        RETURNING ghost_debt
    `).get(safeAmount, this.groupId, userId);
    const total = Math.max(0, Number(row?.ghost_debt) || 0);
    return { added: Math.max(0, total - before), total };
  }

  addDeepPressureLayers(userId, layers) {
    userId = String(userId);
    const safeLayers = Math.max(0, Math.floor(Number(layers) || 0));
    this._ensureUser(userId);
    const before = this.getNightmareStatus(userId).deepPressureLayers;
    if (safeLayers <= 0) return { added: 0, total: before };
    const row = db.prepare(`
        UPDATE fishing_stats
        SET deep_pressure_layers = COALESCE(deep_pressure_layers, 0) + ?
        WHERE group_id = ? AND user_id = ?
        RETURNING deep_pressure_layers
    `).get(safeLayers, this.groupId, userId);
    const total = Math.max(0, Number(row?.deep_pressure_layers) || 0);
    return { added: Math.max(0, total - before), total };
  }

  restoreDeepPressureLayer(userId) {
    return this.addDeepPressureLayers(userId, 1);
  }

  getCleansableNightmareAfflictions(userId) {
    const status = this.getNightmareStatus(userId);
    const brideMarked = status.brideNightmareMultiplier > 1;
    return {
      curseLayers: status.curse.actualLayers,
      brideMarked,
      brideNightmareMultiplier: status.brideNightmareMultiplier,
      ghostDebt: status.ghostDebt,
      deepPressureLayers: status.deepPressureLayers,
      total: Number(status.curse.actualLayers > 0) +
        Number(brideMarked) +
        Number(status.ghostDebt > 0) +
        Number(status.deepPressureLayers > 0),
    };
  }

  getNightmareCurseLayers(userId) {
    const userData = this.getUserData(userId);
    return Math.max(0, Math.floor(Number(userData.nightmare_curse_layers) || 0));
  }

  addNightmareCurseLayers(userId, layers) {
    userId = String(userId);
    const safeLayers = Math.max(0, Math.floor(Number(layers) || 0));
    this._ensureUser(userId);
    if (safeLayers <= 0) return this.getNightmareCurseLayers(userId);

    const row = db.prepare(`
        UPDATE fishing_stats
        SET nightmare_curse_layers = COALESCE(nightmare_curse_layers, 0) + ?,
            nightmare_curse_prank_revealed = CASE
              WHEN COALESCE(nightmare_curse_layers, 0) <= 0 THEN 0
              ELSE COALESCE(nightmare_curse_prank_revealed, 0)
            END
        WHERE group_id = ? AND user_id = ?
        RETURNING nightmare_curse_layers, nightmare_curse_prank_revealed
    `).get(safeLayers, this.groupId, userId);
    return Math.max(0, Number(row?.nightmare_curse_layers) || 0);
  }

  consumeNightmareCurseLayer(userId) {
    userId = String(userId);
    this._ensureUser(userId);
    const row = db.prepare(`
        UPDATE fishing_stats
        SET nightmare_curse_layers = COALESCE(nightmare_curse_layers, 0) - 1,
            nightmare_curse_prank_revealed = CASE
              WHEN COALESCE(nightmare_curse_layers, 0) - 1 <= 0 THEN 0
              WHEN COALESCE(nightmare_curse_prank_revealed, 0) > 0 THEN 1
              WHEN COALESCE(nightmare_curse_layers, 0) - 1 <= ? THEN 1
              ELSE 0
            END
        WHERE group_id = ? AND user_id = ? AND COALESCE(nightmare_curse_layers, 0) > 0
        RETURNING nightmare_curse_layers, nightmare_curse_prank_revealed
    `).get(NIGHTMARE_CURSE_HIDDEN_LAYERS, this.groupId, userId);
    return {
      consumed: Boolean(row),
      remaining: Math.max(0, Number(row?.nightmare_curse_layers) || 0),
      prankRevealed: Boolean(row?.nightmare_curse_prank_revealed),
    };
  }

  getNightmareCurseStatus(userId) {
    const userData = this.getUserData(userId);
    return getNightmareCurseDisplay(
      userData.nightmare_curse_layers,
      userData.nightmare_curse_prank_revealed,
    );
  }

  // 净化圣水清除所有仍会影响后续垂钓的噩梦减益；鱼竿控制力损失属于鱼竿状态，另由工具箱修复。
  clearNightmareDebuffs(userId) {
    userId = String(userId);
    this._ensureUser(userId);
    const transaction = db.transaction(() => {
      const status = this.getCleansableNightmareAfflictions(userId);
      if (status.total <= 0) return { cleared: 0, ...status };
      db.prepare(`
          UPDATE fishing_stats
          SET nightmare_curse_layers = 0,
              nightmare_curse_prank_revealed = 0,
              bride_nightmare_multiplier = 1,
              ghost_debt = 0,
              deep_pressure_layers = 0
          WHERE group_id = ? AND user_id = ?
      `).run(this.groupId, userId);
      return { cleared: status.total, ...status };
    });
    return transaction.immediate();
  }

  getRodControl(userId, rodId) {
    const rodConfig = this.getRodConfig(rodId);
    if (!rodConfig) return 0;
    const baseControl = Math.max(0, Number(rodConfig.control) || 0);
    return Math.max(0, baseControl - this.getRodStats(userId, rodId).controlLoss);
  }

  getRodStats(userId, rodId) {
    userId = String(userId);
    const row = db.prepare(`
        SELECT damage, mastery, control_loss
        FROM rod_stats
        WHERE group_id = ? AND user_id = ? AND rod_id = ?
    `)
      .get(this.groupId, userId, rodId);
    return {
      damage: Math.max(0, Number(row?.damage) || 0),
      mastery: Math.max(0, Number(row?.mastery) || 0),
      controlLoss: Math.max(0, Number(row?.control_loss) || 0),
    };
  }

  reduceRodControl(userId, rodId, amount) {
    userId = String(userId);
    const safeAmount = Math.max(0, Math.floor(Number(amount) || 0));
    const rodConfig = this.getRodConfig(rodId);
    const baseControl = Math.max(0, Number(rodConfig?.control) || 0);
    const currentControl = rodConfig ? this.getRodControl(userId, rodId) : 0;
    if (!rodConfig || safeAmount <= 0 || currentControl <= 0) {
      return { applied: false, lost: 0, currentControl, baseControl };
    }

    const transaction = db.transaction(() => {
      const owned = db.prepare(`
          SELECT 1 FROM inventory
          WHERE group_id = ? AND user_id = ? AND item_id = ? AND count > 0
      `).get(this.groupId, userId, rodId);
      if (!owned) return { applied: false, lost: 0, currentControl: 0, baseControl };

      const before = this.getRodControl(userId, rodId);
      const lost = Math.min(before, safeAmount);
      if (lost <= 0) return { applied: false, lost: 0, currentControl: before, baseControl };
      db.prepare(`
          INSERT INTO rod_stats (group_id, user_id, rod_id, damage, mastery, control_loss)
          VALUES (?, ?, ?, 0, 0, ?)
          ON CONFLICT(group_id, user_id, rod_id)
          DO UPDATE SET control_loss = control_loss + ?
      `).run(this.groupId, userId, rodId, lost, lost);
      return {
        applied: true,
        lost,
        currentControl: Math.max(0, before - lost),
        baseControl,
      };
    });
    return transaction.immediate();
  }

  getRodDurabilityInfo(userId, rodId) {
    const rodConfig = this.getRodConfig(rodId);
    if (!rodConfig) return { damage: 0, currentDurability: 0, maxDurability: 0 };

    const damage = this.getRodStats(userId, rodId).damage || 0;
    // 兼容尚未配置 durability 的自定义鱼竿，默认沿用旧版 control 数值。
    const configuredDurability = Number(rodConfig.durability);
    const maxDurability = Number.isFinite(configuredDurability) && configuredDurability > 0
      ? configuredDurability
      : Math.max(0, Number(rodConfig.control) || 0);

    return {
      damage,
      currentDurability: Math.max(0, maxDurability - damage),
      maxDurability,
    };
  }

  damageRod(userId, rodId, damage) {
    userId = String(userId);
    const safeDamage = Number(damage);
    const rodConfig = this.getRodConfig(rodId);
    const durabilityInfo = rodConfig
      ? this.getRodDurabilityInfo(userId, rodId)
      : { currentDurability: 0, maxDurability: 0 };
    if (!rodConfig || !Number.isFinite(safeDamage) || safeDamage <= 0) {
      return {
        applied: false,
        isBroken: false,
        currentDurability: durabilityInfo.currentDurability,
        maxDurability: durabilityInfo.maxDurability,
      };
    }

    const transaction = db.transaction(() => {
      const owned = db.prepare(`
          SELECT count FROM inventory
          WHERE group_id = ? AND user_id = ? AND item_id = ? AND count > 0
      `).get(this.groupId, userId, rodId);
      if (!owned) {
        return {
          applied: false,
          isBroken: false,
          currentDurability: 0,
          maxDurability: durabilityInfo.maxDurability,
        };
      }

      const currentDurability = this.getRodDurabilityInfo(userId, rodId).currentDurability;
      const nextDurability = Math.max(0, currentDurability - safeDamage);
      if (nextDurability <= 0) {
        db.prepare(`
            DELETE FROM inventory
            WHERE group_id = ? AND user_id = ? AND item_id = ? AND count > 0
        `).run(this.groupId, userId, rodId);
        db.prepare(`
            DELETE FROM rod_stats
            WHERE group_id = ? AND user_id = ? AND rod_id = ?
        `).run(this.groupId, userId, rodId);
        db.prepare(`
            UPDATE fishing_stats
            SET rod = CASE WHEN rod = ? THEN NULL ELSE rod END
            WHERE group_id = ? AND user_id = ?
        `).run(rodId, this.groupId, userId);
        return {
          applied: true,
          isBroken: true,
          currentDurability: 0,
          maxDurability: durabilityInfo.maxDurability,
        };
      }

      db.prepare(`
          INSERT INTO rod_stats (group_id, user_id, rod_id, damage, mastery)
          VALUES (?, ?, ?, ?, 0)
          ON CONFLICT(group_id, user_id, rod_id)
          DO UPDATE SET damage = damage + ?
      `).run(this.groupId, userId, rodId, safeDamage, safeDamage);
      return {
        applied: true,
        isBroken: false,
        currentDurability: nextDurability,
        maxDurability: durabilityInfo.maxDurability,
      };
    });

    return transaction.immediate();
  }

  breakRod(userId, rodId) {
    userId = String(userId);
    const transaction = db.transaction(() => {
      const removed = db.prepare(`
          DELETE FROM inventory
          WHERE group_id = ? AND user_id = ? AND item_id = ? AND count > 0
      `).run(this.groupId, userId, rodId);
      if (removed.changes !== 1) return false;

      db.prepare(`
          DELETE FROM rod_stats
          WHERE group_id = ? AND user_id = ? AND rod_id = ?
      `).run(this.groupId, userId, rodId);
      db.prepare(`
          UPDATE fishing_stats
          SET rod = CASE WHEN rod = ? THEN NULL ELSE rod END
          WHERE group_id = ? AND user_id = ?
      `).run(rodId, this.groupId, userId);
      return true;
    });
    return transaction.immediate();
  }

  // 骸骨鲨只施加暗伤；本次暗伤耗尽剩余控制力时直接断竿。
  applyRodControlLoss(userId, rodId, controlLoss) {
    const safeControlLoss = Math.max(0, Math.floor(Number(controlLoss) || 0));
    const controlResult = this.reduceRodControl(userId, rodId, safeControlLoss);
    const controlBroken = safeControlLoss > 0 &&
      controlResult.currentControl <= 0 &&
      this.breakRod(userId, rodId);
    return {
      controlResult,
      isBroken: Boolean(controlBroken),
    };
  }

  clearRodDamage(userId, rodId) {
    userId = String(userId);
    db.prepare(`
        UPDATE rod_stats
        SET damage = 0
        WHERE group_id = ? AND user_id = ? AND rod_id = ?
    `).run(this.groupId, userId, rodId);
  }

  repairRod(userId, rodId) {
    userId = String(userId);
    const before = this.getRodStats(userId, rodId);
    db.prepare(`
        UPDATE rod_stats
        SET damage = 0, control_loss = 0
        WHERE group_id = ? AND user_id = ? AND rod_id = ?
    `).run(this.groupId, userId, rodId);
    return {
      durabilityRepaired: before.damage,
      controlRestored: before.controlLoss,
    };
  }

  getRodMastery(userId, rodId) {
    return this.getRodStats(userId, rodId).mastery || 0;
  }

  increaseRodMastery(userId, rodId) {
    userId = String(userId);
    db.prepare(`
        INSERT INTO rod_stats (group_id, user_id, rod_id, damage, mastery)
        VALUES (?, ?, ?, 0, 1)
        ON CONFLICT(group_id, user_id, rod_id)
        DO UPDATE SET mastery = mastery + 1
    `).run(this.groupId, userId, rodId);
  }

  clearRodMastery(userId, rodId) {
    userId = String(userId);
    db.prepare(`
        UPDATE rod_stats
        SET mastery = 0
        WHERE group_id = ? AND user_id = ? AND rod_id = ?
    `).run(this.groupId, userId, rodId);
  }

  getAllRods() {
    const shopConfig = Setting.getEconomy('shop');
    return shopConfig?.categories?.rods?.items || [];
  }

  getAllLines() {
    const shopConfig = Setting.getEconomy('shop');
    return shopConfig?.categories?.lines?.items || [];
  }

  getAllBaits() {
    const shopConfig = Setting.getEconomy('shop');
    return shopConfig?.categories?.baits?.items || [];
  }

  getRodConfig(rodId) {
    return this.getAllRods().find(r => r.id === rodId);
  }

  getLineConfig(lineId) {
    return this.getAllLines().find(l => l.id === lineId);
  }

  getBaitConfig(baitId) {
    return this.getAllBaits().find(b => b.id === baitId);
  }

  recordTorpedoHit(userId) {
    userId = String(userId);
    this._ensureUser(userId);
    db.prepare('UPDATE fishing_stats SET torpedo_hits = torpedo_hits + 1 WHERE group_id = ? AND user_id = ?')
      .run(this.groupId, userId);
  }

  hasRod(userId, rodId) {
    const inventoryManager = new InventoryManager(this.groupId, userId);
    return inventoryManager.getItemCount(rodId) > 0;
  }

  hasAnyRod(userId) {
    const allRods = this.getAllRods();
    const inventoryManager = new InventoryManager(this.groupId, userId);
    const inventory = inventoryManager.getInventory();
    return allRods.some(rod => inventory[rod.id]);
  }

  hasLine(userId, lineId) {
    const inventoryManager = new InventoryManager(this.groupId, userId);
    return inventoryManager.getItemCount(lineId) > 0;
  }

  hasAnyLine(userId) {
    const allLines = this.getAllLines();
    const inventoryManager = new InventoryManager(this.groupId, userId);
    const inventory = inventoryManager.getInventory();
    return allLines.some(line => inventory[line.id]);
  }

  equipRod(userId, rodId) {
    userId = String(userId);
    if (this.hasRod(userId, rodId)) {
      this._ensureUser(userId);
      db.prepare('UPDATE fishing_stats SET rod = ? WHERE group_id = ? AND user_id = ?')
        .run(rodId, this.groupId, userId);
      return true;
    }
    return false;
  }

  getEquippedRod(userId) {
    const userData = this.getUserData(userId);
    if (userData.rod && !this.hasRod(userId, userData.rod)) {
      this.clearEquippedRod(userId, userData.rod);
      return null;
    }
    return userData.rod;
  }

  clearEquippedRod(userId, rodId = null) {
    userId = String(userId);
    this._ensureUser(userId);
    const userData = this.getUserData(userId);
    const targetRodId = rodId || userData.rod;

    if (targetRodId) {
      db.transaction(() => {
        // Also clear rod damage and mastery when clearing equipped rod??
        // The original logic did:
        // if (rodId || userData.rod === rodId) { userData.rod = null; }
        // delete userData.rodDamage[targetRodId];
        // delete userData.rodMastery[targetRodId];

        // Wait, clearing the rod stats when unequipped? That sounds harsh.
        // Oh, the method name is clearEquippedRod, but it acted like "Destroy Rod".
        // If the intention is to unequip, it should just set rod = null.
        // But if the rod is broken or lost, then yes.
        // Let's assume this is used when rod breaks or is removed.
        // But the method name is ambiguous.
        // In ShopManager, it calls equipRod.
        // Let's look at fishing.js usage.
        // Usually used when rod breaks.

        db.prepare('DELETE FROM rod_stats WHERE group_id = ? AND user_id = ? AND rod_id = ?')
          .run(this.groupId, userId, targetRodId);

        if (!rodId || userData.rod === targetRodId) {
          db.prepare('UPDATE fishing_stats SET rod = NULL WHERE group_id = ? AND user_id = ?')
            .run(this.groupId, userId);
        }
      })();
    }
  }

  equipLine(userId, lineId) {
    userId = String(userId);
    if (this.hasLine(userId, lineId)) {
      this._ensureUser(userId);
      db.prepare('UPDATE fishing_stats SET line = ? WHERE group_id = ? AND user_id = ?')
        .run(lineId, this.groupId, userId);
      return true;
    }
    return false;
  }

  getEquippedLine(userId) {
    const userData = this.getUserData(userId);
    if (userData.line && !this.hasLine(userId, userData.line)) {
      this.clearEquippedLine(userId);
      return null;
    }
    return userData.line;
  }

  clearEquippedLine(userId) {
    userId = String(userId);
    this._ensureUser(userId);
    db.prepare('UPDATE fishing_stats SET line = NULL WHERE group_id = ? AND user_id = ?')
      .run(this.groupId, userId);
  }

  breakLine(userId, lineId) {
    userId = String(userId);
    const transaction = db.transaction(() => {
      const removed = db.prepare(`
          DELETE FROM inventory
          WHERE group_id = ? AND user_id = ? AND item_id = ? AND count > 0
      `).run(this.groupId, userId, lineId);
      if (removed.changes !== 1) return false;
      db.prepare(`
          UPDATE fishing_stats
          SET line = CASE WHEN line = ? THEN NULL ELSE line END
          WHERE group_id = ? AND user_id = ?
      `).run(lineId, this.groupId, userId);
      return true;
    });
    return transaction();
  }

  getUserBaits(userId) {
    const inventoryManager = new InventoryManager(this.groupId, userId);
    return inventoryManager.getInventory();
  }

  getBaitCount(userId, baitId) {
    const inventoryManager = new InventoryManager(this.groupId, userId);
    return inventoryManager.getItemCount(baitId);
  }

  equipBait(userId, baitId) {
    userId = String(userId);
    if (this.getBaitCount(userId, baitId) > 0) {
      this._ensureUser(userId);
      db.prepare('UPDATE fishing_stats SET bait = ? WHERE group_id = ? AND user_id = ?')
        .run(baitId, this.groupId, userId);
      return true;
    }
    return false;
  }

  getEquippedBait(userId) {
    userId = String(userId);
    const userData = this.getUserData(userId);
    if (!userData.bait) return null;

    if (this.getBaitCount(userId, userData.bait) > 0) {
      return userData.bait;
    }

    this._ensureUser(userId);
    db.prepare('UPDATE fishing_stats SET bait = NULL WHERE group_id = ? AND user_id = ?')
      .run(this.groupId, userId);
    return null;
  }

  consumeBait(userId) {
    userId = String(userId);
    this._ensureUser(userId);
    const transaction = db.transaction(() => {
      const baitId = db.prepare(`
          SELECT bait FROM fishing_stats
          WHERE group_id = ? AND user_id = ?
      `).get(this.groupId, userId)?.bait;
      if (!baitId) return false;

      const removed = db.prepare(`
          UPDATE inventory
          SET count = count - 1
          WHERE group_id = ? AND user_id = ? AND item_id = ? AND count >= 1
      `).run(this.groupId, userId, baitId);
      if (removed.changes !== 1) return false;

      db.prepare(`
          DELETE FROM inventory
          WHERE group_id = ? AND user_id = ? AND item_id = ? AND count <= 0
      `).run(this.groupId, userId, baitId);

      const remaining = db.prepare(`
          SELECT count FROM inventory
          WHERE group_id = ? AND user_id = ? AND item_id = ?
      `).get(this.groupId, userId, baitId)?.count || 0;
      if (remaining <= 0) {
        const inventory = new InventoryManager(this.groupId, userId).getInventory();
        const availableBaits = this.getAllBaits()
          .filter((bait) => inventory[bait.id] > 0);
        const nextBait = availableBaits
          .filter((bait) => !bait.boss_bait)
          .sort((a, b) => (a.price || 0) - (b.price || 0))[0]?.id || null;
        db.prepare(`
            UPDATE fishing_stats SET bait = ?
            WHERE group_id = ? AND user_id = ?
        `).run(nextBait || availableBaits[0]?.id || null, this.groupId, userId);
      }
      return true;
    });
    return transaction.immediate();
  }

  stealHighestValueBait(userId) {
    userId = String(userId);
    this._ensureUser(userId);
    const transaction = db.transaction(() => {
      const inventory = new InventoryManager(this.groupId, userId).getInventory();
      const bait = this.getAllBaits()
        .filter((candidate) => inventory[candidate.id] > 0)
        .sort((left, right) => (
          (Number(right.price) || 0) - (Number(left.price) || 0)
        ))[0];
      if (!bait) return { stolen: false, bait: null, remaining: 0 };

      const removed = db.prepare(`
          UPDATE inventory
          SET count = count - 1
          WHERE group_id = ? AND user_id = ? AND item_id = ? AND count >= 1
      `).run(this.groupId, userId, bait.id);
      if (removed.changes !== 1) return { stolen: false, bait: null, remaining: 0 };

      db.prepare(`
          DELETE FROM inventory
          WHERE group_id = ? AND user_id = ? AND item_id = ? AND count <= 0
      `).run(this.groupId, userId, bait.id);
      const remaining = db.prepare(`
          SELECT count FROM inventory
          WHERE group_id = ? AND user_id = ? AND item_id = ?
      `).get(this.groupId, userId, bait.id)?.count || 0;

      const equippedBait = db.prepare(`
          SELECT bait FROM fishing_stats WHERE group_id = ? AND user_id = ?
      `).get(this.groupId, userId)?.bait;
      if (equippedBait === bait.id && remaining <= 0) {
        const remainingInventory = new InventoryManager(this.groupId, userId).getInventory();
        const availableBaits = this.getAllBaits()
          .filter((candidate) => remainingInventory[candidate.id] > 0);
        const nextBait = availableBaits
          .filter((candidate) => !candidate.boss_bait)
          .sort((a, b) => (a.price || 0) - (b.price || 0))[0]?.id || null;
        db.prepare(`
            UPDATE fishing_stats SET bait = ?
            WHERE group_id = ? AND user_id = ?
        `).run(nextBait || availableBaits[0]?.id || null, this.groupId, userId);
      }
      return { stolen: true, bait, remaining };
    });
    return transaction.immediate();
  }

  devourRandomInventoryItem(userId, excludedItemIds = [], random = Math.random) {
    userId = String(userId);
    const excluded = new Set((excludedItemIds || []).map(String));
    const inventoryManager = new InventoryManager(this.groupId, userId);
    const candidates = Object.entries(inventoryManager.getInventory())
      .filter(([itemId, count]) => !excluded.has(String(itemId)) && Number(count) > 0)
      .map(([itemId, count]) => ({ itemId, count: Math.max(1, Math.floor(Number(count) || 1)) }));
    if (candidates.length === 0) return null;

    const totalCount = candidates.reduce((sum, candidate) => sum + candidate.count, 0);
    let roll = Math.max(0, Math.min(0.999999999999, Number(random()) || 0)) * totalCount;
    let selected = candidates.at(-1);
    for (const candidate of candidates) {
      roll -= candidate.count;
      if (roll < 0) {
        selected = candidate;
        break;
      }
    }
    if (!inventoryManager.removeItem(selected.itemId, 1)) return null;

    const remaining = inventoryManager.getItemCount(selected.itemId);
    if (String(selected.itemId).startsWith("bait_") && remaining <= 0) {
      this.getEquippedBait(userId);
    }
    return { itemId: selected.itemId, remaining };
  }

  recordCatch(userId, earnings, fishId, isSuccess = true) {
    userId = String(userId);
    this._ensureUser(userId);

    db.transaction(() => {
      const successIncrement = isSuccess ? 1 : 0;
      db.prepare(`
            UPDATE fishing_stats 
            SET total_attempts = total_attempts + 1,
                total_catch = total_catch + ?,
                total_earnings = total_earnings + ?
            WHERE group_id = ? AND user_id = ?
        `).run(successIncrement, earnings, this.groupId, userId);

      if (fishId) {
        db.prepare(`
                INSERT INTO fishing_counts (group_id, user_id, fish_id, count, success_count)
                VALUES (?, ?, ?, 1, ?)
                ON CONFLICT(group_id, user_id, fish_id)
                DO UPDATE SET count = count + 1, success_count = success_count + ?
            `).run(this.groupId, userId, fishId, successIncrement, successIncrement);
      }
    })();
  }

  getFishingRanking(limit = 10) {
    const rows = db.prepare(`
        SELECT user_id as userId, total_earnings as totalEarnings, total_catch as totalCatch
        FROM fishing_stats
        WHERE group_id = ? AND (total_earnings > 0 OR total_catch > 0)
        ORDER BY total_earnings DESC
        LIMIT ?
    `).all(this.groupId, limit);
    return rows;
  }

  getUserCatchHistory(userId) {
    userId = String(userId);
    const rows = db.prepare(`
        SELECT fish_id as fishId, count, success_count as successCount, max_weight as maxWeight,
               shiny_count as shinyCount
        FROM fishing_counts
        WHERE group_id = ? AND user_id = ?
        ORDER BY success_count DESC
    `).all(this.groupId, userId);
    return rows;
  }

  getUserRods(userId) {
    const inventoryManager = new InventoryManager(this.groupId, userId);
    const inventory = inventoryManager.getInventory();
    const allRods = this.getAllRods();
    return allRods.filter(r => inventory[r.id]).map(r => r.id);
  }

  getUserLines(userId) {
    const inventoryManager = new InventoryManager(this.groupId, userId);
    const inventory = inventoryManager.getInventory();
    const allLines = this.getAllLines();
    return allLines.filter(l => inventory[l.id]).map(l => l.id);
  }

  getPondTorpedoes(locationId = null) {
    const normalizedLocation = locationId == null
      ? null
      : normalizeFishingLocation(locationId);
    const rows = normalizedLocation
      ? db.prepare(`
          SELECT user_id, timestamp, location
          FROM pond_torpedoes
          WHERE group_id = ? AND location = ?
        `).all(this.groupId, normalizedLocation)
      : db.prepare(`
          SELECT user_id, timestamp, location
          FROM pond_torpedoes
          WHERE group_id = ?
        `).all(this.groupId);
    const result = {};
    for (const row of rows) {
      result[row.user_id] = {
        timestamp: Number(row.timestamp) || 0,
        location: normalizeFishingLocation(row.location),
      };
    }
    return result;
  }

  getUserTorpedo(userId) {
    userId = String(userId);
    const row = db.prepare(`
        SELECT timestamp, location
        FROM pond_torpedoes
        WHERE group_id = ? AND user_id = ?
    `).get(this.groupId, userId);
    if (!row) return null;
    return {
      timestamp: Number(row.timestamp) || 0,
      location: normalizeFishingLocation(row.location),
    };
  }

  getUserTorpedoCount(userId) {
    return this.getUserTorpedo(userId) ? 1 : 0;
  }

  getTotalTorpedoCount(locationId = null) {
    const row = locationId == null
      ? db.prepare(`
          SELECT COUNT(*) AS count
          FROM pond_torpedoes
          WHERE group_id = ?
        `).get(this.groupId)
      : db.prepare(`
          SELECT COUNT(*) AS count
          FROM pond_torpedoes
          WHERE group_id = ? AND location = ?
        `).get(this.groupId, normalizeFishingLocation(locationId));
    return row ? row.count : 0;
  }

  deployTorpedo(userId, locationId) {
    userId = String(userId);
    const location = normalizeFishingLocation(locationId);
    const transaction = db.transaction(() => {
      const existing = db.prepare(`
          SELECT location FROM pond_torpedoes
          WHERE group_id = ? AND user_id = ?
      `).get(this.groupId, userId);
      if (existing) {
        return {
          success: false,
          reason: "already_deployed",
          location: normalizeFishingLocation(existing.location),
          msg: "你已经投放过一个尚未触发的鱼雷了！",
        };
      }

      const removed = db.prepare(`
          UPDATE inventory
          SET count = count - 1
          WHERE group_id = ? AND user_id = ? AND item_id = 'torpedo' AND count >= 1
      `).run(this.groupId, userId);
      if (removed.changes !== 1) {
        return { success: false, reason: "not_owned", msg: "你的背包里没有鱼雷！" };
      }
      db.prepare(`
          DELETE FROM inventory
          WHERE group_id = ? AND user_id = ? AND item_id = 'torpedo' AND count <= 0
      `).run(this.groupId, userId);
      db.prepare(`
          INSERT INTO pond_torpedoes (group_id, user_id, timestamp, location)
          VALUES (?, ?, ?, ?)
      `).run(this.groupId, userId, Date.now(), location);
      return { success: true, location, msg: "鱼雷投放成功！" };
    });

    return transaction.immediate();
  }

  getAvailableTorpedoCount(excludeUserId, locationId) {
    excludeUserId = String(excludeUserId);
    const location = normalizeFishingLocation(locationId);
    const row = db.prepare(`
        SELECT COUNT(*) AS count
        FROM pond_torpedoes
        WHERE group_id = ? AND user_id != ? AND location = ?
    `).get(this.groupId, excludeUserId, location);
    return row ? row.count : 0;
  }

  triggerTorpedo(fisherId, locationId) {
    fisherId = String(fisherId);
    const location = normalizeFishingLocation(locationId);
    const row = db.prepare(`
        DELETE FROM pond_torpedoes
        WHERE rowid = (
          SELECT rowid
          FROM pond_torpedoes
          WHERE group_id = ? AND user_id != ? AND location = ?
          ORDER BY RANDOM()
          LIMIT 1
        )
        RETURNING user_id, location
    `).get(this.groupId, fisherId, location);
    return row?.user_id || null;
  }

  getFishPriceBoostKey(locationId) {
    const location = normalizeFishingLocation(locationId);
    return `sakura:fishing:torpedo_explosion:${this.groupId}:${location}`;
  }

  async setFishPriceBoost(locationId) {
    const key = this.getFishPriceBoostKey(locationId);
    await redis.set(key, String(Date.now()), "EX", FISHING_BENEFIT_DURATION_SECONDS);
  }

  async isFishPriceBoostActive(locationId) {
    const key = this.getFishPriceBoostKey(locationId);
    const value = await redis.get(key);
    return value !== null;
  }

  async getFishPriceMultiplier(locationId) {
    const isActive = await this.isFishPriceBoostActive(locationId);
    return isActive ? TORPEDO_PRICE_BOOST_MULTIPLIER : 1;
  }

  async getFishPriceBoostRemainingMinutes(locationId) {
    const key = this.getFishPriceBoostKey(locationId);
    const ttl = await redis.ttl(key);
    return ttl > 0 ? Math.ceil(ttl / 60) : 0;
  }
}
