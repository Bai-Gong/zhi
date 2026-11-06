import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import JSZip from 'jszip';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(root, 'node_modules/.cache'), { recursive: true });
const temp = await mkdtemp(path.join(root, 'node_modules/.cache/office-test-'));
const transpile = (s) => ts.transpileModule(s, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
try {
  for (const name of ['officeValidation', 'store']) {
    await writeFile(path.join(temp, `${name}.mjs`), transpile(await readFile(path.join(root, `src/core/document/${name}.ts`), 'utf8')));
  }
  const validation = await import(pathToFileURL(path.join(temp, 'officeValidation.mjs')));
  assert.equal(validation.documentFormatOf('/tmp/文档.DOCX'), 'docx');
  assert.equal(validation.documentFormatOf('/tmp/old.doc'), null);
  for (const [format, entry] of [['docx', 'word/document.xml'], ['xlsx', 'xl/workbook.xml'], ['pptx', 'ppt/presentation.xml']]) {
    const zip = new JSZip().file('[Content_Types].xml', '<Types/>').file(entry, '<document/>');
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    validation.validateOfficeBytes(bytes, format);
    assert.throws(() => validation.validateOfficeBytes(bytes, format === 'docx' ? 'xlsx' : 'docx'), /有效/);
    assert.throws(() => validation.validateOfficeBytes(bytes.slice(0, -1), format), /损坏/);
    const view = new DataView(bytes.buffer);
    const central = bytes.findIndex((_, i) => i + 4 <= bytes.length && view.getUint32(i, true) === 0x02014b50);
    view.setUint32(central + 24, 300 * 1024 * 1024, true);
    assert.throws(() => validation.validateOfficeBytes(bytes, format), /过大/);
  }
  validation.validateOfficeBytes(new TextEncoder().encode('名字,数量\n纸,2'), 'csv');
  assert.throws(() => validation.validateOfficeBytes(new Uint8Array([1, 0]), 'csv'), /二进制/);
  assert.throws(() => validation.validateOfficeBytes(new Uint8Array(), 'csv'), /为空/);

  await writeFile(path.join(temp, 'stubs.mjs'), `
export const open = async () => null;
export const readFile = async () => new Uint8Array([1]);
export const convertFileSrc = p => p;
export class InvalidPDFException extends Error {}
export class PasswordException extends Error {}
export const PDF_IMAGE_OPTIONS = {};
export const initPdfjs = () => {};
export const createDocumentWorker = () => ({port:{terminate(){globalThis.released++}},destroy(){}});
export const pdfjsLib = {getDocument({data}) {
  globalThis.loads++;
  if (data) structuredClone(data, {transfer:[data.buffer]});
  const doc = {numPages:1, async getPage(){return {getViewport(){return {width:100,height:200,rotation:0}}}}, async cleanup(){}};
  return {promise:Promise.resolve(doc), async destroy(){}};
}};
export const readOutline = async () => [];
export const renderQueue = {clear(){}};
export const addRecentFile = e => globalThis.recents.push(e);
export const clearOrganizeSession = () => {};
export const clearEditSession = () => {};
export { documentFormatOf, DOCUMENT_EXTENSIONS } from './officeValidation.mjs';
export const convertOfficeDocument = (...args) => globalThis.convert(...args);
`);
  let source = transpile(await readFile(path.join(root, 'src/core/document/openDocument.ts'), 'utf8'));
  source = source.replace(/from "([^"]+)"/g, (_, spec) => `from "${spec === './store' ? './store.mjs' : './stubs.mjs'}"`);
  await writeFile(path.join(temp, 'openDocument.mjs'), source);
  const { useDocumentStore: store } = await import(pathToFileURL(path.join(temp, 'store.mjs')));
  const { openDocument, closeDocument } = await import(pathToFileURL(path.join(temp, 'openDocument.mjs')));
  globalThis.loads = 0; globalThis.released = 0; globalThis.recents = [];
  const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
  const result = () => ({bytes:new Uint8Array([1,2,3]), pageCount:1, warnings:['基础预览']});
  let gate = deferred(); let control;
  globalThis.convert = async (_file, c) => { control = c; return gate.promise; };
  const pending = openDocument('/tmp/a.docx');
  await new Promise(r => setTimeout(r, 0));
  control.onStage('正在分页', .4);
  assert.equal(store.getState().tabs[0].loadingProgress, .4);
  await closeDocument();
  assert.equal(control.isCancelled(), true);
  gate.resolve(result()); await pending;
  assert.equal(globalThis.loads, 0);
  assert.equal(store.getState().tabs.length, 0);

  gate = deferred();
  const stale = openDocument('/tmp/a.xlsx');
  await new Promise(r => setTimeout(r, 0));
  const firstControl = control;
  const freshResult = result();
  globalThis.convert = async () => freshResult;
  const fresh = await openDocument('/tmp/a.xlsx', {encoding:'gb18030'});
  assert.equal(firstControl.isCancelled(), true);
  gate.resolve(result()); await stale;
  const tab = store.getState().tabs[0];
  assert.equal(tab.sourcePath, '/tmp/a.xlsx');
  assert.equal(tab.sourceFormat, 'xlsx');
  assert.equal(tab.status, 'ready');
  assert.equal(tab.generatedPdfBytes.byteLength, 3, 'pdf.js transfer must not detach export bytes');
  assert.deepEqual(tab.conversionWarnings, ['基础预览']);
  assert.equal(tab.loadingStage, null);
  assert.equal(fresh.tabId, tab.id);
  assert.equal(globalThis.loads, 1);
  assert.equal(globalThis.recents.length, 1);
  assert.equal(store.getState().addHighlight({pageNumber:1,rects:[{x:0,y:0,width:1,height:1}],color:'red'}), null);
  await closeDocument();
  assert.equal(globalThis.released, 1);
  assert.equal(store.getState().tabs.length, 0);
  // Encoding is part of the tab, not toolbar component state; reopen and restart preserve it.
  const storage = new Map();
  globalThis.window = {localStorage:{getItem:k => storage.get(k) ?? null, setItem:(k,v) => storage.set(k,v), removeItem:k=>storage.delete(k)}, setTimeout, clearTimeout, addEventListener(){}};
  const sessionSource = transpile(await readFile(path.join(root, 'src/core/document/sessionRestore.ts'), 'utf8')).replaceAll('"./store"', '"./store.mjs"');
  await writeFile(path.join(temp, 'sessionRestore.mjs'), sessionSource);
  const {loadLastSession} = await import(pathToFileURL(path.join(temp, 'sessionRestore.mjs')));
  let capturedOptions;
  globalThis.convert = async (_file, _control, options) => {capturedOptions = options; return result();};
  await openDocument('/tmp/中文.csv', {encoding:'gb18030'});
  assert.equal(store.getState().tabs[0].officeOptions.encoding, 'gb18030');
  assert.equal(loadLastSession().tabs[0].officeOptions.encoding, 'gb18030');
  await openDocument('/tmp/中文.csv');
  assert.equal(capturedOptions.encoding, 'gb18030');
  const snapshot = loadLastSession();
  await closeDocument();
  const {openDocumentsBatch} = await import(pathToFileURL(path.join(temp, 'openDocument.mjs')));
  await openDocumentsBatch(snapshot.tabs.map(t=>t.path), snapshot.tabs);
  assert.equal(capturedOptions.encoding, 'gb18030');
  await openDocument('/tmp/中文.csv', {encoding:'utf-8'});
  assert.equal(store.getState().tabs[0].officeOptions.encoding, 'utf-8');
  await closeDocument();
  storage.set('zhi.lastSession', JSON.stringify({tabs:[{path:'/tmp/legacy.pdf',page:2,scale:1}],activePath:null}));
  assert.equal(loadLastSession().tabs[0].officeOptions, undefined);
  console.log('PASS: Office validation, resource limits, cancellation, stale reopen, buffer ownership, worker cleanup, encoding persistence and legacy sessions');
} finally { await rm(temp, {recursive:true,force:true}); }
