import db from '../lib/Database.js';
import { GroupDataCleaner, canDeleteGroupData } from '../lib/GroupDataCleaner.js';
import { getBot } from '../../../src/api/client.js';

// 一个实例只有一个号。data_cleanup_accounts 里记着这份数据库见过的所有账号：
// 从多号共用的数据库拆出来时里面还有别的号，它们一直不在线，整群清理就保守地跳过，只清离群成员。
const cleaner = new GroupDataCleaner(db, {
  getBots: () => {
    const currentBot = getBot();
    return currentBot ? [currentBot] : [];
  },
  canDelete: canDeleteGroupData,
  logger,
});

export class DataCleanup extends plugin {
  constructor() {
    super({ name: '失效群数据清理', priority: 100 });
  }

  // 每天凌晨 4 点按当前群和成员列表统一核对，给暂时退群的成员保留返回时间。
  reconcileData = Cron('0 4 * * *', () => cleaner.run());

  recordAccounts = OnEvent('meta_event', () => {
    cleaner.observeBots();
    return false;
  });
}
