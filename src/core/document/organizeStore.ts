import { create } from "zustand";

/**
 * 页面组织会话 store（M3 页面组织，模块 5）：
 * 组织视图（features/organize）编辑中的页序模型——页序（源页索引数组）与
 * 每页旋转增量（相对原 /Rotate 的叠加角）。导出（另存副本 / 提取）由
 * pageOrganizeExport 消费本 store 与文档会话 store 生成新文件，原文件不动。
 *
 * 隔离与生命周期：
 * - 按**标签 id + 装载代际（loadGeneration）**键控：同一标签重开文档（重载）
 *   后旧组织状态整体作废重建，避免页数变化后残留悬空页号；
 * - 标签关闭时由 openDocument.closeDocument 调 clearSession 清理；
 * - 撤销（undoStack）为全量快照栈，本次会话内有效（验收 M3-2「删除可撤销」），
 *   不做 redo，不做跨会话持久化。
 *
 * 多选集合（selection）是纯 UI 瞬态，留在组织视图组件内，不入 store。
 */

/** 一份可撤销的组织状态快照。 */
export interface OrganizeSnapshot {
  /** 页序：源页索引（0 起）的数组，数组顺序即当前页序。 */
  order: readonly number[];
  /** 每个源页的旋转增量（0/90/180/270 度，相对原 /Rotate 叠加）。 */
  rotationDelta: Readonly<Record<number, number>>;
}

interface OrganizeSession extends OrganizeSnapshot {
  /** 建立会话时的装载代际；与标签当前 loadGeneration 不符即过期。 */
  generation: number;
  /** 撤销栈（后进先出）；每项是**变更前**的快照。 */
  undoStack: OrganizeSnapshot[];
}

interface OrganizeStoreState {
  sessions: Record<string, OrganizeSession>;
  /**
   * 取一个标签的组织会话；不存在或代际不符时按当前页数**重建**
   * （order = 0..n-1，旋转清零，撤销栈清空——文档已被重开，旧页序不再可信）。
   */
  ensureSession: (tabId: string, generation: number, numPages: number) => OrganizeSession;
  /**
   * 把一组源页移动到锚页之前/之后（拖拽重排）。
   * 移动块保持自身相对顺序；锚页在移动块内时不动（拖回原地）。
   */
  movePages: (tabId: string, sourceIndices: number[], anchorSourceIndex: number, place: "before" | "after") => void;
  /** 旋转一组源页（delta ∈ {90, 180, 270}，向右叠加后取模 360）。 */
  rotatePages: (tabId: string, sourceIndices: number[], delta: 90 | 180 | 270) => void;
  /** 删除一组源页（从 order 中摘除；全部删空后 order 为空数组，导出被拒绝）。 */
  removePages: (tabId: string, sourceIndices: number[]) => void;
  /** 撤销上一次组织操作；无可撤销时返回 false 且状态不变。 */
  undo: (tabId: string) => boolean;
  /** 摘除会话（标签关闭时由 closeDocument 调用）。 */
  clearSession: (tabId: string) => void;
}
/** 快照拷贝（浅层数组/对象重建，嵌套无引用类型，足够不可变）。 */
function snapshotOf(session: OrganizeSession): OrganizeSnapshot {
  return { order: [...session.order], rotationDelta: { ...session.rotationDelta } };
}

function normalizeDelta(delta: number): 0 | 90 | 180 | 270 {
  return (((delta % 360) + 360) % 360) as 0 | 90 | 180 | 270;
}

function blankSession(generation: number, numPages: number): OrganizeSession {
  return {
    generation,
    order: Array.from({ length: numPages }, (_, i) => i),
    rotationDelta: {},
    undoStack: [],
  };
}

/** 无会话时的只读哨兵（与 store.ts 的 IDLE_SESSION 同款手法）。 */
export const EMPTY_ORGANIZE: Readonly<OrganizeSnapshot> = Object.freeze({
  order: Object.freeze([]),
  rotationDelta: Object.freeze({}),
});

