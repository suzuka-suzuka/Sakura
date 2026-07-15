import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { exec, execSync } = require("child_process");

const projectName = "Sakura";
const projectRepo = "https://github.com/suzuka-suzuka/Sakura";
const projectBranch = "main";
const projectPath = process.cwd();

let uping = false;

export class Update extends plugin {
  constructor() {
    super({
      name: `更新`,
      event: "message",
      priority: 1135,
    });
  }

  update = Command(
    /^#?(sakura|樱花)(插件)?(强制)?更新$/,
    "master",
    async (e) => {
      if (uping) {
        await e.reply("已有命令更新中..请勿重复操作");
        return;
      }

      if (!(await this.checkGit(e))) return;

      const isForce = e.msg.includes("强制");
      await e.react(124);
      await this.runUpdate(isForce, e);

      if (this.isUp) {
        setTimeout(() => this.restart(e), 2000);
      }
    }
  );

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
      process.send("restart");
    }
    process.exit(0);
  }

  async runUpdate(isForce, e) {
    if (isForce) {
      await e.reply(
        "合并为单仓库后不再支持强制更新，以免覆盖主项目中的本地修改。请手动处理 Git 冲突后再更新。"
      );
      return false;
    }

    const command = `git -C "${projectPath}" pull --ff-only origin ${projectBranch}`;
    this.oldCommitId = await this.getcommitId();
    uping = true;
    const ret = await this.execAsync(command);
    uping = false;

    if (ret.error) {
      logger.mark(`更新失败：${projectName}`);
      this.gitErr(ret.error, ret.stdout, e);
      return false;
    }

    const time = await this.getTime();

    if (/(Already up[ -]to[ -]date|已经是最新的)/.test(ret.stdout)) {
      await e.reply(`${projectName} 已经是最新版本\n最后更新时间：${time}`);
    } else {
      await e.reply(`${projectName} 更新成功\n最后更新时间：${time}`);
      this.isUp = true;
      await this.getLog(e);
    }

    logger.mark(`最后更新时间：${time}`);

    return true;
  }

  async getLog(e) {
    const cm = `git -C "${projectPath}" log -20 --oneline --pretty=format:"%h||[%cd]  %s" --date=format:"%m-%d %H:%M"`;

    let logAll;
    try {
      logAll = await execSync(cm, { encoding: "utf-8" });
    } catch (error) {
      logger.error(error.toString());
      await e.reply(error.toString());
    }

    if (!logAll) return false;

    logAll = logAll.split("\n");

    let log = [];
    for (let str of logAll) {
      str = str.split("||");
      if (str[0] == this.oldCommitId) break;
      if (str[1].includes("Merge branch")) continue;
      log.push(str[1]);
    }
    log = log.join("\n\n");

    if (log.length <= 0) return "";

    const end = `更多详细信息，请前往github查看\n${projectRepo}`;

    await e.sendForwardMsg([log, end].filter(Boolean), {
      prompt: `${projectName}更新日志`,
      source: "更新日志",
    });

    return null;
  }

  async getcommitId() {
    const cm = `git -C "${projectPath}" rev-parse --short HEAD`;
    try {
      const commitId = execSync(cm, { encoding: "utf-8" });
      return commitId.trim();
    } catch (error) {
      logger.error(`获取 ${projectName} commitId 失败:`);
      logger.error(error);
      return "";
    }
  }

  async getTime() {
    const cm = `git -C "${projectPath}" log -1 --oneline --pretty=format:"%cd" --date=format:"%m-%d %H:%M"`;

    let time = "";
    try {
      time = await execSync(cm, { encoding: "utf-8" });
      time = time.trim();
    } catch (error) {
      logger.error(error.toString());
      time = "获取时间失败";
    }
    return time;
  }

  async gitErr(err, stdout, e) {
    let msg = "更新失败！";
    let errMsg = err.toString();
    stdout = stdout.toString();

    if (errMsg.includes("Timed out")) {
      let remote = errMsg.match(/'(.+?)'/g)[0].replace(/'/g, "");
      await e.reply(msg + `\n连接超时：${remote}`);
      return;
    }

    if (/Failed to connect|unable to access/g.test(errMsg)) {
      let remote = errMsg.match(/'(.+?)'/g)[0].replace(/'/g, "");
      await e.reply(msg + `\n连接失败：${remote}`);
      return;
    }

    if (errMsg.includes("be overwritten by merge")) {
      await e.reply(
        msg +
        `存在冲突：\n${errMsg}\n` +
        "请手动提交或还原本地修改后再更新"
      );
      return;
    }

    if (stdout.includes("CONFLICT")) {
      await e.reply([
        msg + "存在冲突\n",
        errMsg,
        stdout,
        "\n请手动解决冲突后再更新",
      ]);
      return;
    }

    await e.reply([errMsg, stdout]);
  }

  async execAsync(cmd) {
    return new Promise((resolve, reject) => {
      exec(cmd, { windowsHide: true }, (error, stdout, stderr) => {
        resolve({ error, stdout, stderr });
      });
    });
  }

  async checkGit(e) {
    let ret = await execSync("git --version", { encoding: "utf-8" });
    if (!ret || !ret.includes("git version")) {
      await e.reply("请先安装git");
      return false;
    }
    return true;
  }
}
