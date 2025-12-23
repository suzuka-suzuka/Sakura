import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import chokidar from 'chokidar';
import lodash from 'lodash';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '../../config/config.yaml');
const DEF_CONFIG_PATH = path.join(__dirname, '../../defSet/config.yaml');

class Config {
    constructor() {
        this.config = {};
        this.watcher = null;
        this.init();
    }

    init() {
        this.checkFile();
        this.load();
        this.watch();
    }

    checkFile() {
        if (!fs.existsSync(CONFIG_PATH)) {
            if (fs.existsSync(DEF_CONFIG_PATH)) {
                const configDir = path.dirname(CONFIG_PATH);
                if (!fs.existsSync(configDir)) {
                    fs.mkdirSync(configDir, { recursive: true });
                }
                fs.copyFileSync(DEF_CONFIG_PATH, CONFIG_PATH);
                logger.info('[Config] 配置文件不存在，已从默认配置复制');
            } else {
                logger.warn('[Config] 默认配置文件不存在');
            }
        }
    }

    load() {
        try {
            if (fs.existsSync(CONFIG_PATH)) {
                const fileContents = fs.readFileSync(CONFIG_PATH, 'utf8');
                this.config = yaml.load(fileContents) || {};
                
                // Set logger level if present
                if (this.config.logLevel) {
                    logger.level = this.config.logLevel;
                }
                
                logger.info(`[Config] 配置已加载`);
            } else {
                this.config = {};
                logger.info('[Config] 配置文件不存在，使用空配置');
            }
        } catch (e) {
            logger.error(`[Config] 加载配置失败: ${e}`);
        }
    }

    get(key) {
        if (key) {
            return lodash.get(this.config, key);
        }
        return this.config;
    }

    set(key, value) {
        lodash.set(this.config, key, value);
        return this.save();
    }

    save() {
        try {
            fs.writeFileSync(CONFIG_PATH, yaml.dump(this.config), 'utf8');
            return true;
        } catch (e) {
            logger.error(`[Config] 保存配置失败: ${e}`);
            return false;
        }
    }

    watch() {
        if (this.watcher) return;
        this.watcher = chokidar.watch(CONFIG_PATH);
        this.watcher.on('change', () => {
            logger.info('[Config] 检测到配置文件变更，正在重载...');
            this.load();
        });
    }
}

export default new Config();
