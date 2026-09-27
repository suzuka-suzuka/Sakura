import { useState } from 'react';

// 输入中的文本与提交给配置的值分离，避免 0.、负号、尾随零和清空被回写打断。
export default function DraftInput({ value, onChange, parse = text => text, ...props }) {
    const [draft, setDraft] = useState(null);
    const visibleDraft = draft && Object.is(draft.value, value) ? draft.text : null;

    return (
        <input
            {...props}
            ref={element => {
                if (element) element.setCustomValidity(
                    parse(String(visibleDraft ?? value ?? '')) === undefined ? '请输入有效的数字' : '',
                );
            }}
            value={visibleDraft ?? value ?? ''}
            onChange={event => {
                const text = event.target.value;
                const next = parse(text);
                event.target.setCustomValidity(next === undefined ? '请输入有效的数字' : '');
                setDraft({ text, value: next === undefined ? value : next });
                if (next !== undefined) onChange(next);
            }}
            onBlur={event => {
                // 无效草稿保留在界面上，并由表单有效性检查阻止误保存旧值。
                if (parse(event.target.value) !== undefined) setDraft(null);
            }}
        />
    );
}
