// 竖轨：整页共用的列线。半宽卡片 2 轨、整宽卡片 4 轨、窄屏 1 轨，
// 字段和列表项都按轨摆放，所以不同卡片里的框左右边缘能对上。
import { createContext, useLayoutEffect, useState } from 'react';

/** 当前容器的轨数；0 表示上层没有提供，按 2 轨处理。 */
export const TracksContext = createContext(0);

export function tracksForWidth(width) {
    if (width >= 800) return 4;
    if (width >= 400) return 2;
    return 1;
}

/** 没有看板提供轨数的地方（比如编辑抽屉）按自身宽度决定轨数。 */
export function useMeasuredTracks(ref) {
    const [tracks, setTracks] = useState(2);
    useLayoutEffect(() => {
        const element = ref.current;
        if (!element) return undefined;
        // 观察器在首次布局后、绘制前就会回调一次，不会闪
        const observer = new ResizeObserver(() => setTracks(tracksForWidth(element.clientWidth)));
        observer.observe(element);
        return () => observer.disconnect();
    }, [ref]);
    return tracks;
}

/** 第 start 轨起、占 span 轨的格子在网格里的列位置（轨与轨之间隔着一条间隙列）。 */
export function trackColumn(start, span = 1) {
    return `${start * 2 + 1} / ${(start + span) * 2}`;
}

const LOOKAHEAD = 3; // 补空位时最多往后看几个字段，避免把很远的字段提上来
const SHORT_MAX = 2; // 数字、开关这类短字段最多加宽到两轨，再宽就成了中间空一大段的横条

/**
 * 把字段排成一行行，尽量每行都占满所有轨。
 * items: [{ size: 'full' | 'wide' | 'short', ... }]；full 占整行，wide 占两轨，short 占一轨。
 * 一行放不满时先从后面找能塞进来的字段，仍有空位就让这一行里最窄的字段加宽。
 * 返回按摆放顺序排列的 [{ ...item, row, start, span }]。
 */
export function packRows(items, tracks) {
    const cellOf = (item) => {
        if (item.size === 'full') return { item, base: tracks, max: tracks };
        if (item.size === 'wide') return { item, base: Math.min(2, tracks), max: tracks };
        return { item, base: 1, max: Math.min(SHORT_MAX, tracks) };
    };
    const pending = items.map(cellOf);
    const rows = [];
    while (pending.length > 0) {
        const cells = [pending.shift()];
        let used = cells[0].base;
        for (let index = 0; index < Math.min(pending.length, LOOKAHEAD) && used < tracks;) {
            if (pending[index].base <= tracks - used) {
                used += pending[index].base;
                cells.push(...pending.splice(index, 1));
            } else {
                index++;
            }
        }
        rows.push(cells);
    }

    // 四轨时孤零零一个短字段只能占半行：从上一行借一个过来，两行都能排满
    for (let index = 1; index < rows.length; index++) {
        const previous = rows[index - 1];
        if (tracks >= 4 && rows[index].length === 1 && rows[index][0].base === 1 && previous.length >= 3) {
            rows[index].unshift(previous.pop());
        }
    }

    const placed = [];
    rows.forEach((cells, row) => {
        const spans = cells.map((cell) => cell.base);
        let used = spans.reduce((sum, span) => sum + span, 0);
        while (used < tracks) {
            let target = -1;
            cells.forEach((cell, index) => {
                if (spans[index] < cell.max && (target < 0 || spans[index] <= spans[target])) target = index;
            });
            if (target < 0) break;
            spans[target]++;
            used++;
        }
        let start = 0;
        cells.forEach((cell, index) => {
            placed.push({ ...cell.item, row, start, span: spans[index] });
            start += spans[index];
        });
    });
    return placed;
}
