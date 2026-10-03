import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import path from "node:path";
import { pluginresources } from "../path.js";

let fontReady = false;
const FONT = '"NaiQuota", sans-serif';
const INK = "#253c37";
const MUTED = "#788780";

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

function number(value) {
    return Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

/** 用公开的查询结果绘制余额卡片；数据对象不包含 API Key。 */
export async function renderNaiQuotaImage(quota) {
    if (!quota) throw new Error("没有可绘制的 NAI 余额数据");
    if (!fontReady) {
        fontReady = Boolean(GlobalFonts.registerFromPath(
            path.join(pluginresources, "sign", "font", "FZFWZhuZiAYuanJWD.ttf"), "NaiQuota",
        ));
    }
    const width = 760;
    const height = 384;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#eff3f0";
    ctx.fillRect(0, 0, width, height);
    box(ctx, 24, 24, width - 48, height - 48, 24, "#ffffff");

    const left = 56;
    const right = width - left;
    text(ctx, "NAI 额度", left, 80, 30, INK, 600);
    text(ctx, quota.isRelay ? "可用点数" : "Anlas 余额", left, 132, 21, MUTED);
    const balanceText = number(quota.totalAnlas);
    let balanceSize = 64;
    ctx.font = `600 ${balanceSize}px ${FONT}`;
    while (ctx.measureText(balanceText).width > right - left && balanceSize > 22) {
        balanceSize -= 2;
        ctx.font = `600 ${balanceSize}px ${FONT}`;
    }
    text(ctx, balanceText, left, 205, balanceSize, INK, 600);

    ctx.fillStyle = "#edf1ee";
    ctx.fillRect(left, 234, right - left, 1);

    const percent = Math.max(0, Math.min(100, quota.percent));
    const color = percent < 5 ? "#c66e64" : percent < 25 ? "#bc9247" : "#568b76";
    text(ctx, "NAI5 剩余额度", left, 280, 22, INK);
    const percentText = `${number(percent)}%`;
    ctx.font = `600 28px ${FONT}`;
    text(ctx, percentText, right - ctx.measureText(percentText).width, 280, 28, color, 600);
    const barWidth = right - left;
    box(ctx, left, 304, barWidth, 12, 6, "#edf1ee");
    if (percent > 0) {
        const fillWidth = barWidth * percent / 100;
        box(ctx, left, 304, fillWidth, 12, Math.min(6, fillWidth / 2), color);
    }
    return canvas.encode("png");
}
