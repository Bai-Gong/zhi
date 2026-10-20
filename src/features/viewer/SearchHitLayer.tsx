import { useEffect, useState } from "react";
import clsx from "clsx";
import { getHitRects, type HitRect } from "../../core/document";
import { useDocumentStore } from "../../core/document/store";

/**
 * 页内命中覆盖层（M2 全文搜索，里程碑验收 1）：本页全部命中的半透明高亮 +
 * 当前命中的闪烁标识。
 * - 矩形由 core 的 getHitRects 计算（与文本层/画布同 viewport 语义；本模块
 *   零 pdfjs-dist import，技术方案 4.3 规则 1）；
 * - 缩放契约：传 store.scale（请求缩放），实际 cssScale 以 core 封顶为准
 *   （8192 光栅封顶，与页框同源）；
 * - 仅随可见页挂载（与 PageCanvas 同条件），矩形只对已挂载页计算，DOM 有界；
 * - pointer-events:none，不碍文本选择。
 */
export function SearchHitLayer({ pageNumber }: { pageNumber: number }) {
  const scale = useDocumentStore((s) => s.scale);
  const results = useDocumentStore((s) => s.searchResults);
  const activeResultId = useDocumentStore((s) => s.activeSearchResultId);
  const revealSeq = useDocumentStore((s) => s.searchReveal?.seq ?? 0);

  const [rects, setRects] = useState<Array<{ id: string; rect: HitRect }>>([]);

  useEffect(() => {
    const hits = results.filter((result) => result.pageNumber === pageNumber);
    if (hits.length === 0) {
      setRects((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    let cancelled = false;
    void getHitRects(
      pageNumber,
      hits.map((hit) => ({ start: hit.start, end: hit.end })),
      scale,
    )
      .then(({ rects: rectsPerRange }) => {
        if (cancelled) return;
        const flat: Array<{ id: string; rect: HitRect }> = [];
        rectsPerRange.forEach((segments, i) => {
          for (const rect of segments) flat.push({ id: hits[i].id, rect });
        });
        setRects(flat);
      })
      .catch((error: unknown) => {
        if (!cancelled) console.warn(`第 ${pageNumber} 页命中矩形计算失败：`, error);
      });
    return () => {
      cancelled = true;
    };
  }, [results, pageNumber, scale]);

  if (rects.length === 0) return null;
  return (
    <div className="viewer-hit-layer" aria-hidden>
      {rects.map(({ id, rect }, index) => (
        <span
          // revealSeq 参与 key：重复点击同一结果时强制重挂载以重播闪烁动画。
          key={`${id}:${index}:${id === activeResultId ? revealSeq : 0}`}
          className={clsx("search-hit", { "search-hit-flash": id === activeResultId })}
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        />
      ))}
    </div>
  );
}
