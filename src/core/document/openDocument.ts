import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { initPdfjs, pdfjsLib, createDocumentWorker, InvalidPDFException, PasswordException } from "./pdfjs";
import { useDocumentStore, activeTabOf, MAX_TABS, type PageSize } from "./store";
import { readOutline } from "./outline";
import { renderQueue } from "./renderQueue";
import { addRecentFile } from "./recentFiles";
import { clearOrganizeSession } from "./organizeStore";
import { clearEditSession } from "./editStore";

/**
 * 打开文件全流程（技术方案 5.1 / 2.3，M2-计划 D1 多标签模型）：
 * 对话框选文件 → convertFileSrc 转 asset 协议 URL → pdf.js 装载；
 * asset 路径失败自动走 plugin-fs.readFile 兜底，两条路径收敛在同一接口后面。
 * 装载成功后读取全部页尺寸与书签树写入标签会话，并登记最近文件。
 *
 * 多标签语义：
 * - 打开文件 = 新建标签并激活；**同一路径的标签已存在时原地重开**（递增其
 *   loadGeneration、销毁其旧文档后重载）——保持 M1「同一路径直接重开刷新会话」
 *   的行为，也避免无标签条 UI 阶段产生不可见的重复标签持有整份文档。
 * - 标签上限 {@link MAX_TABS}：超出时不新建，返回可读错误并写入 store 的
 *   openRejection（查看器横幅提示），既有标签一概不动。
 * - 过期装载只按「该标签自己的 loadGeneration + 标签是否仍在」判定，丢弃结果
 *   不波及其他标签（也不销毁别人的文档）。
 */

/**
 * 弹出「打开 PDF」对话框；用户取消返回 null，对话框插件异常原样抛出
 * （调用方决定如何提示——首页展示错误、查看器侧记录日志）。
 */
