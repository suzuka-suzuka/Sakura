import { AbstractTool } from "./AbstractTool.js";
import { generateImage } from "../../nai/naiApi.js";
import { getVibe, listVibes } from "../../nai/vibeStore.js";
import Setting from "../../setting.js";

const ASPECT_RATIO_SIZES = Object.freeze({
    portrait: { width: 832, height: 1216 },
    landscape: { width: 1216, height: 832 },
    square: { width: 1024, height: 1024 },
});

function clampPercent(value, fallback) {
    if (value == null || value === "") return fallback;
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(0, Math.min(100, number));
}

function normalizeVibeName(value) {
    const name = String(value || "").trim();
    if (!name) return "";
    if (
        name.length > 80 ||
        name === "." ||
        name === ".." ||
        name.includes("..") ||
        /[\\/:*?"<>|]/.test(name)
    ) {
        throw new Error("画风名称不合法");
    }
    return name;
}

export function buildNaiToolRequest(opts = {}) {
    const prompt = String(opts?.prompt || "").trim();
    if (!prompt) {
        throw new Error("请提供一个图片生成提示词");
    }

    const aspectRatio = String(opts?.aspectRatio || "portrait").trim();
    const size = ASPECT_RATIO_SIZES[aspectRatio];
    if (!size) {
        throw new Error("画幅仅支持 portrait、landscape 或 square");
    }

    const inputCharacters = Array.isArray(opts?.characters)
        ? opts.characters
        : [];
    if (inputCharacters.length > 32) {
        throw new Error("角色提示词最多支持 32 个");
    }

    const characters = inputCharacters.map((character, index) => {
        const characterPrompt = String(character?.prompt || "").trim();
        if (!characterPrompt) {
            throw new Error(`第 ${index + 1} 个角色缺少 prompt`);
        }

        const defaultX = inputCharacters.length > 1
            ? ((index + 1) / (inputCharacters.length + 1)) * 100
            : 50;
        return {
            prompt: characterPrompt,
            uc: String(character?.undesired || "").trim(),
            center: {
                x: clampPercent(character?.x, defaultX) / 100,
                y: clampPercent(character?.y, 50) / 100,
            },
        };
    });

    const parameters = { ...size };
    const vibeName = normalizeVibeName(opts?.vibe);
    if (vibeName) {
        const vibe = getVibe(vibeName);
        if (!vibe) {
            const available = listVibes().map((item) => item.name);
            const suffix = available.length > 0
                ? `；当前可用画风：${available.join("、")}`
                : "；当前没有已保存画风";
            throw new Error(`未找到画风“${vibeName}”${suffix}`);
        }
        parameters.reference_image_multiple = [vibe.image];
        parameters.reference_information_extracted_multiple = [
            vibe.informationExtracted,
        ];
        parameters.reference_strength_multiple = [vibe.strength];
    }

    const negativePrompt = String(opts?.negativePrompt || "").trim();
    return {
        prompt,
        negative: negativePrompt || null,
        parameters,
        characters,
    };
}

export class NaiTool extends AbstractTool {
    name = "NaiPainting";
    description = "使用 NovelAI 生成二次元/动漫风格图片。简单单人图可直接调用；多人站位、角色交互、复杂构图、画面文字、透明背景或指定画风时，先用 SkillGuide 加载 nai5-image-generation，再按父 Skill 返回的目录只加载相关子 Skill。";

    parameters = {
        type: "object",
        properties: {
            prompt: {
                type: "string",
                description: "基础提示词：人数、场景、画风、构图、镜头和光线。优先使用准确的英文 NAI Tag；也可使用完整连贯的英文自然语言描述或两者混合，不要用残缺短句代替完整描述。画面文字必须把 Text: 内容放在末尾。",
            },
            aspectRatio: {
                type: "string",
                enum: ["portrait", "landscape", "square"],
                description: "画幅：portrait 竖图、landscape 横图、square 方图；默认 portrait。",
            },
            negativePrompt: {
                type: "string",
                description: "本次额外不希望出现的内容；公共负面词会由配置自动补充。",
            },
            characters: {
                type: "array",
                maxItems: 32,
                description: "独立角色提示词。多人画面应把每个人的外观、服装、动作和位置分别写在这里，减少串色。",
                items: {
                    type: "object",
                    properties: {
                        prompt: {
                            type: "string",
                            description: "单个角色提示词，以 girl、boy 或 other 开头，不写人数数字；优先使用准确 Tag，复杂动作可用完整英文句子补强。",
                        },
                        x: {
                            type: "number",
                            minimum: 0,
                            maximum: 100,
                            description: "角色横向位置百分比：0 最左，100 最右。",
                        },
                        y: {
                            type: "number",
                            minimum: 0,
                            maximum: 100,
                            description: "角色纵向位置百分比：0 最上，100 最下。",
                        },
                        undesired: {
                            type: "string",
                            description: "只针对该角色的负面提示，用来阻止其他角色的特征串入。",
                        },
                    },
                    required: ["prompt"],
                },
            },
            vibe: {
                type: "string",
                description: "用户明确指定的已保存画风名称。不要编造；使用后会自动切换到支持 Vibe Transfer 的 NAI4.5。",
            },
        },
        required: ["prompt"],
    };

    func = async function (opts, e) {
        try {
            const request = buildNaiToolRequest(opts);
            const configuredNegative = String(
                Setting.getConfig("nai")?.negative || "",
            ).trim();
            const negative = request.negative
                ? [configuredNegative, request.negative].filter(Boolean).join(", ")
                : null;
            const imageBuffer = await generateImage(
                request.prompt,
                null,
                negative,
                request.parameters,
                null,
                request.characters,
            );
            const base64Image = imageBuffer.toString("base64");
            await e.reply(segment.image(`base64://${base64Image}`));

            return "已成功生成并发送图片，禁止回复[图片]";
        } catch (error) {
            logger.error(`[NaiTool] Error: ${error.message}`);
            return `图片生成失败：${error.message}`;
        }
    };
}
