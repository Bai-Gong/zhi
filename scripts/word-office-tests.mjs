// Start Vite on port 1431, then run node scripts/word-office-tests.mjs.
// Optional: VITE_TEST_ORIGIN, PLAYWRIGHT_MODULE (module path), BROWSER_EXECUTABLE, WORD_TEST_SCREENSHOT.
import assert from 'node:assert/strict';
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, ImageRun } from 'docx';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.VITE_TEST_ORIGIN || 'http://127.0.0.1:1431';
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
  await page.route(`${origin}/`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body style="margin:0;background:white"></body></html>' }));
  const remoteRequests = [];
  await page.route('https://office-test.invalid/**', route => { remoteRequests.push(route.request().url()); return route.abort(); });
  await page.goto(origin);
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 180; canvas.height = 80;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fcba55'; ctx.fillRect(0, 0, 180, 80); ctx.fillStyle = '#356cd8'; ctx.fillRect(15, 15, 150, 50);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const doc = new Document({ sections: [{ properties: { page: { size: { width: 11906, height: 16838 } } }, children: [
    new Paragraph({ children: [new TextRun({ text: '百工·纸 Word 阅读回归', bold: true, size: 36 })] }),
    new Paragraph('中文正文、图片和跨页表格应正常显示。'),
    new Paragraph({ children: [new ImageRun({ type: 'png', data: Buffer.from(image, 'base64'), transformation: { width: 180, height: 80 } })] }),
    new Table({ rows: Array.from({ length: 70 }, (_, i) => new TableRow({ children: [new TableCell({ children: [new Paragraph(`第 ${i + 1} 行`)] }), new TableCell({ children: [new Paragraph(`中文表格内容 ${i + 1}`)] })] })) }),
  ] }] });
  const bytes = [...await Packer.toBuffer(doc)];
  await page.route('**/src/core/document/highlightExport.ts*', route => route.fulfill({ contentType: 'application/javascript', body: `export function sameDiskPath(a,b){return a===b} export async function readSourceBytes(){return new Uint8Array(${JSON.stringify(bytes)})}` }));
  const result = await page.evaluate(async ({ image }) => {
    const { sanitizeWordHtml, runWordToPdf } = await import('/src/core/document/convertWord.ts');
    const input = `<p onclick="window.__unsafe=1">安全中文</p><a href="javascript:window.__unsafe=2">链接文字</a><img src="https://office-test.invalid/image.png" alt="外部图片"><img src="data:image/png;base64,${image}" srcset="https://office-test.invalid/srcset.png 2x" onload="window.__unsafe=3"><div style="background:url(https://office-test.invalid/background.png)">正文</div><iframe src="https://office-test.invalid/frame"></iframe><script>window.__unsafe=4</script><svg><image href="https://office-test.invalid/svg.png"/></svg>`;
    const sanitized = sanitizeWordHtml(input);
    const check = document.createElement('div'); check.innerHTML = sanitized.html; document.body.append(check);
    await Promise.all([...check.querySelectorAll('img')].map(img => img.decode()));
    const safe = !check.querySelector('[href],[srcset],[style],[onclick],[onload],script,iframe,svg') && !window.__unsafe;
    const retained = check.querySelectorAll('img').length === 1 && check.textContent.includes('安全中文') && check.textContent.includes('链接文字') && check.textContent.includes('外部图片');
    check.remove();
    const output = await runWordToPdf({ path: '/word-regression.docx', fileName: 'word-regression.docx' }, { onStage: () => {}, isCancelled: () => false });
    const { PDFDocument } = await import('/node_modules/.vite/deps/pdf-lib.js');
    const pdf = await PDFDocument.load(output.bytes);
    const leaked = document.querySelectorAll('.zhi-w2p-host').length;
    const { pdfjsLib, initPdfjs } = await import('/src/core/document/pdfjs.ts'); initPdfjs();
    const rendered = await pdfjsLib.getDocument({ data: output.bytes }).promise;
    const first = await rendered.getPage(1); const viewport = first.getViewport({ scale: 1 });
    const canvas = document.createElement('canvas'); canvas.width = viewport.width; canvas.height = viewport.height; document.body.append(canvas);
    await first.render({ canvas, viewport }).promise;
    return { safe, retained, removed: sanitized.removed, pages: output.pageCount, pdfPages: pdf.getPageCount(), leaked, geometry: output.pageSetup.geometry, ignoredCount: output.ignoredCount };
  }, { image });
  assert.equal(result.safe, true); assert.equal(result.retained, true); assert.ok(result.removed >= 4);
  assert.equal(remoteRequests.length, 0, `Unexpected network requests: ${remoteRequests}`);
  assert.ok(result.pages >= 2); assert.equal(result.pages, result.pdfPages); assert.equal(result.leaked, 0);
  assert.ok(Math.abs(result.geometry.widthPt - 595.3) < 1);
  if (process.env.WORD_TEST_SCREENSHOT) await page.screenshot({ path: process.env.WORD_TEST_SCREENSHOT });
  console.log(JSON.stringify({ ...result, remoteRequests: remoteRequests.length }, null, 2));
} finally { await browser.close(); }
