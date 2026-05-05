import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import pluginConfigManager from "./pluginConfig.js";
import { logger } from "../utils/logger.js";
import EconomyManager from "../../plugins/sakura-plugin/lib/economy/EconomyManager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let commandNamesCache = null;

async function getCommandNames() {
  if (commandNamesCache) return commandNamesCache;
  try {
    const schemaPath = path.join(__dirname, "../../plugins/sakura-plugin/configSchema.js");
    const schemaUrl = pathToFileURL(schemaPath).href + `?t=${Date.now()}`;
    const schemaMod = await import(schemaUrl);
    commandNamesCache = schemaMod.commandNames || {};
    return commandNamesCache;
  } catch (err) {
    logger.error(`[EconomyHook] 读取指令扣费映射失败: ${err}`);
    return {};
  }
}

function normalizePreflightResult(result) {
  if (result === false || result == null) {
    return { accepted: false };
  }

  if (typeof result === "string") {
    return { accepted: true, command: result };
  }

  if (typeof result === "object") {
    return {
      accepted: result.accepted !== false && result.handled !== false,
      command: result.command || result.chargeCommand,
      charge: result.charge,
      refundOnFalse: result.refundOnFalse,
    };
  }

  return { accepted: true };
}

async function runPreflight(eventObj, instance, handler, commandKey) {
  const preflightRef = handler.economy?.preflight || handler.preflight;
  if (!preflightRef) return { accepted: true };

  try {
    let result;
    if (typeof preflightRef === "string") {
      const preflight = instance[preflightRef];
      if (typeof preflight !== "function") {
        logger.warn(`[EconomyHook] ${commandKey} 指定的 preflight 不存在: ${preflightRef}`);
        return { accepted: true };
      }
      result = await preflight.call(instance, eventObj, { handler, commandKey });
    } else if (typeof preflightRef === "function") {
      result = await preflightRef.call(instance, eventObj, { handler, commandKey });
    } else {
      return { accepted: true };
    }

    return normalizePreflightResult(result);
  } catch (err) {
    logger.error(`[EconomyHook] ${commandKey} preflight 执行出错: ${err}`);
    return { accepted: true };
  }
}

function shouldRefundOnResult(ticket, result) {
  if (!ticket) return false;

  if (result && typeof result === "object" && Object.prototype.hasOwnProperty.call(result, "refund")) {
    return result.refund === true;
  }

  if (result && typeof result === "object" && Object.prototype.hasOwnProperty.call(result, "handled")) {
    return result.handled === false && ticket.refundOnFalse !== false;
  }

  return result === false && ticket.refundOnFalse !== false;
}

export function isHandledResult(result) {
  if (result && typeof result === "object" && Object.prototype.hasOwnProperty.call(result, "handled")) {
    return result.handled !== false;
  }
  return result !== false;
}

export function clearEconomyCommandNamesCache() {
  commandNamesCache = null;
}

export async function beforeExecute(eventObj, instance, handler) {
  const commandKey = `${instance.constructor.name}.${handler.methodName}`;
  const preflight = await runPreflight(eventObj, instance, handler, commandKey);

  if (!preflight.accepted) {
    return { accepted: false, ticket: null };
  }

  try {
    const economyConfig = pluginConfigManager.getConfig("sakura-plugin", "economy");
    if (!economyConfig?.enable || eventObj.isMaster || preflight.charge === false) {
      return { accepted: true, ticket: null };
    }

    const groupId = eventObj.group_id;
    if (!groupId || !economyConfig.Groups?.includes(Number(groupId))) {
      return { accepted: true, ticket: null };
    }

    const commandNames = await getCommandNames();
    const commandDisplayName =
      preflight.command ||
      handler.economy?.command ||
      handler.economy?.chargeCommand ||
      commandNames[commandKey];

    if (!commandDisplayName) {
      return { accepted: true, ticket: null };
    }

    const commandCosts = economyConfig.commandCosts || [];
    const costConfig = commandCosts.find((config) => config.command === commandDisplayName);
    if (!costConfig || !costConfig.cost || costConfig.cost <= 0) {
      return { accepted: true, ticket: null };
    }

    const economyManager = new EconomyManager(eventObj);
    const charged = economyManager.tryReduceCoins(eventObj, costConfig.cost);
    if (!charged) {
      return { accepted: false, ticket: null };
    }

    return {
      accepted: true,
      ticket: {
        e: eventObj,
        amount: costConfig.cost,
        command: commandDisplayName,
        refundOnFalse: preflight.refundOnFalse ?? handler.economy?.refundOnFalse,
      },
    };
  } catch (err) {
    logger.error(`[EconomyHook] 检查指令消耗出错: ${err}`);
    return { accepted: true, ticket: null };
  }
}

export function afterExecute(ticket, result) {
  if (!shouldRefundOnResult(ticket, result)) return;

  try {
    const economyManager = new EconomyManager(ticket.e);
    economyManager.addCoins(ticket.e, ticket.amount);
  } catch (err) {
    logger.error(`[EconomyHook] 退还指令消耗失败: ${err}`);
  }
}

export function onError(ticket, err) {
  if (!ticket || err?.refund !== true) return;

  afterExecute(ticket, { refund: true });
}
