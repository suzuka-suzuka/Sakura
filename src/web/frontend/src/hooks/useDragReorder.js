import { useCallback, useEffect, useRef, useState } from 'react';

const EDGE = 64; // 指针离窗口上下边缘多近时开始自动滚动

/** 记录每一项在页面坐标系里的位置（不随滚动变化）。 */
function measure(element) {
    const box = element.getBoundingClientRect();
    return {
        left: box.left + window.scrollX,
        top: box.top + window.scrollY,
        width: box.width,
        height: box.height,
    };
}

/**
 * 拖动排序：按住把手拖动，松手后调用 onMove(from, to)。
 * 同时支持竖排列表和多列网格（卡片格子）：竖排时只上下移动，网格时跟随指针移动、
 * 落到离中心最近的格子。用 Pointer Events，鼠标和触屏通用；
 * 把手获得焦点时也可以用方向键移动。
 *
 * 用法：列表容器挂 listRef，每一项展开 rowProps(index)，把手展开 handleProps(index)。
 */
export function useDragReorder(onMove) {
    const listRef = useRef(null);
    const sessionRef = useRef(null);
    const focusRef = useRef(null);
    const [drag, setDrag] = useState(null); // { from, to, dx, dy, rects, grid, shift }

    // 键盘移动后，把焦点还给移动到新位置的那一项的把手
    useEffect(() => {
        if (focusRef.current == null) return;
        const handle = listRef.current?.querySelector(`[data-drag-index="${focusRef.current}"] [data-drag-handle]`);
        focusRef.current = null;
        handle?.focus();
    });

    const update = useCallback((clientX, clientY) => {
        const session = sessionRef.current;
        if (!session) return;
        session.pointerX = clientX;
        session.pointerY = clientY;
        const { rects, from, bounds, grid } = session;
        const row = rects[from];
        const clamp = (number, min, max) => Math.min(Math.max(number, min), max);
        // 拖动范围限制在列表内
        const dy = clamp(clientY + window.scrollY - session.startY, bounds.top - row.top, bounds.bottom - row.top - row.height);
        const dx = grid
            ? clamp(clientX + window.scrollX - session.startX, bounds.left - row.left, bounds.right - row.left - row.width)
            : 0;
        const centerX = row.left + row.width / 2 + dx;
        const centerY = row.top + row.height / 2 + dy;

        let to = from;
        if (grid) {
            // 落到中心离指针最近的格子
            let best = Infinity;
            rects.forEach((rect, index) => {
                const distance = Math.hypot(rect.left + rect.width / 2 - centerX, rect.top + rect.height / 2 - centerY);
                if (distance < best) {
                    best = distance;
                    to = index;
                }
            });
        } else {
            to = 0;
            // 拖到底时被拖行的中心正好与最后一行重合，所以下方的行用 <=，否则永远拖不到最后
            rects.forEach((rect, index) => {
                const mid = rect.top + rect.height / 2;
                if ((index < from && mid < centerY) || (index > from && mid <= centerY)) to += 1;
            });
        }
        session.to = to;
        setDrag((prev) => (prev ? { ...prev, dx, dy, to } : prev));
    }, []);

    const finish = useCallback((commit) => {
        const session = sessionRef.current;
        if (!session) return;
        cancelAnimationFrame(session.raf);
        sessionRef.current = null;
        setDrag(null);
        if (commit && session.to !== session.from) onMove(session.from, session.to);
    }, [onMove]);

    useEffect(() => () => {
        if (sessionRef.current) cancelAnimationFrame(sessionRef.current.raf);
    }, []);

    const moveByKey = (event, index) => {
        const step = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[event.key];
        if (!step) return;
        event.preventDefault();
        const count = listRef.current?.querySelectorAll(':scope > [data-drag-index]').length || 0;
        const target = index + step;
        if (target < 0 || target >= count) return;
        focusRef.current = target;
        onMove(index, target);
    };

    const handleProps = (index) => ({
        'data-drag-handle': true,
        title: '拖动调整顺序',
        'aria-label': '拖动调整顺序，也可以用方向键移动',
        // 拖完松手时浏览器还会补发一次 click，别让它冒泡去打开编辑
        onClick: (event) => event.stopPropagation(),
        onPointerDown: (event) => {
            if (event.button !== 0 || !listRef.current) return;
            const rows = [...listRef.current.querySelectorAll(':scope > [data-drag-index]')];
            if (rows.length < 2) return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            const rects = rows.map(measure);
            const box = measure(listRef.current);
            const grid = rects.some((rect) => Math.abs(rect.left - rects[0].left) > 2);
            const gap = grid ? 0 : Math.max(0, rects[1].top - rects[0].top - rects[0].height);
            const session = {
                from: index,
                to: index,
                startX: event.clientX + window.scrollX,
                startY: event.clientY + window.scrollY,
                pointerX: event.clientX,
                pointerY: event.clientY,
                rects,
                grid,
                // 只在各项占据的范围内移动，不会拖到“添加”按钮上
                bounds: {
                    left: box.left,
                    right: box.left + box.width,
                    top: Math.min(...rects.map((rect) => rect.top)),
                    bottom: Math.max(...rects.map((rect) => rect.top + rect.height)),
                },
                raf: 0,
            };
            sessionRef.current = session;
            setDrag({ from: index, to: index, dx: 0, dy: 0, rects, grid, shift: rects[index].height + gap });

            // 指针停在窗口边缘时持续滚动
            const tick = () => {
                const current = sessionRef.current;
                if (!current) return;
                const y = current.pointerY;
                let speed = 0;
                if (y < EDGE) speed = -Math.ceil((EDGE - y) / 4);
                else if (y > window.innerHeight - EDGE) speed = Math.ceil((y - (window.innerHeight - EDGE)) / 4);
                if (speed !== 0) {
                    window.scrollBy(0, speed);
                    update(current.pointerX, y);
                }
                current.raf = requestAnimationFrame(tick);
            };
            session.raf = requestAnimationFrame(tick);
        },
        onPointerMove: (event) => {
            if (sessionRef.current) update(event.clientX, event.clientY);
        },
        onPointerUp: () => finish(true),
        onPointerCancel: () => finish(false),
        onLostPointerCapture: () => finish(true),
        onKeyDown: (event) => moveByKey(event, index),
    });

    const rowProps = (index) => {
        const props = { 'data-drag-index': index };
        if (!drag) return props;
        const { from, to, rects } = drag;
        let x = 0;
        let y = 0;
        if (index === from) {
            x = drag.dx;
            y = drag.dy;
            props['data-dragging'] = true;
        } else {
            const between = from < to ? index > from && index <= to : index >= to && index < from;
            if (between) {
                if (drag.grid) {
                    // 网格里每一项挪到相邻格子的位置
                    const slot = rects[from < to ? index - 1 : index + 1];
                    x = slot.left - rects[index].left;
                    y = slot.top - rects[index].top;
                } else {
                    y = from < to ? -drag.shift : drag.shift;
                }
            }
        }
        if (x || y) props.style = { transform: `translate(${x}px, ${y}px)` };
        return props;
    };

    return { listRef, rowProps, handleProps, dragging: drag != null };
}

/** 把 from 位置的元素移到 to 位置 */
export function moveItem(items, from, to) {
    const next = [...items];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
}
