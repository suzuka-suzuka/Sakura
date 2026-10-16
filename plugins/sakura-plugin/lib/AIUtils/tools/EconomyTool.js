import { AbstractTool } from "./AbstractTool.js";
import { randomUUID } from "node:crypto";
import EconomyManager from "../../economy/EconomyManager.js";
import EconomyImageGenerator from "../../economy/ImageGenerator.js";
import {
  acquireRedisLock,
  releaseRedisLock,
} from "../../economy/redisAtomic.js";
import {
  AI_TRANSFER_PERSONAL_COOLDOWN_SECONDS,
  getNonMasterAiTransferSuccessRate,
} from "../../economy/rules.js";

export class EconomyTool extends AbstractTool {
  name = "Economy";
  parameters = {
    properties: {
      action: {
        type: "string",
        enum: ["transfer", "balance", "fine"],
        description: "操作类型：transfer(转账给别人)、balance(查询自己的余额)、fine(罚款，罚款所得转入你自己的账户)",
      },
      targetQQ: {
        type: "string",
        description: "目标用户的QQ号，transfer和fine操作时必填",
      },
      amount: {
        type: "number",
        description: "樱花币数量，transfer 和 fine 操作时需要，填写正整数",
      },
    },
    required: ["action"],
  };
  description =
    "经济系统工具。樱花币是群内虚拟货币，没有实际价值。可以查询自己的余额、给别人转账、或对违规用户罚款。";

