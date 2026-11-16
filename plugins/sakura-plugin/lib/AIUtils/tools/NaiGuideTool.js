import fs from "node:fs/promises";
import path from "node:path";
import { AbstractTool } from "./AbstractTool.js";
import { pluginRoot } from "../../path.js";

const GUIDE_DIR = path.join(pluginRoot, "lib", "nai", "guide");

// 专题 id 对应 lib/nai/guide/<id>.md；basics.md 是共通规则，每次都会返回。
export const NAI_GUIDE_TOPICS = Object.freeze({
    "prompt-language": "中文需求转提示词、选 Tag/英文自然语言/混合写法、信息顺序、强化弱化语法",
    "style-brushwork": "指定画风、媒介、笔触、线稿、上色、主色调、年代风格或视觉特效",
    "composition-lighting": "特定景别、镜头角度、透视、焦点、光线、复杂场景、漫画布局或透明背景",
    "multi-character": "两个及以上角色、角色坐标、避免特征串色、角色间互动",
    "text-rendering": "画面内的英文/日文/中文文字、招牌、对白气泡或视觉小说文本框",
});

async function readGuide(id) {
    return (await fs.readFile(path.join(GUIDE_DIR, `${id}.md`), "utf8")).trim();
}

export class NaiGuideTool extends AbstractTool {
    name = "NaiGuide";

    description = "加载 NAI 绘图指南：总会返回共通规则，再附上 topics 里选中的专题。简单单人图不用调用，直接用 NaiPainting；复杂画面在画之前调用一次，只选当前画面真正需要的专题。";

    parameters = {
        type: "object",
        properties: {
            topics: {
                type: "array",
                items: {
                    type: "string",
                    enum: Object.keys(NAI_GUIDE_TOPICS),
                },
                description: `需要的专题，可多选：\n${Object.entries(NAI_GUIDE_TOPICS)
                    .map(([id, text]) => `- ${id}：${text}`)
                    .join("\n")}`,
            },
        },
    };

    func = async function (opts) {
        const requested = Array.isArray(opts?.topics) ? opts.topics : [];
        const topics = [...new Set(requested.map((item) => String(item || "").trim()))]
            .filter((id) => Object.hasOwn(NAI_GUIDE_TOPICS, id));
        const unknown = requested.filter((item) => !Object.hasOwn(NAI_GUIDE_TOPICS, String(item || "").trim()));

        const sections = await Promise.all(["basics", ...topics].map(readGuide));
        if (unknown.length) {
            sections.push(`注意：以下专题不存在，已忽略：${unknown.join("、")}`);
        }
        return sections.join("\n\n---\n\n");
    };
}