export const useOrganizeStore = create<OrganizeStoreState>((set, get) => ({
  sessions: {},

  ensureSession: (tabId, generation, numPages) => {
    const existing = get().sessions[tabId];
    if (existing && existing.generation === generation) return existing;
    const session = blankSession(generation, numPages);
    set((s) => ({ sessions: { ...s.sessions, [tabId]: session } }));
    return session;
  },

  movePages: (tabId, sourceIndices, anchorSourceIndex, place) => {
    const session = get().sessions[tabId];
    if (!session || sourceIndices.length === 0) return;
    const moving = new Set(sourceIndices);
    // 移动块按当前页序保持相对顺序。
    const block = session.order.filter((src) => moving.has(src));
    const rest = session.order.filter((src) => !moving.has(src));
    const anchorPos = rest.indexOf(anchorSourceIndex);
    if (anchorPos < 0 || block.length === 0) return; // 锚在移动块内（拖回原地）或无效
    const insertAt = place === "before" ? anchorPos : anchorPos + 1;
    const order = [...rest.slice(0, insertAt), ...block, ...rest.slice(insertAt)];
    set((s) => ({
      sessions: {
        ...s.sessions,
        [tabId]: {
          ...session,
          order,
          undoStack: [...session.undoStack, snapshotOf(session)],
        },
      },
    }));
  },

  rotatePages: (tabId, sourceIndices, delta) => {
    const session = get().sessions[tabId];
    if (!session || sourceIndices.length === 0) return;
    const valid = new Set(session.order);
    const rotationDelta = { ...session.rotationDelta };
    let changed = false;
    for (const src of sourceIndices) {
      if (!valid.has(src)) continue;
      const next = normalizeDelta((rotationDelta[src] ?? 0) + delta);
      if (next === 0) delete rotationDelta[src];
      else rotationDelta[src] = next;
      changed = true;
    }
    if (!changed) return;
    set((s) => ({
      sessions: {
        ...s.sessions,
        [tabId]: { ...session, rotationDelta, undoStack: [...session.undoStack, snapshotOf(session)] },
      },
    }));
  },

  removePages: (tabId, sourceIndices) => {
    const session = get().sessions[tabId];
    if (!session || sourceIndices.length === 0) return;
    const removing = new Set(sourceIndices);
    const order = session.order.filter((src) => !removing.has(src));
    if (order.length === session.order.length) return;
    set((s) => ({
      sessions: {
        ...s.sessions,
        [tabId]: { ...session, order, undoStack: [...session.undoStack, snapshotOf(session)] },
      },
    }));
  },

  undo: (tabId) => {
    const session = get().sessions[tabId];
    if (!session || session.undoStack.length === 0) return false;
    const restore = session.undoStack[session.undoStack.length - 1];
    set((s) => ({
      sessions: {
        ...s.sessions,
        [tabId]: {
          ...session,
          order: restore.order,
          rotationDelta: restore.rotationDelta,
          undoStack: session.undoStack.slice(0, -1),
        },
      },
    }));
    return true;
  },

  clearSession: (tabId) =>
    set((s) => {
      if (!(tabId in s.sessions)) return {};
      const sessions = { ...s.sessions };
      delete sessions[tabId];
      return { sessions };
    }),
}));

/** 便捷读取：一个标签当前有效的组织快照（无会话返回空哨兵）。 */
export function organizeOf(tabId: string | null): OrganizeSnapshot {
  if (!tabId) return EMPTY_ORGANIZE;
  const session = useOrganizeStore.getState().sessions[tabId];
  return session ?? EMPTY_ORGANIZE;
}

/** 摘除一个标签的组织会话（openDocument.closeDocument 在标签关闭时调用）。 */
export function clearOrganizeSession(tabId: string): void {
  useOrganizeStore.getState().clearSession(tabId);
}
