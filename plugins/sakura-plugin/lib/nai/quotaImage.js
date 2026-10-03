import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import path from "node:path";
import { pluginresources } from "../path.js";

let fontReady = false;
const FONT = '"NaiQuota", sans-serif';
const INK = "#263546";
const MUTED = "#7b8796";

function box(ctx, x, y, width, height, radius, color) {
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, radius);
    ctx.fillStyle = color;
    ctx.fill();
}

function text(ctx, value, x, y, size = 22, color = INK, weight = 400) {
    ctx.font = `${weight} ${size}px ${FONT}`;
    ctx.fillStyle = color;
    ctx.fillText(String(value), x, y);
}

function fitText(ctx, value, width, size = 22, weight = 400) {
    ctx.font = `${weight} ${size}px ${FONT}`;
    const chars = Array.from(String(value).replace(/[\r\n\t]/g, " "));
    if (ctx.measureText(chars.join("")).width <= width) return chars.join("");
    while (chars.length && ctx.measureText(`${chars.join("")}…`).width > width) chars.pop();
    return `${chars.join("")}…`;
}

function number(value) {
    return Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function statusPill(ctx, label, x, y, color, background) {
    ctx.font = `18px ${FONT}`;
    const width = ctx.measureText(label).width + 28;
    box(ctx, x - width, y, width, 32, 16, background);
    text(ctx, label, x - width + 14, y + 22, 18, color);
}

function drawCard(ctx, quota, x, y, width) {
    ctx.save();
    ctx.shadowColor = "rgba(36, 53, 70, 0.05)";
    ctx.shadowBlur = 20;
    ctx.shadowOffsetY = 6;
    box(ctx, x, y, width, 286, 22, "#ffffff");
    ctx.restore();
    const left = x + 26;
    const right = x + width - 26;
    text(ctx, "当前绘图接口", left, y + 54, 25, INK, 600);
    statusPill(ctx, "查询成功", right, y + 30, MUTED, "#f2f4f7");

    text(ctx, "Anlas 余额", left, y + 101, 19, MUTED);
    text(ctx, fitText(ctx, number(quota.totalAnlas), width - 70, 43, 600), left, y + 149, 43, INK, 600);
    text(ctx, fitText(ctx, quota.isRelay ? "可用点数" : `订阅 ${number(quota.subscriptionAnlas)}   /   购买 ${number(quota.purchasedAnlas)}`, width - 52, 19),
        left, y + 185, 19, MUTED);
    const percent = Math.max(0, Math.min(100, quota.percent));
    const color = percent < 5 ? "#cb7871" : percent < 25 ? "#c49a50" : "#4f9d97";
    text(ctx, "NAI5 剩余额度", left, y + 232, 19, MUTED);
    const percentText = `${number(percent)}%`;
    ctx.font = `600 25px ${FONT}`;
    text(ctx, percentText, right - ctx.measureText(percentText).width, y + 232, 25, color, 600);
    const barWidth = width - 52;
    box(ctx, left, y + 250, barWidth, 10, 5, "#edf0f4");
    if (percent > 0) {
        const fillWidth = barWidth * percent / 100;
        const gradient = ctx.createLinearGradient(left, 0, right, 0);
        gradient.addColorStop(0, percent < 25 ? "#e9c084" : "#98c7be");
        gradient.addColorStop(1, color);
        box(ctx, left, y + 250, fillWidth, 10, Math.min(5, fillWidth / 2), gradient);
    }
}

/** 用公开的查询结果绘制余额卡片；数据对象不包含 API Key。 */
export async function renderNaiQuotaImage(quota, {
    generatedAt = new Date(),
    scopeLabel = "当前绘图接口",
} = {}) {
    if (!quota) throw new Error("没有可绘制的 NAI 余额数据");
    if (!fontReady) {
        fontReady = Boolean(GlobalFonts.registerFromPath(
            path.join(pluginresources, "sign", "font", "FZFWZhuZiAYuanJWD.ttf"), "NaiQuota",
        ));
    }
    const width = 1160;
    const height = 738;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    const background = ctx.createLinearGradient(0, 0, width, height);
    background.addColorStop(0, "#f8f6f1");
    background.addColorStop(1, "#edf2f4");
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
    for (let i = 0; i < 7; i++) {
        ctx.beginPath();
        ctx.arc(width - 140, 38, 96 + i * 22, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(94, 130, 143, 0.06)";
        ctx.lineWidth = 1;
        ctx.stroke();
    }

    text(ctx, "N O V E L A I   /   A C C O U N T", 40, 49, 16, "#77958f", 600);
    text(ctx, "余额总览", 40, 112, 46, INK, 600);
    text(ctx, fitText(ctx, scopeLabel, 800, 20), 42, 151, 20, MUTED);
    const dateText = generatedAt.toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
    ctx.font = `17px ${FONT}`;
    text(ctx, dateText, width - 40 - ctx.measureText(dateText).width, 151, 17, MUTED);

    const panel = ctx.createLinearGradient(40, 0, 1120, 0);
    panel.addColorStop(0, "#263b49");
    panel.addColorStop(1, "#385b61");
    box(ctx, 40, 180, 1080, 162, 24, panel);
    text(ctx, quota.isRelay ? "可用点数 · ANLAS" : "总余额 · ANLAS", 70, 220, 21, "#b6cfcd");
    text(ctx, fitText(ctx, number(quota.totalAnlas), 490, 53, 600), 68, 289, 53, "#ffffff", 600);
    const metrics = [["余额类型", quota.isRelay ? "可用点数" : "账户余额"], ["NAI5 剩余额度", `${number(quota.percent)}%`]];
    metrics.forEach(([label, value], index) => {
        const x = 620 + index * 240;
        text(ctx, label, x, 229, 18, "#b6cfcd");
        text(ctx, value, x, 284, 33, "#ffffff", 600);
    });

    text(ctx, "余额明细", 42, 387, 24, INK, 600);
    drawCard(ctx, quota, 40, 412, 1080);
    text(ctx, "NOVELAI   ·   余额快照", 42, height - 19, 16, MUTED);
    text(ctx, "NAI5 进度条表示剩余额度", 858, height - 19, 16, MUTED);
    return canvas.encode("png");
}
