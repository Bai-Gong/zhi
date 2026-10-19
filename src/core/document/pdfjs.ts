// pdf.js 唯一封装与 worker 初始化（全应用唯一入口，技术方案 6.1）。
// pdfjs-dist 只允许在 src/core/document 内 import（技术方案 4.3 规则 1），
// 其他模块一律经本文件 re-export 的符号与 core 暴露的接口使用 pdf.js。
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
// 方案 A（首选）：Vite 把 worker 打为独立 chunk，主线程只持端口。
import PdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker";
// 方案 B（兜底）：worker 以 URL 形式交给 pdf.js 自行 new Worker。
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

let inited = false;

/**
 * 懒初始化 pdf.js worker（应用生命周期内只执行一次有效逻辑）。
 * 先尝试方案 A 的 workerPort；构造失败（Vite/环境异常）自动退回
 * 方案 B 的 workerSrc，两条路径语义等价（技术方案 6.1）。
 */
export function initPdfjs(): void {
  if (inited) return;
  inited = true;
  try {
    pdfjsLib.GlobalWorkerOptions.workerPort = new PdfjsWorker();
  } catch {
    // worker 构造失败时 pdf.js 会退回主线程伪 worker（可用但卡），
    // 这里仍显式给出 workerSrc，尽可能保住真 worker。
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
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
