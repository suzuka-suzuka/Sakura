const POSITION_ALIASES = [
    ["左上", { x: 0.3, y: 0.3 }],
    ["右上", { x: 0.7, y: 0.3 }],
    ["左下", { x: 0.3, y: 0.7 }],
    ["右下", { x: 0.7, y: 0.7 }],
    ["中间", { x: 0.5, y: 0.5 }],
    ["中心", { x: 0.5, y: 0.5 }],
    ["左", { x: 0.3, y: 0.5 }],
    ["右", { x: 0.7, y: 0.5 }],
    ["上", { x: 0.5, y: 0.3 }],
    ["下", { x: 0.5, y: 0.7 }],
    ["中", { x: 0.5, y: 0.5 }],
];

const PERCENT_COORDINATE_RE =
    /^@\s*(100(?:\.0+)?|[0-9]{1,2}(?:\.\d+)?)\s*[%％]?\s*[,，]\s*(100(?:\.0+)?|[0-9]{1,2}(?:\.\d+)?)\s*[%％]?\s*[:：]\s*([\s\S]*)$/;

/**
 * 解析方括号内的单个角色提示词。
 * 画面坐标格式：@x,y: prompt，其中 x/y 均为 0～100，百分号可省略。
 */
export function parseNaiCharacterPrompt(content) {
    let text = String(content || "").trim();
    let center = { x: 0.5, y: 0.5 };

    const coordinateMatch = text.match(PERCENT_COORDINATE_RE);
    if (coordinateMatch) {
        center = {
            x: Number(coordinateMatch[1]) / 100,
            y: Number(coordinateMatch[2]) / 100,
        };
        text = coordinateMatch[3].trim();
    } else {
        for (const [name, position] of POSITION_ALIASES) {
            if (!text.startsWith(name)) continue;

            center = position;
            text = text
                .substring(name.length)
                .replace(/^[,，:：\s]+/, "")
                .trim();
            break;
        }
    }

    if (!text) return null;

    return {
        prompt: text,
        uc: "",
        center,
        enabled: true,
    };
}
