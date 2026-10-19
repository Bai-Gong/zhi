// pdf.js 唯一封装与 worker 初始化（全应用唯一入口，技术方案 6.1）。
// pdfjs-dist 只允许在 src/core/document 内 import（技术方案 4.3 规则 1），
// 其他模块一律经本文件 re-export 的符号与 core 暴露的接口使用 pdf.js。
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
// 方案 A（首选）：Vite 把 worker 打为独立 chunk，每份文档各自实例化。
import PdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker";
// 方案 B（兜底）：worker 以 URL 形式交给 pdf.js 自行 new Worker。
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

let inited = false;

/**
 * 懒初始化（应用生命周期内只执行一次有效逻辑）：预置方案 B 的 workerSrc，
 * 供 worker chunk 构造不可用时按 URL 自建 worker 的路径使用。
 * 注意：**不再设置全局共享的 `GlobalWorkerOptions.workerPort`**——多标签模型下
 * 每份文档必须持有专属 worker（见 {@link createDocumentWorker}）。
 */
export function initPdfjs(): void {
  if (inited) return;
  inited = true;
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
}

/**
 * 为一份文档创建**专属** pdf.js worker（多标签的隔离单元，M2-计划 D1）。
 *
 * 为什么不能像 M1 那样共用一个 workerPort：pdf.js v6 的
 * `PDFDocumentLoadingTask.destroy()` 结尾会 `this._worker?.destroy()`——经全局
 * workerPort 装载的所有任务拿到的是**同一个**缓存的 PDFWorker 实例，关闭任意
 * 一个标签都会把共用 worker 连同其余标签的文档一并终止。改为每文档一个 worker
 * 后，销毁自己的装载任务即同时回收自己的 worker 线程与文档侧资源，标签间互不波及。
 *
 * 构造失败（Vite/环境异常）时退回方案 B：不传 port，PDFWorker 按 workerSrc
 * 自行 new Worker（同样每文档一个，语义等价）；再失败则由 pdf.js 内部退回
 * 主线程伪 worker（可用但卡，与 M1 行为一致）。
 */
export function createDocumentWorker(): pdfjsLib.PDFWorker {
  initPdfjs();
  try {
    return pdfjsLib.PDFWorker.create({ port: new PdfjsWorker() });
  } catch {
    return pdfjsLib.PDFWorker.create({});
  }
}

export { pdfjsLib };
// 供 openDocument / renderQueue 做错误分类与取消判定（均为类型+运行时值）。
export {
  InvalidPDFException,
  PasswordException,
  PasswordResponses,
  RenderingCancelledException,
} from "pdfjs-dist/legacy/build/pdf.mjs";
