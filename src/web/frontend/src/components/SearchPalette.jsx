import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';

function score(entry, query) {
    const text = `${entry.title} ${entry.subtitle || ''} ${entry.keywords || ''}`.toLowerCase();
    const title = entry.title.toLowerCase();
    if (title === query) return 100;
    if (title.startsWith(query)) return 80;
    if (title.includes(query)) return 60;
    if (text.includes(query)) return 30;
    // 逐字匹配：输入“模型供应”也能找到“模型与供应商”
    let position = 0;
    for (const char of query) {
        position = text.indexOf(char, position);
        if (position < 0) return 0;
        position += 1;
    }
    return 10;
}

export default function SearchPalette({ entries, onSelect, onClose }) {
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(0);
    const listRef = useRef(null);

    const results = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return entries.filter((entry) => entry.kind === 'page').slice(0, 30);
        return entries
            .map((entry) => ({ entry, score: score(entry, q) + (entry.kind === 'page' ? 5 : 0) }))
            .filter((item) => item.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 40)
            .map((item) => item.entry);
    }, [entries, query]);

    useEffect(() => {
        listRef.current?.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
    }, [active]);

    const handleKeyDown = (event) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive((index) => Math.min(index + 1, results.length - 1));
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((index) => Math.max(index - 1, 0));
        } else if (event.key === 'Enter') {
            event.preventDefault();
            if (results[active]) onSelect(results[active]);
        } else if (event.key === 'Escape') {
            onClose();
        }
    };

    return createPortal(
        <div className="palette-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
            <div className="palette" role="dialog" aria-modal="true" aria-label="搜索设置">
                <div className="palette-input">
                    <Icon name="search" size={18} />
                    <input
                        autoFocus
                        value={query}
                        placeholder="搜索页面或设置项，例如：模型、复读、撤回"
                        onChange={(event) => { setQuery(event.target.value); setActive(0); }}
                        onKeyDown={handleKeyDown}
                    />
                    <kbd>Esc</kbd>
                </div>
                <div className="palette-list" ref={listRef}>
                    {results.length === 0 && <div className="palette-empty">没有找到“{query}”相关的设置</div>}
                    {results.map((entry, index) => (
                        <button
                            key={entry.id}
                            type="button"
                            className={`palette-item ${index === active ? 'active' : ''}`}
                            onMouseEnter={() => setActive(index)}
                            onClick={() => onSelect(entry)}
                        >
                            <Icon name={entry.kind === 'page' ? (entry.icon || 'puzzle') : 'sliders'} size={16} />
                            <span className="palette-item-text">
                                <span className="palette-item-title">{entry.title}</span>
                                {entry.subtitle && <span className="palette-item-subtitle">{entry.subtitle}</span>}
                            </span>
                            <Icon name="chevronRight" size={15} className="palette-item-arrow" />
                        </button>
                    ))}
                </div>
            </div>
        </div>,
        document.body
    );
}
