import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '../../config/config.yaml');

let config = {
  whiteGroups: [],
  blackGroups: [],
  blackUsers: [],
  whiteUsers: []
};

export function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      const DEF_CONFIG_PATH = path.join(__dirname, '../../defSet/config.yaml');
      if (fs.existsSync(DEF_CONFIG_PATH)) {
        const configDir = path.dirname(CONFIG_PATH);
        if (!fs.existsSync(configDir)) {
          fs.mkdirSync(configDir, { recursive: true });
        }
        fs.copyFileSync(DEF_CONFIG_PATH, CONFIG_PATH);
        logger.info('[Config] 配置文件不存在，已从默认配置复制');
      }
    }

    if (fs.existsSync(CONFIG_PATH)) {
      const fileContents = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = yaml.load(fileContents);
      
      config = {
        master: parsed.master,
        logLevel: parsed.logLevel || 'info',
        whiteGroups: parsed.whiteGroups || [],
        blackGroups: parsed.blackGroups || [],
        blackUsers: parsed.blackUsers || [],
        whiteUsers: parsed.whiteUsers || [],
        onebot: parsed.onebot || {},
        redis: parsed.redis
      };
      
      logger.level = config.logLevel;
      
      logger.info(`[Config] 配置已加载，日志等级: ${config.logLevel}`);
    } else {
      logger.info('[Config] 配置文件不存在，使用默认配置');
    }
  } catch (e) {
    logger.error(`[Config] 加载配置失败: ${e}`);
  }
}

export function getConfig() {
  return config;
}

fs.watchFile(CONFIG_PATH, () => {
  logger.info('[Config] 检测到配置文件变更，正在重载...');
  loadConfig();
});

loadConfig();
