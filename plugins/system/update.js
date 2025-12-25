import { createRequire } from "module";
import _ from "lodash";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const { exec, execSync } = require("child_process");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR = path.join(__dirname, "../../plugins");

let uping = false;

export class GlobalUpdate extends plugin {
  constructor() {
    super({
      name: "全局更新",
      dsc: "全局更新管理插件",
      event: "message",
      priority: -Infinity,
      permission: "master",
    });
  }

  update = Command(/^#(强制)?(全局)?更新$/, async (e) => {
    if (uping) {
      await e.reply("已有命令更新中..请勿重复操作");
      return;
    }

    if (!(await this.checkGit(e))) return;

    const isForce = e.msg.includes("强制");
    const isGlobal = e.msg.includes("全局");

    if (isGlobal) {
      await this.runGlobalUpdate(isForce, e);
    } else {
      await this.updateRepository(".", "Sakura", isForce, e);
    }

    if (this.isUp) {
      setTimeout(() => this.restart(e), 2000);
    }
  });

  async runGlobalUpdate(isForce, e) {
    await e.reply("开始更新 Sakura 和所有插件...");

    const gitRepos = await this.scanGitRepos();

    const allRepos = [{ name: "Sakura", path: "." }, ...gitRepos];

    await e.reply(`发现 ${allRepos.length} 个 Git 仓库，开始更新...`);

    let successCount = 0;
    let failCount = 0;
    let skipCount = 0;
    const results = [];
    const detailedLogs = [];

    for (const repo of allRepos) {
      const result = await this.updateRepository(
        repo.path,
        repo.name,
        isForce,
        e,
        true
      );

      if (result.success) {
        successCount++;
        if (result.updated) {
          results.push(`✓ ${repo.name}: 更新成功`);
          if (result.logInfo) {
            detailedLogs.push(result.logInfo);
          }
        } else {
          results.push(`- ${repo.name}: 已是最新`);
          skipCount++;
        }
      } else {
        failCount++;
        results.push(`✗ ${repo.name}: ${result.error}`);
      }
    }

    const summary = [
      `=== 全局更新完成 ===`,
      `总计: ${gitRepos.length} 个仓库`,
      `成功: ${successCount} 个`,
      `失败: ${failCount} 个`,
      `跳过: ${skipCount} 个`,
      ``,
      `详细信息:`,
      ...results,
    ];

    const messages = [summary.join("\n")];

    for (const logInfo of detailedLogs) {
      const innerNodes = logInfo.msg.map((m) => ({
        type: "node",
        data: {
          user_id: e.bot.self_id,
          nickname: e.bot.nickname,
          content: m,
        },
      }));

      messages.push({
        user_id: e.bot.self_id,
        nickname: e.bot.nickname,
        content: innerNodes,
        news: [{ text: `${logInfo.name} 更新日志` }],
      });
    }

    await e.sendForwardMsg(messages, {
      prompt: "全局更新报告",
      source: "系统更新",
    });
  }

  updatePlugin = Command(/^#(强制)?更新(.+)插件$/, async (e) => {
    if (uping) {
      await e.reply("已有命令更新中..请勿重复操作");
      return;
    }

    if (!(await this.checkGit(e))) return;

    const isForce = e.msg.includes("强制");
    const pluginName = e.msg
      .replace(/#/g, "")
      .replace(/强制/g, "")
      .replace(/更新/g, "")
      .replace(/插件/g, "")
      .trim();

    const pluginPath = path.join(PLUGINS_DIR, pluginName);

    if (!fs.existsSync(pluginPath)) {
      await e.reply(`插件 ${pluginName} 不存在`);
      return;
    }

    if (!fs.existsSync(path.join(pluginPath, ".git"))) {
      await e.reply(`插件 ${pluginName} 不是 Git 仓库`);
      return;
    }

    await this.updateRepository(
      `./plugins/${pluginName}`,
      pluginName,
      isForce,
      e
    );

    if (this.isUp) {
      setTimeout(() => this.restart(e), 2000);
    }
  });

  listPlugins = Command(/^#插件列表$/, async (e) => {
    const gitRepos = await this.scanGitRepos();

    if (gitRepos.length === 0) {
      await e.reply("未发现任何 Git 仓库");
      return;
    }

    const list = ["=== 可更新的插件列表 ===", ""];

    for (const repo of gitRepos) {
      const time = await this.getTime(repo.path);
      const branch = await this.getCurrentBranch(repo.path);
      list.push(`[${repo.name}]`);
      list.push(`  分支: ${branch}`);
      list.push(`  最后更新: ${time}`);
      list.push("");
    }

    await e.sendForwardMsg(
      [
        list.join("\n"),
        "使用 #更新[插件名]插件 来更新指定插件\n使用 #全局更新 来更新所有插件",
      ],
      {
        prompt: `共 ${gitRepos.length} 个插件`,
        summary: "查看插件列表",
        source: "插件管理",
      }
    );
  });

  async scanGitRepos() {
    const repos = [];

    try {
      const items = fs.readdirSync(PLUGINS_DIR);

      for (const item of items) {
        const itemPath = path.join(PLUGINS_DIR, item);
        const gitPath = path.join(itemPath, ".git");

        if (fs.existsSync(gitPath) && fs.statSync(itemPath).isDirectory()) {
          repos.push({
            name: item,
            path: `./plugins/${item}`,
            fullPath: itemPath,
          });
        }
      }
    } catch (error) {
      logger.error("扫描插件目录失败:", error);
    }

    return repos;
  }

  async updateRepository(repoPath, repoName, isForce, e, silent = false) {
    let command;
    const result = {
      success: false,
      updated: false,
      error: null,
    };

    try {
      const branch = await this.getCurrentBranch(repoPath);

      if (!branch) {
        result.error = "无法获取当前分支";
        if (!silent) await e.reply(`${repoName}: 无法获取当前分支`);
        return result;
      }

      if (!silent) {
        if (isForce) {
          command = `git -C ${repoPath} fetch --all && git -C ${repoPath} reset --hard origin/${branch} && git -C ${repoPath} clean -fd`;
          await e.reply(`正在强制更新 ${repoName}，将丢弃所有本地修改...`);
        } else {
          command = `git -C ${repoPath} pull origin ${branch} --no-rebase`;
          await e.reply(`正在更新 ${repoName}...`);
        }
      } else {
        if (isForce) {
          command = `git -C ${repoPath} fetch --all && git -C ${repoPath} reset --hard origin/${branch} && git -C ${repoPath} clean -fd`;
        } else {
          command = `git -C ${repoPath} pull origin ${branch} --no-rebase`;
        }
      }

      this.oldCommitId = await this.getcommitId(repoPath);
      uping = true;
      let ret = await this.execAsync(command);
      uping = false;

      if (ret.error) {
        logger.mark(`更新失败：${repoName}`);
        result.error = "更新失败";
        if (!silent) {
          this.gitErr(ret.error, ret.stdout, e, repoName);
        }
        return result;
      }

      let time = await this.getTime(repoPath);

      if (/(Already up[ -]to[ -]date|已经是最新的)/.test(ret.stdout)) {
        if (!silent) {
          await e.reply(`${repoName} 已经是最新版本\n最后更新时间：${time}`);
        }
        result.success = true;
        result.updated = false;
      } else {
        if (!silent) {
          await e.reply(`${repoName} 更新成功\n最后更新时间：${time}`);
        }
        this.isUp = true;
        result.success = true;
        result.updated = true;

        if (!silent) {
          await this.getLog(repoPath, repoName, e);
        } else {
          result.logInfo = await this.getLog(repoPath, repoName, e, false);
        }
      }

      logger.mark(`${repoName} 最后更新时间：${time}`);
    } catch (error) {
      logger.error(`更新 ${repoName} 时出错:`, error);
      result.error = error.message;
      if (!silent) {
        await e.reply(`更新 ${repoName} 时出错: ${error.message}`);
      }
    }

    return result;
  }

  async getCurrentBranch(repoPath) {
    try {
      const cmd = `git -C ${repoPath} rev-parse --abbrev-ref HEAD`;
      const branch = execSync(cmd, { encoding: "utf-8" });
      return _.trim(branch);
    } catch (error) {
      logger.error(`获取 ${repoPath} 分支失败:`, error);
      return null;
    }
  }

  async getLog(repoPath, repoName, e, sendMsg = true) {
    let cm = `git -C ${repoPath} log -20 --oneline --pretty=format:"%h||[%cd]  %s" --date=format:"%m-%d %H:%M"`;

    let logAll;
    try {
      logAll = await execSync(cm, { encoding: "utf-8" });
    } catch (error) {
      logger.error(error.toString());
      return null;
    }

    if (!logAll) return null;

    logAll = logAll.split("\n");

    let log = [];
    for (let str of logAll) {
      str = str.split("||");
      if (str[0] == this.oldCommitId) break;
      if (str[1].includes("Merge branch")) continue;
      log.push(str[1]);
    }
    let line = log.length;

    if (log.length <= 0) return null;

    const remoteUrl = await this.getRemoteUrl(repoPath);
    let end = "";
    if (remoteUrl) {
      end = `更多详细信息，请前往仓库查看\n${remoteUrl}`;
    }

    if (sendMsg) {
      let logStr = log.join("\n\n");
      await e.sendForwardMsg([logStr, end].filter(Boolean), {
        prompt: `${repoName} 更新日志`,
        summary: `共${line}条`,
        source: "更新日志",
      });
      return null;
    } else {
      return {
        name: repoName,
        msg: [...log, end].filter(Boolean),
      };
    }
  }

  async getRemoteUrl(repoPath) {
    try {
      const cmd = `git -C ${repoPath} config --get remote.origin.url`;
      const url = execSync(cmd, { encoding: "utf-8" });
      return _.trim(url);
    } catch (error) {
      return null;
    }
  }

  async getcommitId(repoPath) {
    const cm = `git -C ${repoPath} rev-parse --short HEAD`;
    try {
      const commitId = execSync(cm, { encoding: "utf-8" });
      return _.trim(commitId);
    } catch (error) {
      logger.error(`获取 ${repoPath} commitId 失败:`, error);
      return "";
    }
  }

  async getTime(repoPath) {
    let cm = `git -C ${repoPath} log -1 --oneline --pretty=format:"%cd" --date=format:"%m-%d %H:%M"`;

    let time = "";
    try {
      time = await execSync(cm, { encoding: "utf-8" });
      time = _.trim(time);
    } catch (error) {
      logger.error(error.toString());
      time = "获取时间失败";
    }
    return time;
  }

  async gitErr(err, stdout, e, repoName) {
    let msg = `${repoName} 更新失败！`;
    let errMsg = err.toString();
    stdout = stdout.toString();

    if (errMsg.includes("Timed out")) {
      let remote =
        errMsg.match(/'(.+?)'/g)?.[0]?.replace(/'/g, "") || "unknown";
      await e.reply(msg + `\n连接超时：${remote}`);
      return;
    }

    if (/Failed to connect|unable to access/g.test(errMsg)) {
      let remote =
        errMsg.match(/'(.+?)'/g)?.[0]?.replace(/'/g, "") || "unknown";
      await e.reply(msg + `\n连接失败：${remote}`);
      return;
    }

    if (errMsg.includes("be overwritten by merge")) {
      await e.reply(
        msg +
          `\n存在冲突：\n${errMsg}\n` +
          "请解决冲突后再更新，或者执行 #强制更新 放弃本地修改"
      );
      return;
    }

    if (stdout.includes("CONFLICT")) {
      await e.reply([
        msg + "\n存在冲突\n",
        errMsg,
        stdout,
        "\n请解决冲突后再更新，或者执行 #强制更新 放弃本地修改",
      ]);
      return;
    }

    await e.reply([msg, errMsg, stdout]);
  }

  async execAsync(cmd) {
    return new Promise((resolve, reject) => {
      exec(cmd, { windowsHide: true }, (error, stdout, stderr) => {
        resolve({ error, stdout, stderr });
      });
    });
  }

  async checkGit(e) {
    try {
      let ret = await execSync("git --version", { encoding: "utf-8" });
      if (!ret || !ret.includes("git version")) {
        await e.reply("请先安装 Git");
        return false;
      }
      return true;
    } catch (error) {
      await e.reply("请先安装 Git");
      return false;
    }
  }

  async restart(e) {
    const restartInfo = {
      source_type: e.group_id ? "group" : "private",
      source_id: e.group_id || e.user_id,
      start_time: Date.now(),
    };
    await redis.set(
      "sakura:restart_info",
      JSON.stringify(restartInfo),
      "EX",
      120
    );

    if (process.send) {
      process.send("hard-restart");
    } else {
      process.exit(0);
    }
  }
}
