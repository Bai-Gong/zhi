import { create } from "zustand";
import { makeEditObjectId, type EditImageAsset, type EditObject } from "./editModel";

/**
 * 基础编辑会话 store（M5，模块 5）：编辑视图（features/edit）操作中的内存
 * 对象模型——每页的补丁对象（文本遮盖/新文本、图片）+ 会话图片字节表 +
 * 撤销/重做栈。导出由 editExport 消费本 store 生成新文件，原文件不动。
 *
 * 隔离与生命周期：与 organizeStore 同款「标签 id + 装载代际」键控——
 * 文档重开后旧编辑整体作废重建；标签关闭由 openDocument.closeDocument 调
 * clearEditSession 摘除（含 objectUrl.revokeObjectURL）。
 *
 * 撤销/重做（验收 M5-4，≥20 步）：全量快照双栈（UNDO_LIMIT=50），只快照
 * **对象数组**（结构化纯数据），图片字节经 srcId 引用不随快照拷贝。
 * 一步的语义由调用方用 beginStep/liveUpdate/endStep（拖拽等连续交互）或
 * step（离散修改）表达；redo 栈随任何新修改清空（step/endStep 提交时与
 * liveUpdate 首帧三处同口径）。
 *
 * 选中集合是纯 UI 瞬态，留在编辑视图组件内，不入 store（与 organize 同例）。
 */

/** 撤销/重做栈深度上限（验收口径 ≥20，留余量取 50）。 */
export const EDIT_UNDO_LIMIT = 50;

/** 一份可撤销的编辑状态快照：对象数组的深拷贝。 */
export interface EditSnapshot {
  objects: readonly EditObject[];
}

interface EditSession {
  /** 建立会话时的装载代际；与标签当前 loadGeneration 不符即过期。 */
  generation: number;
  objects: readonly EditObject[];
  /** 图片字节表（objectUrl 生命周期归本会话管理）。 */
  images: Record<string, EditImageAsset>;
  /** 撤销栈（后进先出）；每项是**变更前**的快照。 */
  undoStack: EditSnapshot[];
  /** 重做栈；undo 时把当前状态压入，任何新步骤清空。 */
  redoStack: EditSnapshot[];
  /** 进行中一步（beginStep 已记、尚未 endStep）的起始快照；null = 无进行中步骤。 */
  pendingBefore: EditSnapshot | null;
}

interface EditStoreState {
  sessions: Record<string, EditSession>;
  /** 取一个标签的编辑会话；不存在或代际不符时按当前文档**重建**（清空旧编辑——
   *  文档已被重开，旧对象不再可信；旧图片 objectUrl 一并回收）。 */
  ensureSession: (tabId: string, generation: number) => EditSession;
  /** 原子步骤：快照旧状态压撤销栈、清重做栈，再应用变更（离散修改用）。 */
  step: (tabId: string, mutator: (objects: EditObject[]) => EditObject[]) => void;
  /** 连续交互三段式：beginStep 记起点快照（已有进行中步骤则保持首个）， */
  beginStep: (tabId: string) => void;
  /** liveUpdate 只改当前状态不进栈（拖拽/输入的每一帧），但 redo 栈随首帧清空。 */
  liveUpdate: (tabId: string, mutator: (objects: EditObject[]) => EditObject[]) => void;
  /** endStep 提交：状态确实变化才把起点快照入栈；未变则丢弃。 */
  endStep: (tabId: string) => boolean;
  /** 登记一张图片字节（生成 objectUrl，会话关闭时统一回收）；返回 srcId。 */
  putImage: (tabId: string, bytes: Uint8Array, format: "png" | "jpg") => string;
  /** 撤销；无可撤销返回 false。 */
  undo: (tabId: string) => boolean;
  /** 重做；无可重做返回 false。 */
  redo: (tabId: string) => boolean;
  /** 摘除会话（标签关闭/文档重开时调用；回收全部 objectUrl）。 */
  clearSession: (tabId: string) => void;
}

/** 对象数组深拷贝（结构化纯数据，JSON 往返足够且天然断引用）。 */
function cloneObjects(objects: readonly EditObject[]): EditObject[] {
  return JSON.parse(JSON.stringify(objects)) as EditObject[];
}

