/**
 * 设置页的卡片栏：限宽单栏，卡片从上到下排列。
 * cards: [{ key, node }]；children 放在最前面（保存失败提示、警告等）。
 */
export default function CardBoard({ cards, children = null }) {
    return (
        <div className="board">
            {children}
            {cards.map((card) => <div key={card.key} className="board-item">{card.node}</div>)}
        </div>
    );
}
