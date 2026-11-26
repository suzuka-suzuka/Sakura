import crypto from "crypto";
import fs from "fs";
import path from "path";
import { plugindata } from "../path.js";

// 用户的 API Key 加密后才进数据库，密钥单独放一个文件：只拷走数据库文件时拿不到明文 Key。
const KEY_FILE = path.join(plugindata, "private-chat.key");
const VERSION = "v1";

let cachedKey = null;

function loadKey() {
  if (cachedKey) return cachedKey;
  try {
    const hex = fs.readFileSync(KEY_FILE, "utf8").trim();
    if (/^[a-f0-9]{64}$/i.test(hex)) {
      cachedKey = Buffer.from(hex, "hex");
      return cachedKey;
    }
    throw new Error("密钥文件格式不对");
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`读取私聊 AI 密钥失败：${error.message}`);
  }
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  const key = crypto.randomBytes(32);
  // wx：并发时只有一个能写成功，失败的一方重新读取
  try {
    fs.writeFileSync(KEY_FILE, key.toString("hex"), { mode: 0o600, flag: "wx" });
    cachedKey = key;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    cachedKey = Buffer.from(fs.readFileSync(KEY_FILE, "utf8").trim(), "hex");
  }
  return cachedKey;
}

export function encryptSecret(plainText) {
  if (!plainText) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", loadKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(":");
}

export function decryptSecret(stored) {
  if (!stored) return "";
  const [version, ivText, tagText, dataText] = String(stored).split(":");
  if (version !== VERSION || !ivText || !tagText || dataText === undefined) {
    throw new Error("无法识别的密文格式");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", loadKey(), Buffer.from(ivText, "base64"));
  decipher.setAuthTag(Buffer.from(tagText, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataText, "base64")), decipher.final()]).toString("utf8");
}

/** 页面上只显示 Key 的首尾几位 */
export function maskSecret(plainText) {
  const text = String(plainText || "");
  if (!text) return "";
  if (text.length <= 10) return "••••";
  return `${text.slice(0, 4)}••••${text.slice(-4)}`;
}