function sameObjects(a: readonly EditObject[], b: readonly EditObject[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function blankSession(generation: number): EditSession {
  return { generation, objects: [], images: {}, undoStack: [], redoStack: [], pendingBefore: null };
}

/** 释放会话持有的全部 objectUrl（重复 revoke 无害）。 */
function releaseImages(session: EditSession): void {
  for (const asset of Object.values(session.images)) {
    try {
      URL.revokeObjectURL(asset.objectUrl);
    } catch {
      /* 浏览器环境异常不拖垮会话清理 */
    }
  }
}

export const useEditStore = create<EditStoreState>((set, get) => ({
  sessions: {},

  ensureSession: (tabId, generation) => {
    const existing = get().sessions[tabId];
    if (existing && existing.generation === generation) return existing;
    if (existing) releaseImages(existing);
    const session = blankSession(generation);
    set((s) => ({ sessions: { ...s.sessions, [tabId]: session } }));
    return session;
  },

  step: (tabId, mutator) => {
    const session = get().sessions[tabId];
    if (!session) return;
    const before: EditSnapshot = { objects: cloneObjects(session.objects) };
    const objects = mutator(cloneObjects(session.objects));
    if (sameObjects(before.objects, objects)) return;
    set((s) => ({
      sessions: {
        ...s.sessions,
        [tabId]: {
          ...session,
          objects,
          undoStack: [...session.undoStack.slice(-(EDIT_UNDO_LIMIT - 1)), before],
          redoStack: [],
        },
      },
    }));
  },

  beginStep: (tabId) => {
    const session = get().sessions[tabId];
    if (!session || session.pendingBefore) return; // 连续交互嵌套时保持首帧快照
    set((s) => ({
      sessions: { ...s.sessions, [tabId]: { ...session, pendingBefore: { objects: cloneObjects(session.objects) } } },
    }));
  },

  liveUpdate: (tabId, mutator) => {
    const session = get().sessions[tabId];
    if (!session) return;
    set((s) => ({
      // redo 随任何新修改失效（与 step/endStep 同口径）：拖拽/输入的第一帧就清，
      // 不等 endStep——若交互中途被打断（未走到 endStep），redo 也不复活旧分支。
      sessions: { ...s.sessions, [tabId]: { ...session, objects: mutator(cloneObjects(session.objects)), redoStack: [] } },
    }));
  },

  endStep: (tabId) => {
    const session = get().sessions[tabId];
    if (!session) return false;
    const before = session.pendingBefore;
    if (!before) return false;
    if (sameObjects(before.objects, session.objects)) {
      set((s) => ({ sessions: { ...s.sessions, [tabId]: { ...session, pendingBefore: null } } }));
      return false;
    }
    set((s) => ({
      sessions: {
        ...s.sessions,
        [tabId]: {
          ...session,
          pendingBefore: null,
          undoStack: [...session.undoStack.slice(-(EDIT_UNDO_LIMIT - 1)), before],
          redoStack: [],
        },
      },
    }));
    return true;
  },

  putImage: (tabId, bytes, format) => {
    const session = get().sessions[tabId];
    if (!session) return "";
    const srcId = makeEditObjectId();
    // Blob 构造需要 ArrayBuffer 视图（TS 5.7+ 泛型区分）：复制到新缓冲，类型与运行时双保险。
    const view = new Uint8Array(bytes.length);
    view.set(bytes);
    const asset: EditImageAsset = {
      bytes,
      format,
      objectUrl: URL.createObjectURL(new Blob([view.buffer], { type: `image/${format}` })),
    };
    set((s) => ({
      sessions: { ...s.sessions, [tabId]: { ...session, images: { ...session.images, [srcId]: asset } } },
    }));
    return srcId;
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
          objects: cloneObjects(restore.objects),
          undoStack: session.undoStack.slice(0, -1),
          redoStack: [...session.redoStack, { objects: cloneObjects(session.objects) }],
          pendingBefore: null, // 进行中的交互步骤被撤销打断，丢弃其起点
        },
      },
    }));
    return true;
  },

  redo: (tabId) => {
    const session = get().sessions[tabId];
    if (!session || session.redoStack.length === 0) return false;
    const restore = session.redoStack[session.redoStack.length - 1];
    set((s) => ({
      sessions: {
        ...s.sessions,
        [tabId]: {
          ...session,
          objects: cloneObjects(restore.objects),
          redoStack: session.redoStack.slice(0, -1),
          undoStack: [...session.undoStack.slice(-(EDIT_UNDO_LIMIT - 1)), { objects: cloneObjects(session.objects) }],
          pendingBefore: null,
        },
      },
    }));
    return true;
  },

  clearSession: (tabId) =>
    set((s) => {
      const session = s.sessions[tabId];
      if (!session) return {};
      releaseImages(session);
      const sessions = { ...s.sessions };
      delete sessions[tabId];
      return { sessions };
    }),
}));

/** 摘除一个标签的编辑会话（openDocument.closeDocument 在标签关闭时调用）。 */
export function clearEditSession(tabId: string): void {
  useEditStore.getState().clearSession(tabId);
}
