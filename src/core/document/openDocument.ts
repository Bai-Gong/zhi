import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { initPdfjs, pdfjsLib, InvalidPDFException, PasswordException } from "./pdfjs";
import { useDocumentStore, type PageSize } from "./store";
import { readOutline } from "./outline";
import { renderQueue } from "./renderQueue";
import { addRecentFile } from "./recentFiles";

/**
 * 打开文件全流程（技术方案 5.1 / 2.3）：
 * 对话框选文件 → convertFileSrc 转 asset 协议 URL → pdf.js 装载；
 * asset 路径失败自动走 plugin-fs.readFile 兜底，两条路径收敛在同一接口后面。
 * 装载成功后读取全部页尺寸与书签树写入 store，并登记最近文件。
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

function fileNameOf(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

/** 进行中的装载任务（新一轮 openDocument 会先销毁它，防止双开竞写 store）。 */
let activeLoad: PDFDocumentLoadingTask | null = null;

/** 全局销毁链：任何一次 pdf.js destroy 都登记在此，后续装载必须先等它落地。 */
let lastTeardown: Promise<void> = Promise.resolve();

/** pdf.js v6 的文档销毁走装载任务（PDFDocumentProxy 无 destroy），此处登记映射。 */
const docTasks = new WeakMap<PDFDocumentProxy, PDFDocumentLoadingTask>();

/** 把一次销毁/清理 Promise 接到全局销毁链上（链本身永不 reject）。 */
function chainTeardown(op: Promise<void>): Promise<void> {
  lastTeardown = Promise.all([lastTeardown, op]).then(
    () => undefined,
    () => undefined,
  );
  return op;
}

/** 销毁一个装载任务；失败只记日志不抛出。 */
function destroyLoadingTask(task: PDFDocumentLoadingTask | null, what: string): Promise<void> {
  if (!task) return Promise.resolve();
  return task.destroy().then(undefined, (error: unknown) => console.warn(`${what}失败：`, error));
}

/**
 * 销毁一份已装载文档：终止其网络请求与 worker；失败只记日志不抛出。
 * 全应用共用同一 workerPort——销毁在 pdf.js 内是异步两段式（置 _pendingDestroy →
 * 传输层销毁完成后清除），未落地前发起下一次 getDocument 会触发
 * `PDFWorker.create - the worker is being destroyed` 守卫，故每次销毁都
 * 登记进全局链，由 openDocument 在装载前统一 await。
 */
function destroyDocument(doc: PDFDocumentProxy | null): Promise<void> {
  if (!doc) return Promise.resolve();
  const task = docTasks.get(doc);
  const op = task
    ? destroyLoadingTask(task, "销毁 pdf.js 文档")
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

/** 主路径：asset 协议 URL 流式装载（技术方案 2.3，零拷贝、支持大文件）。 */
async function loadFromUrl(url: string): Promise<PDFDocumentProxy> {
  const task = pdfjsLib.getDocument({ url });
  activeLoad = task;
  try {
    const doc = await task.promise;
    docTasks.set(doc, task);
    return doc;
  } finally {
    if (activeLoad === task) activeLoad = null;
  }
}

/** 兜底路径：plugin-fs 读字节后装载（需 capabilities 的 fs:allow-read-file + "**" scope）。 */
async function loadFromBytes(path: string): Promise<PDFDocumentProxy> {
  const data = await readFile(path);
  const task = pdfjsLib.getDocument({ data });
  activeLoad = task;
  try {
    const doc = await task.promise;
    docTasks.set(doc, task);
    return doc;
  } finally {
    if (activeLoad === task) activeLoad = null;
  }
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
 * 打开文档并写入会话 store 与最近文件。失败收敛为 store 错误态（不抛出）；
 * 装载期间又被新一次 openDocument 抢先时，本轮结果静默丢弃。
 */
export async function openDocument(path: string): Promise<void> {
  if (!path) {
    useDocumentStore.getState().fail("未指定要打开的文件。");
    return;
  }
  const fileName = fileNameOf(path);
  // 收集本轮要销毁的对象：进行中的装载任务 + 旧会话文档。
  const previousLoad = activeLoad;
  activeLoad = null;
  renderQueue.clear();
  const previousDoc = useDocumentStore.getState().document;
  const priorTeardown = lastTeardown;
  // 先开启新会话（beginLoad 递增 loadGeneration 使旧结果立即过期），UI 即刻进入 loading。
  useDocumentStore.getState().beginLoad(path, fileName);
  const generation = useDocumentStore.getState().loadGeneration;
  const isStale = () => useDocumentStore.getState().loadGeneration !== generation;
  initPdfjs();
  // 共用 workerPort 的硬约束：必须等上一轮 destroy 完全落地（_pendingDestroy 清除）
  // 才能发起下一次 getDocument，否则 asset 主路径必被 pdf.js 守卫拒绝。
  await Promise.all([
    priorTeardown,
    chainTeardown(destroyLoadingTask(previousLoad, "终止上一轮装载")),
    destroyDocument(previousDoc),
  ]);

  let doc: PDFDocumentProxy | null = null;
  let lastError: unknown = null;
  let lastErrorSource: "asset" | "fs" = "asset";
  try {
    doc = await loadFromUrl(convertFileSrc(path));
  } catch (error) {
    lastError = error;
    console.warn("asset 协议装载失败，转文件系统兜底：", error);
  }
  if (!doc && !isStale()) {
    try {
      doc = await loadFromBytes(path);
    } catch (error) {
      lastError = error;
      lastErrorSource = "fs";
    }
  }

  if (isStale()) {
    // 已被更新的 openDocument 抢先：本轮结果丢弃。
    void destroyDocument(doc);
    return;
  }
  if (!doc) {
    useDocumentStore.getState().fail(describeError(lastError, lastErrorSource));
    return;
  }

  try {
    const [pageSizes, outline] = await Promise.all([
      readPageSizes(doc, doc.numPages, isStale),
      readOutline(doc),
    ]);
    if (isStale()) {
      void destroyDocument(doc);
      return;
    }
    useDocumentStore.getState().ready({
      document: doc,
      numPages: doc.numPages,
      pageSizes,
      outline,
    });
    addRecentFile({ path, fileName, numPages: doc.numPages });
  } catch (error) {
    void destroyDocument(doc);
    if (isStale()) {
      // 已被更新的 openDocument 抢先：store 归新会话所有，不再写入本轮错误。
      return;
    }
    useDocumentStore.getState().fail(
      error instanceof Error ? `装载文档信息失败：${error.message}` : "装载文档信息失败。",
    );
  }
}

/**
 * 关闭当前文档会话：取消全部渲染、销毁 pdf.js 文档、复位 store。
 * 返回的 Promise 在销毁落地后 resolve——紧接着重开同一文件时也应 await（或依赖
 * openDocument 内部的全局销毁链等待）。
 */
export async function closeDocument(): Promise<void> {
  renderQueue.clear();
  const load = activeLoad;
  activeLoad = null;
  const doc = useDocumentStore.getState().document;
  useDocumentStore.getState().close();
  await Promise.all([
    chainTeardown(destroyLoadingTask(load, "终止进行中的装载")),
    destroyDocument(doc),
  ]);
}

/** 取当前会话文档的指定页（1 起）；无会话文档时抛错。供 viewer 直接取页对象。 */
export async function getPage(pageNumber: number): Promise<PDFPageProxy> {
  const { document } = useDocumentStore.getState();
  if (!document) throw new Error("尚未打开文档");
  return document.getPage(pageNumber);
}
