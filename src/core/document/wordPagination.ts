import html2canvas from "html2canvas-pro";
import { PDFDocument } from "pdf-lib";
import { throwIfCancelled, type ConvertControl } from "./convertCommon";
import { planBoundaries, TAIL_EPSILON_PX, type AtomicBox } from "./convertLayout";

/**
 * Word→PDF 的「HTML → 自研分页 DOM → html2canvas-pro 截图 → pdf-lib 成册」
 * 管线（M6，模块 5；技术方案 2.1 第 4 行链路）。定位「基础版式转换」：
 * 保留标题/正文/图片/简单表格，复杂版式（艺术字/文本框等）由 mammoth 丢弃
 * 并在结果里计数提示。
 *
 * 分页算法（连续排版 + 窗口裁切 + 边界吸附）：
 * 1. mammoth 的 HTML 在固定宽度（= 页宽 − 左右边距，1px=1pt）的离屏容器里
 *    连续排版——不做「把元素搬进一页页容器」的 DOM 移动，天然零拆散风险；
 * 2. 量取全部「原子盒」（每个文本节点的逐行矩形 + 图片/分隔线矩形）；
 * 3. 每 pageContentH 一个候选切点，若切点切进任何原子盒（跨盒即切字），
 *    把切点上移到该盒顶（吸附到行首）；比 MIN_SLICE 还矮说明有整页高的
 *    大盒（大图/长表），退化为硬切（内容仍连续保留在相邻页）；
 * 4. 逐页 html2canvas 以 {x, y, width, height} 窗口截取容器对应区段，
 *    2 倍光栅保证清晰度，pdf-lib 按文档自带页面几何逐页嵌入。
 *
 * 模块边界：html2canvas-pro / pdf-lib 只在 src/core/document；
 * 本文件不入桶导出，消费方直接 from。
 */

/**
 * 页面几何：全部取自 .docx 自带的页面设置（docxPageSetup 解析；解析失败由
 * 调用方兜底），Word→PDF 不再让用户选纸型/边距——「设置一致」即此意。
 */
export interface WordPageGeometry {
  /** 页宽/页高（pt）。 */
  widthPt: number;
  heightPt: number;
  /** 四边距（pt）。 */
  marginTopPt: number;
  marginRightPt: number;
  marginBottomPt: number;
  marginLeftPt: number;
}

/** Word→PDF 分页选项。 */
export interface WordToPdfOptions {
  geometry: WordPageGeometry;
}

/** 分页产出的度量信息（结果页展示用）。 */
export interface WordToPdfMeasure {
  pageCount: number;
  /** mammoth 报告的不支持内容条数（复杂版式降级提示的依据）。 */
  ignoredCount: number;
}

/** 离屏容器挂在 body 下的类名（样式随容器内 <style> 注入，克隆时一并带走）。 */
const HOST_CLASS = "zhi-w2p-host";

/** 容器基础样式 + mammoth 产物的排版规则（全部显式指定，不依赖应用主题）。 */
const HOST_CSS = `
.${HOST_CLASS} {
  position: absolute;
  left: -30000px;
  top: 0;
  overflow: hidden;
  background: #ffffff;
  color: #1a1a1a;
  font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "SimSun", sans-serif;
  font-size: 12pt;
  line-height: 1.5;
  z-index: -1;
}
.${HOST_CLASS} * { box-sizing: border-box; }
.${HOST_CLASS} p { margin: 0 0 0.45em; }
.${HOST_CLASS} h1, .${HOST_CLASS} h2, .${HOST_CLASS} h3,
.${HOST_CLASS} h4, .${HOST_CLASS} h5, .${HOST_CLASS} h6 {
  margin: 0.9em 0 0.4em;
  line-height: 1.3;
}
.${HOST_CLASS} h1 { font-size: 1.7em; }
.${HOST_CLASS} h2 { font-size: 1.4em; }
.${HOST_CLASS} h3 { font-size: 1.2em; }
.${HOST_CLASS} ul, .${HOST_CLASS} ol { margin: 0 0 0.45em; padding-left: 1.6em; }
.${HOST_CLASS} img { max-width: 100%; height: auto; }
.${HOST_CLASS} table { width: 100%; border-collapse: collapse; margin: 0.4em 0; }
.${HOST_CLASS} td, .${HOST_CLASS} th { border: 1px solid #9a9a9a; padding: 3px 6px; word-break: break-word; }
.${HOST_CLASS} a { color: #0563c1; }
`;