  func = async function (opts, e) {
    const { action, targetQQ, amount } = opts;

    try {
      const economyManager = new EconomyManager(e);
      const botE = {
        user_id: e.self_id,
        group_id: e.group_id,
      };

      if (action === "balance") {
        const botCoins = economyManager.getCoins(botE);
        return `你当前有 ${botCoins} 樱花币。`;
      }

      if (action === "fine") {
        if (!targetQQ || !/^\d{5,11}$/.test(targetQQ)) {
          return `参数错误：请提供正确的QQ号。`;
        }
        if (targetQQ === String(e.self_id)) {
          return `不能罚款自己。`;
        }

        const isSelfFine = targetQQ === String(e.user_id);
        if (!e.isMaster && !isSelfFine) {
          return `权限不足：(${e.user_id})没有权限让你罚款其他人。`;
        }

        const requestedFineAmount = Number(amount);
        if (!Number.isSafeInteger(requestedFineAmount) || requestedFineAmount <= 0) {
          return `参数错误：罚款金额必须是大于0的正整数。`;
        }

        const targetE = { user_id: targetQQ, group_id: e.group_id };
        const targetCoins = economyManager.getCoins(targetE);
        const fineAmount = Math.min(requestedFineAmount, targetCoins);

        if (fineAmount <= 0) {
          return `罚款失败：对方已经一穷二白了，没钱可扣。`;
        }

        const fineSuccess = economyManager.transferCoins(targetE, botE, fineAmount);
        if (!fineSuccess) {
          return `罚款失败：对方余额发生变化，请稍后再试。`;
        }

        let targetNickname = targetQQ;
        try {
          const info = await e.getInfo(targetQQ);
          if (info) {
            targetNickname = info.card || info.nickname || targetQQ;
          }
        } catch (err) {}

        return `罚款成功！已扣除 ${targetNickname}(${targetQQ}) ${fineAmount} 樱花币，并转入你自己的账户。`;
      }

      if (action === "transfer") {
        if (!targetQQ || !/^\d{5,11}$/.test(targetQQ)) {
          return `参数错误：请提供正确的QQ号。`;
        }

        const transferAmount = Math.floor(Number(amount));
        if (!Number.isSafeInteger(transferAmount) || transferAmount <= 0) {
          return `参数错误：转账金额必须是大于0的正整数。`;
        }

        if (targetQQ === String(e.self_id)) {
          return `无法给自己转账。`;
        }

        const botCoins = economyManager.getCoins(botE);

        // master 特权：无视限额，直接转账最多能转的金额
        if (e.isMaster) {
          const actualAmount = Math.min(transferAmount, botCoins);
          if (actualAmount <= 0) {
            return `转账失败：余额不足。`;
          }

          const transferSuccess = economyManager.transferCoins(
            botE,
            { user_id: targetQQ, group_id: e.group_id },
            actualAmount
          );

          if (!transferSuccess) {
            return `转账失败：余额不足。`;
          }

          const newBotCoins = economyManager.getCoins(botE);
          const targetCoins = economyManager.getCoins({
            user_id: targetQQ,
            group_id: e.group_id,
          });

          let botNickname = "小叶";
          let receiverNickname = targetQQ;
          try {
            const info = await e.getInfo(targetQQ);
            if (info) {
              receiverNickname = info.card || info.nickname || targetQQ;
            }
          } catch (err) {}

          const data = {
            sender: {
              nickname: String(botNickname),
              avatarUrl: `https://q1.qlogo.cn/g?b=qq&nk=${e.self_id}&s=640`,
              coins: newBotCoins,
            },
            receiver: {
              nickname: String(receiverNickname),
              avatarUrl: `https://q1.qlogo.cn/g?b=qq&nk=${targetQQ}&s=640`,
              coins: targetCoins,
            },
            amount: actualAmount,
            totalAmount: actualAmount,
            fee: 0,
          };

          try {
            const generator = new EconomyImageGenerator();
            const image = await generator.generateTransferImage(data);
            await e.reply(segment.image(image));
          } catch (err) {
            console.error(`[EconomyTool] 生成转账图片失败: ${err}`);
          }

          return `转账成功！已向 ${receiverNickname}(${targetQQ}) 转账 ${actualAmount} 樱花币。`;
        }

        const rejectWithFine = async (reason) => {
          const targetE = { user_id: e.user_id, group_id: e.group_id };
          const targetCoins = economyManager.getCoins(targetE);
          const fineAmount = Math.min(50, targetCoins);

          let targetNickname = e.user_id;
          try {
            const info = await e.getInfo(e.user_id);
            if (info) {
              targetNickname = info.card || info.nickname || e.user_id;
            }
          } catch (err) {}

          const failureMessage = `本次索要失败：${reason}。`;
          const replyInstruction = "本次不要重试转账，请根据上述结果按角色性格回复用户。";

          if (fineAmount <= 0) {
            return `${failureMessage}实际罚款 0 樱花币，发起人 ${targetNickname}(${e.user_id}) 余额为 0，未扣款。${replyInstruction}`;
          }

          const fineSuccess = economyManager.transferCoins(targetE, botE, fineAmount);
          if (!fineSuccess) {
            return `${failureMessage}实际罚款 0 樱花币，发起人 ${targetNickname}(${e.user_id}) 的余额在扣款时发生变化，未完成扣款。${replyInstruction}`;
          }

          return `${failureMessage}实际罚款 ${fineAmount} 樱花币，已从发起人 ${targetNickname}(${e.user_id}) 扣除并转入你的账户。${replyInstruction}`;
        };

        // 超额索要直接罚款；个人冷却拦截沿用罚款，对 AI 统一返回赠送判定未通过。
        const successRate = getNonMasterAiTransferSuccessRate(botCoins, transferAmount);
        if (successRate <= 0) {
          return await rejectWithFine(`索要金额（${transferAmount} 樱花币）超过你的当前余额（${botCoins} 樱花币）`);
        }
        if (Math.random() >= successRate) {
          return await rejectWithFine("未通过赠送判定");
        }

        const cooldownKey = `sakura:economy:ai_transfer:cooldown:${e.self_id}:${e.group_id}:${e.user_id}`;
        const cooldownToken = randomUUID();
        const cooldownAcquired = await acquireRedisLock(
          redis,
          cooldownKey,
          cooldownToken,
          AI_TRANSFER_PERSONAL_COOLDOWN_SECONDS,
        );
        if (!cooldownAcquired) {
          return await rejectWithFine("未通过赠送判定");
        }

        let transferSuccess = false;
        try {
          transferSuccess = economyManager.transferCoins(
            botE,
            { user_id: targetQQ, group_id: e.group_id },
            transferAmount,
          );
        } finally {
          if (!transferSuccess) {
            await releaseRedisLock(redis, cooldownKey, cooldownToken);
          }
        }

        if (!transferSuccess) {
          return `转账失败：余额不足。`;
        }

        const newBotCoins = economyManager.getCoins(botE);
        const targetCoins = economyManager.getCoins({
          user_id: targetQQ,
          group_id: e.group_id,
        });

        let botNickname = "小叶";
        let receiverNickname = targetQQ;
        try {
          const info = await e.getInfo(targetQQ);
          if (info) {
            receiverNickname = info.card || info.nickname || targetQQ;
          }
        } catch (err) {}

        const data = {
          sender: {
            nickname: String(botNickname),
            avatarUrl: `https://q1.qlogo.cn/g?b=qq&nk=${e.self_id}&s=640`,
            coins: newBotCoins,
          },
          receiver: {
            nickname: String(receiverNickname),
            avatarUrl: `https://q1.qlogo.cn/g?b=qq&nk=${targetQQ}&s=640`,
            coins: targetCoins,
          },
          amount: transferAmount,
          totalAmount: transferAmount,
          fee: 0,
        };

        try {
          const generator = new EconomyImageGenerator();
          const image = await generator.generateTransferImage(data);
          await e.reply(segment.image(image));
        } catch (err) {
          console.error(`[EconomyTool] 生成转账图片失败: ${err}`);
        }

        return `转账成功！已向 ${receiverNickname}(${targetQQ}) 转账 ${transferAmount} 樱花币。`;
      }

      return `未知操作：${action}`;
    } catch (error) {
      console.error(`[EconomyTool] 操作时发生错误: ${error.message}`);
      return `操作失败：发生内部错误 - ${error.message}`;
    }
  };
}
