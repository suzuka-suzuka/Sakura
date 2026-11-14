// 字段 → 页面卡片：按 group 拆卡片、估计高度、决定是否独占一行，交给 CardBoard 排版。
import { FieldGroup } from '../components/ConfigField';
import { groupFields, isFieldVisible } from './schemaLayout';

/** 粗略估计字段高度（约 60px 为 1），只用于首次分栏前的预排。 */
function estimateFieldWeight(meta, fieldValue) {
    const count = Array.isArray(fieldValue) ? fieldValue.length : 0;
    if (meta.type === 'object' && meta.children) {
        return 1 + Object.entries(meta.children).reduce((sum, [key, child]) => sum + estimateFieldWeight(child, fieldValue?.[key]), 0);
    }
    if (meta.uiType === 'commandCost') return 4;
    if (meta.uiType === 'cron') return 3;
    if (meta.uiType === 'textarea') return 2.4;
    if (meta.type === 'array') {
        if (meta.items?.type === 'object') return 1.2 + Math.ceil((count + 1) / 2) * 1.2;
        if (meta.uiType?.startsWith('modelList') || meta.uiType === 'secretList') return 1.4 + count * 0.75;
        return 1.4;
    }
    if (meta.type === 'boolean' || meta.type === 'number' || meta.type === 'enum') return 0.6;
    return 1;
}

/**
 * 把一组字段拆成页面卡片（按 group 分），交给 CardBoard 排版。
 * 返回 [{ key, wide, weight, node }]。没有分组标题的第一张卡片用 title（通常是模块名）。
 */
export function buildFieldCards({
    keyPrefix,
    children,
    value,
    onFieldChange,
    scopeSelfId = null,
    context = {},
    anchorScope = '',
    groupByCard = true,
    title = '',
    help = '',
    cardId,
}) {
    const groups = groupByCard ? groupFields(children) : [{ title, fields: Object.entries(children || {}) }];
    return groups.map((group, index) => {
        const visible = group.fields.filter(([, meta]) => isFieldVisible(meta, value, context));
        const basic = visible.filter(([, meta]) => !meta.advanced);
        const objectListLength = basic
            .filter(([, meta]) => meta.type === 'array' && meta.items?.type === 'object')
            .reduce((max, [key]) => Math.max(max, Array.isArray(value?.[key]) ? value[key].length : 0), 0);
        const wide = basic.length > 10
            || basic.some(([, meta]) => meta.uiType === 'commandCost')
            || objectListLength > 6;
        const weight = 1 + basic.reduce((sum, [key, meta]) => sum + estimateFieldWeight(meta, value?.[key]), 0)
            + (visible.length > basic.length ? 0.6 : 0);
        const untitled = !group.title && index === 0;
        return {
            key: `${keyPrefix}:${group.title || index}`,
            wide,
            weight,
            node: (
                <FieldGroup
                    title={group.title || (untitled ? title : '')}
                    help={untitled ? help : ''}
                    cardId={index === 0 ? cardId : undefined}
                    fields={group.fields}
                    value={value}
                    onFieldChange={onFieldChange}
                    scopeSelfId={scopeSelfId}
                    context={context}
                    variant="page"
                    anchorScope={anchorScope}
                />
            ),
        };
    });
}
