import { generateImage } from "../nai/naiApi.js"
import { parseNaiDrawTag } from "./naiHandler.js"

const MAX_CHAT_DRAW_COUNT = 4

export { parseNaiDrawTag }

export function normalizeChatDrawCount(value) {
    const count = Math.trunc(Number(value))
    if (!Number.isFinite(count)) return 1
    return Math.max(1, Math.min(MAX_CHAT_DRAW_COUNT, count))
}

export async function generateAndSendNaiImages(
    drawPrompt,
    e,
    { imageCount = 1, generateImageImpl = generateImage } = {},
) {
    const count = normalizeChatDrawCount(imageCount)
    let sendQueue = Promise.resolve()

    for (let index = 0; index < count; index += 1) {
        const imageBuffer = await generateImageImpl(
            drawPrompt,
            null,
            null,
            { width: 1216, height: 832 },
            null,
            [],
        )
        const base64Image = imageBuffer.toString("base64")
        const imageMessage = segment.image(`base64://${base64Image}`)

        // 发送按生成顺序排队，但不阻塞下一张单图请求。
        sendQueue = sendQueue.then(async () => {
            try {
                await e.reply(imageMessage)
            } catch (error) {
                logger.error(
                    `第 ${index + 1}/${count} 张绘图发送失败: ${error.message || error}`,
                )
            }
        })
    }

    await sendQueue
}

export async function checkForNaiTags(
    message,
    e,
    naiPrompt,
    {
        drawState = null,
        imageCount = 1,
        generateImageImpl = generateImage,
    } = {},
) {
    const { cleanedMessage, drawPrompt } = parseNaiDrawTag(message, naiPrompt)
    if (!drawPrompt || drawState?.scheduled) {
        return cleanedMessage
    }

    // 在启动后台任务前立刻占位，确保一次聊天只处理第一组非空绘图标签。
    if (drawState) drawState.scheduled = true

    logger.info(`绘图提示词: ${drawPrompt}`)
    void generateAndSendNaiImages(drawPrompt, e, {
        imageCount,
        generateImageImpl,
    }).catch((error) => {
        logger.error(`绘图失败: ${error.message || error}`)
    })

    return cleanedMessage
}
