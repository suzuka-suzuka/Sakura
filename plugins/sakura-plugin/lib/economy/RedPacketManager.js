import db from "../Database.js";
import EconomyManager from "./EconomyManager.js";
import {
  RED_PACKET_EXPIRE_SECONDS,
  RED_PACKET_MAX_ACTIVE_PER_USER,
  RED_PACKET_MODES,
  splitRedPacket,
  validateRedPacket,
} from "./rules.js";

// 抢红包的领取记录先落库，之后任何一步不成立都必须靠抛错回滚整个事务——
// better-sqlite3 只在异常时回滚，直接 return 会把这条领取记录留在库里。
class ClaimRollback extends Error {
  constructor(reason) {
    super(`red packet claim rollback: ${reason}`);
    this.reason = reason;
  }
}

// 红包＝托管账本：发红包当场把钱从余额扣走存进 red_packets，
// 抢红包按预先切好的份额出账，过期未领完的部分原路退回发红包的人。
// 金额只在「余额 ↔ 红包」之间搬运，任何一条路径都不会凭空生成樱花币。
export default class RedPacketManager {
  constructor(e) {
    this.e = e;
    this.groupId = String(e.group_id);
    this.userId = String(e.user_id);
    this.economyManager = new EconomyManager(e);
  }

  static parseShares(raw) {
    try {
      const shares = JSON.parse(raw);
      if (!Array.isArray(shares)) return null;
      return shares.map((share) => Math.max(0, Math.floor(Number(share) || 0)));
    } catch (err) {
      return null;
    }
  }

  getActiveCount() {
    const row = db.prepare(`
        SELECT COUNT(*) AS count FROM red_packets
        WHERE group_id = ? AND user_id = ? AND status = 'active'
    `).get(this.groupId, this.userId);
    return Number(row?.count) || 0;
  }

  // mint=true 走主人通道：樱花币凭空产生，不动发红包者的余额，过期也不退款。
  send({ amount, count, mode = "lucky", blessing = "", mint = false } = {}) {
    const safeMode = RED_PACKET_MODES[mode] ? mode : "lucky";
    const validation = validateRedPacket(amount, count);
    if (!validation.valid) return { success: false, reason: validation.reason };

    const shares = splitRedPacket(validation.amount, validation.count, safeMode);
    if (!shares || shares.reduce((sum, share) => sum + share, 0) !== validation.amount) {
      return { success: false, reason: "invalid" };
    }

    this.economyManager.ensureUser(this.e);
    const now = Date.now();
    const expiresAt = now + RED_PACKET_EXPIRE_SECONDS * 1000;

    const transaction = db.transaction(() => {
      if (this.getActiveCount() >= RED_PACKET_MAX_ACTIVE_PER_USER) {
        return { success: false, reason: "too_many_active" };
      }

      if (!mint) {
        const deducted = db.prepare(`
            UPDATE economy
            SET coins = coins - ?
            WHERE group_id = ? AND user_id = ? AND coins >= ?
        `).run(validation.amount, this.groupId, this.userId, validation.amount);
        if (deducted.changes !== 1) {
          return { success: false, reason: "insufficient" };
        }
      }

      const inserted = db.prepare(`
          INSERT INTO red_packets
          (group_id, user_id, mode, total_amount, total_count, claimed_count,
           shares, blessing, minted, status, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 'active', ?, ?)
      `).run(
        this.groupId,
        this.userId,
        safeMode,
        validation.amount,
        validation.count,
        JSON.stringify(shares),
        blessing || "",
        mint ? 1 : 0,
        now,
        expiresAt,
      );
      const packetId = Number(inserted.lastInsertRowid);

      // 凭空发放不动余额，所以也不该记一笔支出流水，只在日志里留痕。
      if (mint) {
        logger.info(
          `[红包] ${this.userId} 在群 ${this.groupId} 凭空发放 ` +
          `${validation.amount} 樱花币红包（${validation.count} 个）`,
        );
      } else {
        this.economyManager.recordTransaction(this.e, {
          type: "红包支出",
          amount: -validation.amount,
          note: `发${RED_PACKET_MODES[safeMode]}红包 ${validation.count} 个`,
          relatedId: `red_packet:${packetId}`,
        });
      }

      return {
        success: true,
        packetId,
        mode: safeMode,
        amount: validation.amount,
        count: validation.count,
        minted: Boolean(mint),
        expiresAt,
      };
    });

    return transaction.immediate();
  }