/** 等待容器内全部图片解码完成（布局尺寸依赖图片高度，未加载完测量会失真）。 */
function waitForImages(root: HTMLElement): Promise<void> {
  const images = Array.from(root.querySelectorAll("img"));
  return Promise.all(
    images.map(
      (img) =>
        new Promise<void>((resolve) => {
          if (img.complete) {
            void img.decode().then(
              () => resolve(),
              () => resolve(),
            );
            return;
          }
          const settle = () => resolve();
          img.addEventListener("load", settle, { once: true });
          img.addEventListener("error", settle, { once: true });
        }),
    ),
  ).then(() => undefined);
}

/** 收集容器内全部原子盒：文本节点逐行矩形 + 图片/分隔线元素盒。 */
function collectAtomicBoxes(host: HTMLElement): AtomicBox[] {
  const hostTop = host.getBoundingClientRect().top;
  const boxes: AtomicBox[] = [];
  const push = (top: number, bottom: number) => {
    if (bottom - top < 0.5) return; // 亚像素盒（空行等）不参与吸附
    boxes.push({ top, bottom });
  };
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    if (text.trim().length === 0) continue;
    range.selectNode(node);
    for (const rect of range.getClientRects()) {
      push(rect.top - hostTop, rect.bottom - hostTop);
    }
  }
  // 图片与分隔线没有文本行盒，单独补。
  host.querySelectorAll("img, hr").forEach((element) => {
    const rect = element.getBoundingClientRect();
    push(rect.top - hostTop, rect.bottom - hostTop);
  });
  boxes.sort((a, b) => a.top - b.top);
  return boxes;
}

/**
 * 执行分页与成册：html（mammoth 产物）→ PDF 字节。
 * 进度经 control 上报（截图阶段逐页推进），取消在页间安全点生效。
 */
export async function paginateWordHtml(
  html: string,
  options: WordToPdfOptions,
  control: ConvertControl,
  ignoredCount: number,
): Promise<{ bytes: Uint8Array } & WordToPdfMeasure> {
  const g = options.geometry;
  const contentW = Math.max(120, g.widthPt - g.marginLeftPt - g.marginRightPt);
  const contentH = Math.max(120, g.heightPt - g.marginTopPt - g.marginBottomPt);

  const host = document.createElement("div");
  host.className = HOST_CLASS;
  host.style.width = `${contentW}px`;
  const style = document.createElement("style");
  style.textContent = HOST_CSS;
  const content = document.createElement("div");
  content.innerHTML = html; // mammoth 产物为受控 HTML（内置标签白名单），非用户任意标记
  host.append(style, content);
  document.body.appendChild(host);
  try {
    control.onStage("正在排版内容…", null);
    await waitForImages(content);
    // 两帧后测量：等样式应用与图片布局稳定。
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const totalHeight = Math.ceil(host.scrollHeight);
    if (totalHeight <= 0) throw new Error("文档内容为空，无法转换。");
    const boxes = collectAtomicBoxes(host);
    const boundaries = planBoundaries(totalHeight, contentH, boxes);
    const slices: { top: number; height: number }[] = [];
    let y = 0;
    for (const cut of [...boundaries, totalHeight]) {
      slices.push({ top: y, height: cut - y });
      y = cut;
    }
    // 末尾碎片段（纯余量）并入上一页。
    if (slices.length > 1 && slices[slices.length - 1].height < TAIL_EPSILON_PX) slices.pop();

    const pdf = await PDFDocument.create();
    for (let i = 0; i < slices.length; i += 1) {
      throwIfCancelled(control);
      const slice = slices[i];
      control.onStage(`正在逐页生成…（${i + 1}/${slices.length}）`, i / slices.length);
      // 窗口截取：x/y 相对容器边界（html2canvas-pro 实测语义：(opts.x ?? 0) + 元素 left）。
      const canvas = await html2canvas(host, {
        x: 0,
        y: slice.top,
        width: Math.ceil(contentW),
        height: Math.ceil(slice.height),
        scale: 2,
        backgroundColor: "#ffffff",
        logging: false,
      });
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("页面截图导出失败。"))),
          "image/png",
        );
      });
      const png = await pdf.embedPng(new Uint8Array(await blob.arrayBuffer()));
      const page = pdf.addPage([g.widthPt, g.heightPt]);
      // 内容顶对齐到页面上边距：视觉上等价 Word 的页边距分页。
      page.drawImage(png, {
        x: g.marginLeftPt,
        y: g.heightPt - g.marginTopPt - slice.height,
        width: contentW,
        height: slice.height,
      });
    }
    control.onStage("正在生成 PDF 文件…", null);
    const bytes = await pdf.save();
    control.onStage("转换完成。", 1);
    return { bytes, pageCount: slices.length, ignoredCount };
  } finally {
    host.remove();
  }
}
