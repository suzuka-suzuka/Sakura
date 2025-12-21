import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "../../config/config.yaml");

export class Permission extends plugin {
  constructor() {
    super({
      name: "权限管理",
      event: "message",
      priority: 1135,
    });
  }

  handlePermission = Command(/^(赋权|取消赋权)\s*(.*)$/, "white", async (e) => {
    const isAdd = e.match[1] === "赋权";
    let targetId = e.at;

    if (!targetId) {
      const text = e.match[2].trim();
      if (/^\d+$/.test(text)) {
        targetId = Number(text);
      }
    }

    if (!targetId) {
      return false;
    }

    let config = {};
    try {
      const file = fs.readFileSync(CONFIG_PATH, "utf8");
      config = yaml.load(file);
    } catch (err) {
      logger.error(`读取配置文件失败: ${err}`);
      await e.reply("读取配置文件失败", 10);
      return;
    }

    if (!config.whiteUsers) {
      config.whiteUsers = [];
    }

    config.whiteUsers = config.whiteUsers.map(Number);

    if (isAdd) {
      if (config.whiteUsers.includes(targetId)) {
        await e.reply(`${targetId} 已经在白名单中了`, 10);
        return;
      }
      config.whiteUsers.push(targetId);
      await e.reply(`已将 ${targetId} 添加到白名单`, 10);
    } else {
      if (!config.whiteUsers.includes(targetId)) {
        await e.reply(`${targetId} 不在白名单中`, 10);
        return;
      }
      config.whiteUsers = config.whiteUsers.filter((id) => id !== targetId);
      await e.reply(`已将 ${targetId} 移出白名单`, 10);
    }

    try {
      const yamlStr = yaml.dump(config);
      fs.writeFileSync(CONFIG_PATH, yamlStr, "utf8");
    } catch (err) {
      logger.error(`保存配置文件失败: ${err}`);
      await e.reply("保存配置文件失败", 10);
    }
  });

  handleGroupPermission = Command(/^(拉白|取消拉白)\s*(.*)$/, "master", async (e) => {
    const isAdd = e.match[1] === "拉白";
    let targetGroupId;
    const text = e.match[2].trim();

    if (text && /^\d+$/.test(text)) {
      targetGroupId = Number(text);
    } else if (e.group_id) {
      targetGroupId = e.group_id;
    }

    if (!targetGroupId) {
      await e.reply("请指定群号或在群聊中使用", 10);
      return false;
    }

    let config = {};
    try {
      const file = fs.readFileSync(CONFIG_PATH, "utf8");
      config = yaml.load(file);
    } catch (err) {
      logger.error(`读取配置文件失败: ${err}`);
      await e.reply("读取配置文件失败", 10);
      return;
    }

    if (!config.whiteGroups) {
      config.whiteGroups = [];
    }

    config.whiteGroups = config.whiteGroups.map(Number);

    if (isAdd) {
      if (config.whiteGroups.includes(targetGroupId)) {
        await e.reply(`${targetGroupId} 已经在白名单中了`, 10);
        return;
      }
      config.whiteGroups.push(targetGroupId);
      await e.reply(`已将 ${targetGroupId} 添加到白名单`, 10);
    } else {
      if (!config.whiteGroups.includes(targetGroupId)) {
        await e.reply(`${targetGroupId} 不在白名单中`, 10);
        return;
      }
      config.whiteGroups = config.whiteGroups.filter((id) => id !== targetGroupId);
      await e.reply(`已将 ${targetGroupId} 移出白名单`, 10);
    }

    try {
      const yamlStr = yaml.dump(config);
      fs.writeFileSync(CONFIG_PATH, yamlStr, "utf8");
    } catch (err) {
      logger.error(`保存配置文件失败: ${err}`);
      await e.reply("保存配置文件失败", 10);
    }
  });

  handleBlockUser = Command(/^(拉黑|解黑|取消拉黑)\s*(.*)$/, "master", async (e) => {
    const isAdd = e.match[1] === "拉黑";
    let targetId = e.at;

    if (!targetId) {
      const text = e.match[2].trim();
      if (/^\d+$/.test(text)) {
        targetId = Number(text);
      }
    }

    if (!targetId) {
      await e.reply("请指定要操作的用户QQ", 10);
      return false;
    }

    let config = {};
    try {
      const file = fs.readFileSync(CONFIG_PATH, "utf8");
      config = yaml.load(file);
    } catch (err) {
      logger.error(`读取配置文件失败: ${err}`);
      await e.reply("读取配置文件失败", 10);
      return;
    }

    if (!config.blackUsers) {
      config.blackUsers = [];
    }

    config.blackUsers = config.blackUsers.map(Number);

    if (isAdd) {
      if (config.blackUsers.includes(targetId)) {
        await e.reply(`${targetId} 已经在黑名单中了`, 10);
        return;
      }
      config.blackUsers.push(targetId);
      await e.reply(`已将 ${targetId} 添加到黑名单`, 10);
    } else {
      if (!config.blackUsers.includes(targetId)) {
        await e.reply(`${targetId} 不在黑名单中`, 10);
        return;
      }
      config.blackUsers = config.blackUsers.filter((id) => id !== targetId);
      await e.reply(`已将 ${targetId} 移出黑名单`, 10);
    }

    try {
      const yamlStr = yaml.dump(config);
      fs.writeFileSync(CONFIG_PATH, yamlStr, "utf8");
    } catch (err) {
      logger.error(`保存配置文件失败: ${err}`);
      await e.reply("保存配置文件失败", 10);
    }
  });
}
