import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { TracksContext } from '../utils/tracks';

const TWO_COLUMN_MIN = 860; // 卡片区至少这么宽才分两栏
const ONE_TRACK_MAX = 480; // 比这还窄时卡片里一行只放一个字段

/** 按高度把卡片依次放进当前最矮的一栏，保持大致的阅读顺序。 */
function distribute(cards, heightOf, columns) {
    const totals = new Array(columns).fill(0);
    const assign = {};
    for (const card of cards) {
        let target = 0;
        for (let column = 1; column < columns; column++) {
            // 差不多高时放左边，避免顺序被打乱
            if (totals[column] < totals[target] - 24) target = column;
        }
        assign[card.key] = target;
        totals[target] += heightOf(card) + 16;
    }
    return assign;
}

/** 连续的普通卡片组成一段瀑布流，wide 卡片独占一行；只有一张的段也占满整行。 */
function splitSegments(cards) {
    const segments = [];
    let current = [];
    const flush = () => {
        if (current.length > 0) segments.push({ masonry: current.length > 1, cards: current });
        current = [];
    };
    for (const card of cards) {
        if (card.wide) {
            flush();
            segments.push({ masonry: false, cards: [card] });
        } else {
            current.push(card);
        }
    }
    flush();
    return segments;
}

/** 卡片内容本身的高度。每栏最后一张卡片会被拉到底，不能直接量它的外框。 */
function naturalHeight(item) {
    const card = item.firstElementChild;
    if (!card) return 0;
    let height = 2;
    for (const child of card.children) height += child.offsetHeight;
    return height;
}

/**
 * 卡片看板：宽屏时普通卡片分成两栏瀑布流，每栏最后一张拉到底，两栏底部对齐。
 * cards: [{ key, wide, weight, node }]。weight 是首次渲染前的高度估计，
 * 渲染后按实际高度重新分栏；分栏只在卡片集合或栏数变化时重算，编辑时卡片不会跳栏。
 *
 * 看板同时决定每张卡片里有几条竖轨：半宽卡片 2 轨、整宽卡片 4 轨，
 * 整宽卡片的轨和两张半宽卡片的轨是同一组竖线（见 index.css 的 .tracks-4）。
 */
export default function CardBoard({ cards, children = null }) {
    const boardRef = useRef(null);
    const [resizeTick, rerender] = useReducer((count) => count + 1, 0);
    const [layout, setLayout] = useState({ columns: 0, narrow: false, signature: '', assign: null });

    useEffect(() => {
        window.addEventListener('resize', rerender);
        return () => window.removeEventListener('resize', rerender);
    }, []);

    const keys = cards.map((card) => card.key).join('|');

    // 量完宽度和卡片高度后同步重排，浏览器只会画出最终结果
    useLayoutEffect(() => {
        const board = boardRef.current;
        if (!board) return;
        const columns = board.clientWidth >= TWO_COLUMN_MIN ? 2 : 1;
        const narrow = board.clientWidth < ONE_TRACK_MAX;
        if (columns !== layout.columns || narrow !== layout.narrow) {
            // 栏数或轨数变了，卡片高度跟着变，先按新的排一遍再量
            setLayout({ columns, narrow, signature: '', assign: null });
            return;
        }
        const signature = `${columns}:${keys}`;
        if (layout.signature === signature) return;
        const heights = {};
        for (const element of board.querySelectorAll('[data-board-card]')) {
            heights[element.dataset.boardCard] = naturalHeight(element);
        }
        const assign = {};
        for (const segment of splitSegments(cards)) {
            if (!segment.masonry) continue;
            Object.assign(assign, distribute(segment.cards, (card) => heights[card.key] ?? 0, columns));
        }
        setLayout({ columns, narrow, signature, assign });
    }, [cards, keys, layout.columns, layout.narrow, layout.signature, resizeTick]);

    const columns = Math.max(1, layout.columns);
    const segments = splitSegments(cards);
    const halfTracks = layout.narrow ? 1 : 2;
    const fullTracks = columns === 2 ? 4 : halfTracks;

    const renderItem = (card, tracks) => (
        <div key={card.key} className="board-item" data-board-card={card.key}>
            <TracksContext.Provider value={tracks}>{card.node}</TracksContext.Provider>
        </div>
    );

    return (
        <div ref={boardRef} className="board">
            {children}
            {segments.map((segment) => {
                if (!segment.masonry || columns === 1) {
                    return segment.cards.map((card) => renderItem(card, fullTracks));
                }
                const assign = layout.assign
                    || distribute(segment.cards, (card) => (card.weight || 1) * 60, columns);
                const lanes = Array.from({ length: columns }, () => []);
                for (const card of segment.cards) lanes[assign[card.key] ?? 0].push(card);
                return (
                    <div key={`segment-${segment.cards[0].key}`} className="board-masonry" style={{ '--board-columns': columns }}>
                        {lanes.map((lane, index) => (
                            <div key={index} className="board-lane">
                                {lane.map((card) => renderItem(card, halfTracks))}
                            </div>
                        ))}
                    </div>
                );
            })}
        </div>
    );
}
