import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(__dirname, "../..");
export const LOG_DIR = path.join(PROJECT_ROOT, "logs");
export const BOT_LOG_BASE = path.join(LOG_DIR, "bot.log");

fs.mkdirSync(LOG_DIR, { recursive: true });

export function getLocalDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getBotLogPathForDate(date = new Date()) {
  return path.join(LOG_DIR, `bot.${getLocalDateString(date)}.log`);
}

export function listBotLogFiles() {
  if (!fs.existsSync(LOG_DIR)) return [];
  const files = fs
    .readdirSync(LOG_DIR)
    .filter((file) => file.startsWith("bot.") && file.endsWith(".log"))
    .sort();
  const datedFiles = files.filter((file) => /^bot\.\d{4}-\d{2}-\d{2}\.log$/.test(file));
  return (datedFiles.length > 0 ? datedFiles : files).reverse();
}

export function getLatestBotLogPath() {
  const files = listBotLogFiles();
  return files.length > 0 ? path.join(LOG_DIR, files[0]) : null;
}