export async function pickPdfFile(): Promise<string | null> {
  const selected = await openFileDialog({
    multiple: false,
    directory: false,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  return typeof selected === "string" ? selected : null;
}

/**
 * 多选版「打开 PDF」对话框（Acrobat 式多标签）：一次可选多个文件，
 * 用户取消返回 null。单选也返回单元素数组——单选/多选的**语义分叉归调用方**
 * （单选沿用既有「同激活路径原地重开 / navigate 带 path」语义，见 hotkeys.openPickedPdf；
 * 多选才走批量器 openDocumentsBatch）。组织/编辑入口仍用单选 pickPdfFile（单文档模式）。
 */
export async function pickPdfFiles(): Promise<string[] | null> {
  const selected = await openFileDialog({
    multiple: true,
    directory: false,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (selected === null) return null;
  // multiple:true 时插件恒返回 string[]；Array.isArray 防御插件行为差异（单元素等）。
  return Array.isArray(selected) ? selected : [selected];
}

function fileNameOf(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

/**
 * 一次装载的回收句柄：装载任务 + 其专属 worker 与底层 port。
 * 为什么必须把 worker 一并持有：pdf.js v6 对**调用方传入**的 worker 不赋
 * `task._worker`，`task.destroy()` 内的 `this._worker?.destroy()` 恒 no-op；
 * 而 `PDFWorker.destroy()` 只 terminate 自建的 #webWorker（经外部 port 构造的
 * PDFWorker 没有它）——core 不亲手回收，每开关一个标签（或一次失败装载）
 * 都净泄漏一个常驻 worker 线程（M2-6「无泄漏趋势」不成立）。
 */
interface LoadEntry {
  task: PDFDocumentLoadingTask;
  worker: pdfjsLib.PDFWorker;
  /** 创建即取的底层 port 引用（PDFWorker.destroy 会把 port 置 null，必须先存）。 */
  port: Worker | null;
}

/** 进行中的装载，按标签隔离：不同标签允许并行装载，互不销毁对方的任务。 */
const activeLoads = new Map<string, LoadEntry>();

/** 全局销毁链：任何一次 pdf.js destroy 都登记在此，后续装载必须先等它落地。 */
let lastTeardown: Promise<void> = Promise.resolve();

/** pdf.js v6 的文档销毁走装载任务（PDFDocumentProxy 无 destroy），此处登记映射。 */
const docLoads = new WeakMap<PDFDocumentProxy, LoadEntry>();

/** 把一次销毁/清理 Promise 接到全局销毁链上（链本身永不 reject）。 */
function chainTeardown(op: Promise<void>): Promise<void> {
  lastTeardown = Promise.all([lastTeardown, op]).then(
    () => undefined,
    () => undefined,
  );
  return op;
}

/**
 * 销毁一次装载并显式回收其专属 worker；失败只记日志不抛出（worker 照样回收——
 * 宁可放弃优雅握手也不留泄漏线程）。destroy 幂等，重复调用安全。
 * 顺序必须先 `task.destroy()` 落地再动 worker：文档销毁内部要经 transport 向
 * worker 发 "Terminate" 并等回应，先杀线程会让应答永远等不到。
 */
function destroyLoadingTask(entry: LoadEntry | null, what: string): Promise<void> {
  if (!entry) return Promise.resolve();
  const release = () => releaseDocumentWorker(entry);
  return entry.task.destroy().then(release, (error: unknown) => {
    console.warn(`${what}失败：`, error);
    release();
  });
}

/**
 * 显式 terminate 专属 worker 的底层线程：`worker.destroy()` 只清主线程侧的
 * 消息处理器与 port 缓存（经外部 port 构造的 PDFWorker 没有 #webWorker 可
 * terminate），真正关线程要靠 `port.terminate()`。port 为 null 仅出现在
 * workerSrc 自建 worker 尚未 ready 的窗口——那条路径的 #webWorker 有值，
 * destroy 自会 terminate，跳过即无泄漏。
 */
function releaseDocumentWorker(entry: LoadEntry): void {
  try {
    entry.worker.destroy();
    entry.port?.terminate();
  } catch (error: unknown) {
    console.warn("回收 pdf.js 专属 worker 失败：", error);
  }
}

/**
 * 销毁一份已装载文档：终止其网络请求并回收其**专属 worker**（每文档一个，
 * 见 pdfjs.createDocumentWorker；worker 由 destroyLoadingTask 显式回收——v6
 * 不会代为 terminate 调用方传入的 worker）；失败只记日志不抛出。
 * pdf.js 的销毁是异步两段式（置 _pendingDestroy → 传输层销毁完成后清除），
 * 故每次销毁都登记进全局链，由 openDocument 在装载前统一 await，
 * 保证销毁次序确定、新一轮装载不与未落地的销毁叠峰。
 */
function destroyDocument(doc: PDFDocumentProxy | null): Promise<void> {
  if (!doc) return Promise.resolve();
  const entry = docLoads.get(doc);
  const op = entry
    ? destroyLoadingTask(entry, "销毁 pdf.js 文档")
    : doc.cleanup().then(undefined, (error: unknown) => console.warn("清理 pdf.js 文档失败：", error));
  return chainTeardown(op);
}

/** 把 pdf.js / Tauri 插件的底层错误翻译成面向用户的中文提示。 */
function describeError(error: unknown, source: "asset" | "fs"): string {
  if (error instanceof PasswordException) {
    return "文件已加密：暂不支持打开受密码保护的 PDF。";
  }
  if (error instanceof InvalidPDFException) {
    return "文件已损坏或不是有效的 PDF 文档。";
  }
  const raw = error instanceof Error ? error.message : String(error);
  if (/forbidden|not allowed|权限|scope/i.test(raw)) {
    return "无权读取该文件：请检查应用文件系统授权（fs scope）是否覆盖该路径。";
  }
  if (/no such file|not found|找不到|不存在/i.test(raw)) {
    return "找不到文件，可能已被移动或删除。";
  }
  return `无法打开文件（${source === "asset" ? "asset 协议" : "文件系统"}路径）：${raw}`;
}

/** 发起一次装载：专属 worker + 装载任务登记；失败/被终止时回收 worker 防泄漏。 */
async function startLoad(
  params: { url: string } | { data: Uint8Array },
  tabId: string,
): Promise<PDFDocumentProxy> {
  const worker = createDocumentWorker();
  // port 引用在创建后立即取走：装载失败/文档销毁时靠它显式 terminate 线程
  //（v6 不会回收调用方传入的 worker，见 LoadEntry 注释），而 destroy 后取不到。
  const entry: LoadEntry = {
    task: pdfjsLib.getDocument({ ...params, worker }),
    worker,
    port: worker.port,
  };
  activeLoads.set(tabId, entry);
  try {
    const doc = await entry.task.promise;
    docLoads.set(doc, entry);
    return doc;
  } catch (error) {
    // 失败或被终止的装载同样要回收：destroyLoadingTask 会连带 terminate 其
    // 专属 worker，否则每次失败的打开都会泄漏一个 Worker 线程。
    void destroyLoadingTask(entry, "回收失败的装载任务");
    throw error;
  } finally {
    if (activeLoads.get(tabId) === entry) activeLoads.delete(tabId);
  }
}

/** 主路径：asset 协议 URL 流式装载（技术方案 2.3，零拷贝、支持大文件）。 */
async function loadFromUrl(url: string, tabId: string): Promise<PDFDocumentProxy> {
  return startLoad({ url }, tabId);
}

/** 兜底路径：plugin-fs 读字节后装载（需 capabilities 的 fs:allow-read-file + "**" scope）。 */
async function loadFromBytes(path: string, tabId: string): Promise<PDFDocumentProxy> {
  const data = await readFile(path);
  return startLoad({ data }, tabId);
}

/** 分批读取全部页尺寸（已按旋转归一为显示方向的宽高），批大小 8 防 worker 洪泛。 */
async function readPageSizes(doc: PDFDocumentProxy, numPages: number, isStale: () => boolean): Promise<PageSize[]> {
  const sizes: PageSize[] = new Array<PageSize>(numPages);
  const BATCH = 8;
  for (let start = 1; start <= numPages; start += BATCH) {
    if (isStale()) throw new Error("文档已切换，放弃装载页尺寸");
    const end = Math.min(start + BATCH - 1, numPages);
    const pages = await Promise.all(
      Array.from({ length: end - start + 1 }, (_, i) => doc.getPage(start + i)),
    );
    for (let i = 0; i < pages.length; i += 1) {
      const viewport = pages[i].getViewport({ scale: 1 });
      sizes[start + i - 1] = {
        width: viewport.width,
        height: viewport.height,
        rotation: viewport.rotation,
      };
    }
  }
  return sizes;
}

/**
 * openDocument 的结果：error 与 tabId 分开携带，调用方可按**显式标签 id**
 * 寻址回写（装载 await 期间激活位可能被用户切走，不能再按激活位回写）。
 */
export interface OpenDocumentResult {
  /**
   * 本轮 beginLoadTab 选中的标签 id（新建与同路径重开均有值）；
   * 请求被拒绝（未指定路径 / 标签超上限，未建标签）时为 null。
   */
  tabId: string | null;
  /**
   * null 表示装载已正常开始/完成（含被更新一轮装载抢先而丢弃的结果）；
   * 非 null 为可读错误（已写入该标签错误态或 store.openRejection），均不抛出。
   */
  error: string | null;
}

/**
 * 打开文档：新建标签（或重开同路径标签）并装载，成功后写入会话与最近文件。
 * 返回 {@link OpenDocumentResult}：`error` 非 null 表示请求被拒绝（未指定路径 /
 * 标签达到上限）或装载失败——失败同时写入该标签的错误态，拒绝则写入
 * store.openRejection（横幅提示）；`tabId` 供调用方对**本标签**做后续回写
 * （如会话恢复的页码/缩放），不受装载期间激活位漂移影响。
 */
export async function openDocument(path: string): Promise<OpenDocumentResult> {
  if (!path) {
    const message = "未指定要打开的文件。";
    useDocumentStore.getState().rejectOpen(message);
    return { tabId: null, error: message };
  }
  const fileName = fileNameOf(path);
  const state = useDocumentStore.getState();
  // 同路径标签本轮重开（不受上限约束）；只有「新文件 + 已满」才被拒绝。
  const existing = state.tabs.find((t) => t.sourcePath === path);
  if (!existing && state.tabs.length >= MAX_TABS) {
    const message = `打开的文档标签已达上限（${MAX_TABS} 个），请先关闭部分标签再打开新文件。`;
    useDocumentStore.getState().rejectOpen(message);
    return { tabId: null, error: message };
  }
  // 收集本轮要销毁的资源：只限目标标签自己的旧装载任务与旧文档，
  // 其他标签（含其正在进行的装载）一概不动——多标签并存的根基。
  const previousLoad = existing ? activeLoads.get(existing.id) ?? null : null;
  if (existing) activeLoads.delete(existing.id);
  const previousDoc = existing?.document ?? null;
  const priorTeardown = lastTeardown;
  // 目标标签即将激活：清空渲染队列（旧激活标签的画面全部作废，查看器随
  // activeTabId 变化重挂载并按新标签重新入队）。
  renderQueue.clear();
  // 先开启新会话（beginLoadTab 递增目标标签的 loadGeneration 使其旧结果立即过期）。
  const tabId = useDocumentStore.getState().beginLoadTab(path, fileName);
  const generation = useDocumentStore.getState().tabs.find((t) => t.id === tabId)?.loadGeneration ?? 0;
  // 过期判定只看本标签：标签已被关闭、或被同一路径的更新一轮重开抢先。
  const isStale = () => {
    const tab = useDocumentStore.getState().tabs.find((t) => t.id === tabId);
    return !tab || tab.loadGeneration !== generation;
  };
  initPdfjs();
  // 等待上一轮销毁（含其专属 worker 的 terminate）完全落地再发起本轮装载：
  // 销毁是异步两段式，未落地就开新一轮会与回收中的资源叠峰（M1 实测过的坑，
  // 每文档独立 worker 后风险面缩小，但兜底路径仍共享全局 workerSrc 状态，保持等待）。
  await Promise.all([
    priorTeardown,
    chainTeardown(destroyLoadingTask(previousLoad, "终止上一轮装载")),
    destroyDocument(previousDoc),
  ]);

  let doc: PDFDocumentProxy | null = null;
  let lastError: unknown = null;
  let lastErrorSource: "asset" | "fs" = "asset";
  try {
    doc = await loadFromUrl(convertFileSrc(path), tabId);
  } catch (error) {
    lastError = error;
    console.warn("asset 协议装载失败，转文件系统兜底：", error);
  }
  if (!doc && !isStale()) {
    try {
      doc = await loadFromBytes(path, tabId);
    } catch (error) {
      lastError = error;
      lastErrorSource = "fs";
    }
  }

  if (isStale()) {
    // 目标标签已被更新的装载抢先或已关闭：本轮结果丢弃（只丢这一份文档）。
    void destroyDocument(doc);
    return { tabId, error: null };
  }
  if (!doc) {
    const message = describeError(lastError, lastErrorSource);
    useDocumentStore.getState().failTab(tabId, message);
    return { tabId, error: message };
  }

  try {
    const [pageSizes, outline] = await Promise.all([
      readPageSizes(doc, doc.numPages, isStale),
      readOutline(doc),
    ]);
    if (isStale()) {
      void destroyDocument(doc);
      return { tabId, error: null };
    }
    useDocumentStore.getState().readyTab(tabId, {
      document: doc,
      numPages: doc.numPages,
      pageSizes,
      outline,
    });
    addRecentFile({ path, fileName, numPages: doc.numPages });
    return { tabId, error: null };
  } catch (error) {
    void destroyDocument(doc);
    if (isStale()) {
      // 已被更新的装载抢先：标签归新会话所有，不再写入本轮错误。
      return { tabId, error: null };
    }
    const message = error instanceof Error ? `装载文档信息失败：${error.message}` : "装载文档信息失败。";
    useDocumentStore.getState().failTab(tabId, message);
    return { tabId, error: message };
  }
}

/** 批量打开时随路径携带的会话恢复信息（T7 会话恢复）：装载成功后回写页码/缩放。 */
export interface BatchRestoreHint {
  /** 1 起页码（超界由 setCurrentPage 按页数夹取）。 */
  page: number;
  /** 0.25–4.0（超界由 setScale 夹取）。 */
  scale: number;
}

/** 把恢复信息回写到指定标签（缺省为当前激活标签）；非 ready 态忽略。 */
function applyRestoreHint(hint: BatchRestoreHint | undefined, tabId?: string): void {
  if (!hint) return;
  const state = useDocumentStore.getState();
  const id = tabId ?? state.activeTabId;
  if (!id) return;
  // readyTab 会先重置为第 1 页/100%，恢复写入必须发生在其后（openDocument resolve
  // 之后或 activateTab 之后调用本函数即满足）；失败/装载中标签无可恢复会话。
  // 装载 await 期间激活位可能被用户切走，必须按本轮 tabId 寻址而非激活位。
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab || tab.status !== "ready") return;
  state.setCurrentPage(hint.page, id);
  state.setScale(hint.scale, id);
}

/**
 * 批量打开（多选对话框 / 会话恢复共用）：逐个处理路径——
 * - 已打开的路径**仅激活**既有标签（不重置其页码/缩放/高亮会话，多选语义与
 *   单选的「同路径原地重开」分叉点）；
 * - 新路径串行 `await openDocument`（标签逐个出现即是装载过程反馈）；
 * - 达到 {@link MAX_TABS} 后剩余新文件不再尝试（openDocument 的逐次拒绝
 *   提示会被 beginLoadTab 清空，必须由这里聚合），装载失败的文件名同样聚合；
 * - 全部结束后**一次性** rejectOpen 汇总未打开的文件与原因——beginLoadTab
 *   每次都清 openRejection（store），逐个提示必被下一次装载吞掉。
 * 最终激活的是最后处理的标签。`restores` 与路径一一对应（可 undefined），
 * 供会话恢复回写每份文档的页码/缩放。
 */
export async function openDocumentsBatch(
  paths: readonly string[],
  restores?: ReadonlyArray<BatchRestoreHint | undefined>,
): Promise<void> {
  if (paths.length === 0) return;
  const failures: string[] = [];
  let capped = false;
  for (let i = 0; i < paths.length; i += 1) {
    const path = paths[i];
    if (!path) continue;
    const fileName = fileNameOf(path);
    const existing = useDocumentStore.getState().tabs.find((t) => t.sourcePath === path);
    if (existing) {
      // 多选「已开仅激活」：保留其页码/缩放/高亮，不重置、不重开。
      useDocumentStore.getState().activateTab(existing.id);
      applyRestoreHint(restores?.[i], existing.id);
      continue;
    }
    if (capped || useDocumentStore.getState().tabs.length >= MAX_TABS) {
      capped = true;
      failures.push(`${fileName}：标签已达上限（${MAX_TABS} 个）`);
      continue;
    }
    const { tabId, error } = await openDocument(path);
    if (error) {
      // 装载失败的文件已由 failTab 置「打开失败」标签（保留 sourcePath 可见可重试），
      // 这里只聚合文件名与原因进最终横幅。
      failures.push(`${fileName}：${error}`);
    } else if (tabId) {
      applyRestoreHint(restores?.[i], tabId);
    }
  }
  if (failures.length > 0) {
    useDocumentStore
      .getState()
      .rejectOpen(`批量打开：${failures.length} 个文件未能打开——${failures.join("；")}。`);
  }
}

/**
 * 关闭一个标签会话（缺省为激活标签）：取消该标签全部渲染、终止其进行中的装载、
 * 销毁其 pdf.js 文档，然后从 store 摘除标签并移交激活位。
 *
 * 内存释放口径（任务 D1「杜绝内存泄漏」在 pdf.js v6 的落地）：
 * - 页级：渲染过的页由 PageCanvas 卸载时已逐页 `page.cleanup()`（虚拟化离屏即回收），
 *   关闭标签时查看器重挂载会再走一轮卸载清理；
 * - 文档级：PDFDocumentProxy 在 v6 无 destroy，销毁经其装载任务 `task.destroy()`
 *   （终止网络请求、释放字体等文档级资源），随后 destroyLoadingTask 显式
 *   `worker.destroy()` + `port.terminate()` 回收该文档的专属 worker 线程
 *   （v6 对调用方传入的 worker 不会代为 terminate，见 LoadEntry 注释），
 *   并接入全局销毁链。
 * 返回的 Promise 在销毁落地后 resolve——紧接着重开同一文件时也应 await（或依赖
 * openDocument 内部的全局销毁链等待）。
 */
export async function closeDocument(tabId?: string): Promise<void> {
  const state = useDocumentStore.getState();
  const id = tabId ?? state.activeTabId;
  if (!id) return;
  const tab = state.tabs.find((t) => t.id === id);
  const load = activeLoads.get(id) ?? null;
  activeLoads.delete(id);
  // 组织会话（M3）随标签一并丢弃（纯数据，无 pdf.js 资源）。
  clearOrganizeSession(id);
  // 编辑会话（M5）同摘：回收图片 objectUrl 与撤销栈。
  clearEditSession(id);
  // 只有关闭激活标签才清渲染队列：非激活标签没有画面在队列里，
  // 清了会误杀当前激活标签的在途渲染，页面会留白。
  if (state.activeTabId === id) renderQueue.clear();
  useDocumentStore.getState().closeTab(id);
  await Promise.all([
    chainTeardown(destroyLoadingTask(load, "终止进行中的装载")),
    destroyDocument(tab?.document ?? null),
  ]);
}

/** 取激活标签文档的指定页（1 起）；无会话文档时抛错。供 viewer 直接取页对象。 */
export async function getPage(pageNumber: number): Promise<PDFPageProxy> {
  const { document } = activeTabOf(useDocumentStore.getState());
  if (!document) throw new Error("尚未打开文档");
  return document.getPage(pageNumber);
}
