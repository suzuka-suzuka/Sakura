import { createContext, useContext } from 'react';

/**
 * 当前页面里各模块的草稿（含未保存的修改）。
 * 动态下拉选项优先从这里取值，这样刚添加、还没保存的供应商或模型也能立即被选择。
 * 值形如 { Providers: {...}, Models: {...} }
 */
export const DraftContext = createContext(null);

export function useDraftModules() {
    return useContext(DraftContext);
}
