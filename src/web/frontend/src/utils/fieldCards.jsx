// 字段 → 页面卡片：按 group 拆成一张张卡片，交给 CardBoard 从上到下排列。
import { FieldGroup } from '../components/ConfigField';
import { groupFields } from './schemaLayout';

/**
 * 把一组字段拆成页面卡片（按 group 分），交给 CardBoard 排版。
 * 返回 [{ key, node }]。没有分组标题的第一张卡片用 title（通常是模块名）。
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
        const untitled = !group.title && index === 0;
        return {
            key: `${keyPrefix}:${group.title || index}`,
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
