
import { generateImage } from "../nai/naiApi.js"

const DRAW_TAG_REGEX = /<draw>([\s\S]*?)<\/draw>/gi

function normalizePromptPart(value) {
    return String(value || "")
        .split(/[\r\n]+/)
        .map(part => part.trim())
        .filter(Boolean)
        .join(", ")
}

export function parseNaiDrawTag(message, naiPrompt = "") {
    if (!message) {
        return { cleanedMessage: message, drawPrompt: "" }
    }

    let firstVisualPrompt = ""
    const cleanedMessage = String(message).replace(DRAW_TAG_REGEX, (_match, content) => {
        if (!firstVisualPrompt) {
            firstVisualPrompt = normalizePromptPart(content)
        }
        return ""
    }).trim()

    // 角色级 naiPrompt 只能补充已有的非空 <draw>，不能单独触发生图。
    if (!firstVisualPrompt) {
        return { cleanedMessage, drawPrompt: "" }
    }

    const extraPrompt = normalizePromptPart(naiPrompt)
    return {
        cleanedMessage,
        drawPrompt: extraPrompt
            ? `${firstVisualPrompt}, ${extraPrompt}`
            : firstVisualPrompt,
    }
}

export async function checkForNaiTags(
    message,
    e,
    naiPrompt,
    { drawState = null, generateImageImpl = generateImage } = {},
) {
    const { cleanedMessage, drawPrompt } = parseNaiDrawTag(message, naiPrompt)
    if (!drawPrompt || drawState?.scheduled) {
        return cleanedMessage
    }

    // 在启动后台任务前立刻占位，确保一次聊天即使包含中间回复和最终回复也只画一张。
    if (drawState) drawState.scheduled = true

    void (async () => {
        try {
            logger.info(`绘图提示词: ${drawPrompt}`)
            const imageBuffer = await generateImageImpl(
                drawPrompt,
                null,
                null,
                { width: 1216, height: 832 },
                null,
                [],
            )
            const base64Image = imageBuffer.toString("base64")
            await e.reply(segment.image(`base64://${base64Image}`))
        } catch (error) {
            logger.error(`绘图失败: ${error.message || error}`)
        }
    })()

    return cleanedMessage
}
