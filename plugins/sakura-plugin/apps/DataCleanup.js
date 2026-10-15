import db from '../lib/Database.js';
import { GroupDataCleaner, canDeleteGroupData } from '../lib/GroupDataCleaner.js';
import { getBots } from '../../../src/api/client.js';
import accountConfig from '../../../src/core/accountConfig.js';

const cleaner = new GroupDataCleaner(db, {
  getBots,
  getConfiguredSelfIds: () => accountConfig.listConfiguredSelfIds(),
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
