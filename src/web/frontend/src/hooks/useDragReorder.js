import { useCallback, useEffect, useRef, useState } from 'react';

const EDGE = 64; // 指针离窗口上下边缘多近时开始自动滚动

/**
 * 列表拖动排序：按住把手上下拖，松手后调用 onMove(from, to)。
 * 用 Pointer Events，鼠标和触屏通用；把手获得焦点时也可以用 ↑ ↓ 键移动。
 *
 * 用法：列表容器挂 listRef，每一行展开 rowProps(index)，把手展开 handleProps(index)。
 */
export function useDragReorder(onMove) {
    const listRef = useRef(null);
    const sessionRef = useRef(null);
    const focusRef = useRef(null);
    const [drag, setDrag] = useState(null); // { from, to, dy, shift }

    // 键盘移动后，把焦点还给移动到新位置的那一行的把手
    useEffect(() => {
        if (focusRef.current == null) return;
        const handle = listRef.current?.querySelector(`[data-drag-index="${focusRef.current}"] [data-drag-handle]`);
        focusRef.current = null;
        handle?.focus();
    });

    const update = useCallback((clientY) => {
        const session = sessionRef.current;
        if (!session) return;
        session.pointerY = clientY;
        const { rects, from } = session;
        const row = rects[from];
        const last = rects[rects.length - 1];
        // 拖动范围限制在列表内
        const rawDy = clientY + window.scrollY - session.startY;
        const dy = Math.min(Math.max(rawDy, rects[0].top - row.top), last.top + last.height - row.top - row.height);
        const center = row.top + row.height / 2 + dy;
        let to = 0;
        // 拖到底时被拖行的中心正好与最后一行重合，所以下方的行用 <=，否则永远拖不到最后
        rects.forEach((rect, index) => {
            const mid = rect.top + rect.height / 2;
            if ((index < from && mid < center) || (index > from && mid <= center)) to += 1;
        });
        session.to = to;
        setDrag((prev) => (prev ? { ...prev, dy, to } : prev));
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

    const handleProps = (index) => ({
        'data-drag-handle': true,
        title: '拖动调整顺序',
        'aria-label': '拖动调整顺序，也可以用上下方向键移动',
        onPointerDown: (event) => {
            if (event.button !== 0 || !listRef.current) return;
            const rows = [...listRef.current.querySelectorAll(':scope > [data-drag-index]')];
            if (rows.length < 2) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            const rects = rows.map((row) => {
                const box = row.getBoundingClientRect();
                return { top: box.top + window.scrollY, height: box.height };
            });
            const gap = Math.max(0, rects[1].top - rects[0].top - rects[0].height);
            const session = {
                from: index,
                to: index,
                startY: event.clientY + window.scrollY,
                pointerY: event.clientY,
                rects,
                raf: 0,
            };
            sessionRef.current = session;
            setDrag({ from: index, to: index, dy: 0, shift: rects[index].height + gap });

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
                    update(y);
                }
                current.raf = requestAnimationFrame(tick);
            };
            session.raf = requestAnimationFrame(tick);
        },
        onPointerMove: (event) => {
            if (sessionRef.current) update(event.clientY);
        },
        onPointerUp: () => finish(true),
        onPointerCancel: () => finish(false),
        onLostPointerCapture: () => finish(true),
        onKeyDown: (event) => {
            const count = listRef.current?.querySelectorAll(':scope > [data-drag-index]').length || 0;
            const target = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : null;
            if (target == null) return;
            event.preventDefault();
            if (target < 0 || target >= count) return;
            focusRef.current = target;
            onMove(index, target);
        },
    });

    const rowProps = (index) => {
        const props = { 'data-drag-index': index };
        if (!drag) return props;
        let offset = 0;
        if (index === drag.from) offset = drag.dy;
        else if (drag.from < drag.to && index > drag.from && index <= drag.to) offset = -drag.shift;
        else if (drag.to < drag.from && index >= drag.to && index < drag.from) offset = drag.shift;
        if (index === drag.from) props['data-dragging'] = true;
        if (offset) props.style = { transform: `translateY(${offset}px)` };
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