  // 抢最早发出、自己还没抢过、且不是自己发的那一个：
  // 先到先得的队列语义能保证旧红包不会被新红包一直压着领不完。
  claim() {
    this.economyManager.ensureUser(this.e);
    const now = Date.now();

    const transaction = db.transaction(() => {
      const candidates = db.prepare(`
          SELECT * FROM red_packets
          WHERE group_id = ? AND status = 'active'
            AND expires_at > ? AND claimed_count < total_count
          ORDER BY created_at ASC, id ASC
      `).all(this.groupId, now);

      if (candidates.length === 0) {
        return { success: false, reason: "no_packet" };
      }

      const claimedByMe = db.prepare(`
          SELECT packet_id FROM red_packet_claims
          WHERE group_id = ? AND user_id = ?
      `).all(this.groupId, this.userId).map((row) => Number(row.packet_id));
      const claimedSet = new Set(claimedByMe);

      const packet = candidates.find((row) => (
        String(row.user_id) !== this.userId && !claimedSet.has(Number(row.id))
      ));
      if (!packet) {
        const onlyOwn = candidates.every((row) => String(row.user_id) === this.userId);
        return { success: false, reason: onlyOwn ? "only_own" : "already_claimed" };
      }

      const shares = RedPacketManager.parseShares(packet.shares);
      const share = shares?.[packet.claimed_count];
      if (!share || share <= 0) {
        logger.error(`[红包] 红包 ${packet.id} 的份额数据异常: ${packet.shares}`);
        return { success: false, reason: "bad_shares" };
      }

      const claimed = db.prepare(`
          INSERT OR IGNORE INTO red_packet_claims
          (packet_id, group_id, user_id, amount, created_at)
          VALUES (?, ?, ?, ?, ?)
      `).run(packet.id, this.groupId, this.userId, share, now);
      if (claimed.changes !== 1) {
        return { success: false, reason: "already_claimed" };
      }

      // claimed_count 作为乐观锁：并发抢同一个红包时只有一方能推进计数，
      // 另一方回滚重试，不会两个人拿到同一份。
      const updated = db.prepare(`
          UPDATE red_packets
          SET claimed_count = claimed_count + 1,
              status = CASE WHEN claimed_count + 1 >= total_count THEN 'finished' ELSE status END
          WHERE id = ? AND claimed_count = ? AND status = 'active'
      `).run(packet.id, packet.claimed_count);
      if (updated.changes !== 1) {
        throw new ClaimRollback("retry");
      }

      db.prepare(`
          UPDATE economy
          SET coins = coins + ?
          WHERE group_id = ? AND user_id = ?
      `).run(share, this.groupId, this.userId);
      this.economyManager.recordTransaction(this.e, {
        type: "红包收入",
        amount: share,
        targetUserId: packet.user_id,
        note: "抢红包",
        relatedId: `red_packet:${packet.id}`,
      });

      const claimedCount = packet.claimed_count + 1;
      const finished = claimedCount >= packet.total_count;
      return {
        success: true,
        amount: share,
        packetId: Number(packet.id),
        senderId: String(packet.user_id),
        mode: packet.mode,
        blessing: packet.blessing || "",
        totalAmount: Number(packet.total_amount),
        totalCount: Number(packet.total_count),
        claimedCount,
        finished,
        claims: finished ? this.getClaims(packet.id) : [],
      };
    });

    try {
      return transaction.immediate();
    } catch (err) {
      if (err instanceof ClaimRollback) {
        return { success: false, reason: err.reason };
      }
      throw err;
    }
  }

  getClaims(packetId) {
    return db.prepare(`
        SELECT user_id, amount, created_at FROM red_packet_claims
        WHERE packet_id = ?
        ORDER BY created_at ASC, rowid ASC
    `).all(packetId).map((row) => ({
      userId: String(row.user_id),
      amount: Number(row.amount) || 0,
    }));
  }

  static getLuckiest(claims = []) {
    return claims.reduce(
      (best, claim) => (best && best.amount >= claim.amount ? best : claim),
      null,
    );
  }

  // 已结束的红包只留一段时间供追溯，和流水一起按天清理；active 的永远不删。
  static cleanupFinished(retentionDays = 7) {
    const days = Math.max(1, Number(retentionDays) || 7);
    const expireBefore = Date.now() - days * 24 * 60 * 60 * 1000;
    const cleanup = db.transaction(() => {
      db.prepare(`
          DELETE FROM red_packet_claims
          WHERE packet_id IN (
            SELECT id FROM red_packets
            WHERE status != 'active' AND created_at < ?
          )
      `).run(expireBefore);
      return db.prepare(`
          DELETE FROM red_packets
          WHERE status != 'active' AND created_at < ?
      `).run(expireBefore).changes || 0;
    });
    return cleanup();
  }

  // 过期回收：把没被抢走的份额退还给发红包的人，同时把红包置为 expired。
  // 交给定时任务批量执行，抢红包路径只按 expires_at 过滤，两边看到的状态一致。
  static expireOverdue(now = Date.now()) {
    const expired = [];
    const overdue = db.prepare(`
        SELECT * FROM red_packets
        WHERE status = 'active' AND expires_at <= ?
    `).all(now);

    for (const packet of overdue) {
      const transaction = db.transaction(() => {
        const closed = db.prepare(`
            UPDATE red_packets
            SET status = 'expired'
            WHERE id = ? AND status = 'active'
        `).run(packet.id);
        if (closed.changes !== 1) return null;

        const shares = RedPacketManager.parseShares(packet.shares) || [];
        const unclaimed = shares
          .slice(packet.claimed_count)
          .reduce((sum, share) => sum + share, 0);
        if (unclaimed <= 0) return null;

        // 凭空发放的红包本来就没从谁那里扣过钱，剩余份额直接作废。
        const minted = Boolean(packet.minted);
        if (!minted) {
          const senderE = { group_id: packet.group_id, user_id: packet.user_id };
          const economyManager = new EconomyManager(senderE);
          economyManager.ensureUser(senderE);
          db.prepare(`
              UPDATE economy
              SET coins = coins + ?
              WHERE group_id = ? AND user_id = ?
          `).run(unclaimed, packet.group_id, packet.user_id);
          economyManager.recordTransaction(senderE, {
            type: "红包退款",
            amount: unclaimed,
            note: "红包过期退回",
            relatedId: `red_packet:${packet.id}`,
          });
        }

        return {
          packetId: Number(packet.id),
          groupId: String(packet.group_id),
          userId: String(packet.user_id),
          unclaimed,
          refund: minted ? 0 : unclaimed,
          minted,
          claimedCount: Number(packet.claimed_count) || 0,
          totalCount: Number(packet.total_count) || 0,
        };
      });

      try {
        const result = transaction.immediate();
        if (result) expired.push(result);
      } catch (err) {
        logger.error(`[红包] 回收红包 ${packet.id} 失败: ${err.stack || err}`);
      }
    }

    return expired;
  }
}
