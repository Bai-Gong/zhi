// node scripts/ppt-tests.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
const load = (path, dependencies, globals = {}) => {
  const exports = {};
  const source = fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, {
    exports, TextDecoder, Uint8Array, DataView, DOMParser, require: name => { assert.ok(name in dependencies, name); return dependencies[name]; }, ...globals,
  });
  return exports;
};
const validation = load('src/core/document/officeValidation.ts', {});
const { parsePresentationBytes } = load('src/core/document/convertPresentation.ts', { jszip: JSZip, 'html2canvas-pro': {}, 'pdf-lib': {}, './highlightExport': {}, './convertCommon': {}, './officeValidation': validation });
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export async function fixture() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('ppt/presentation.xml', `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst><p:sldId id="256" r:id="r2"/><p:sldId id="257" r:id="r1"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Target="slides/slide1.xml" Type="${R}/slide"/><Relationship Id="r2" Target="slides/slide2.xml" Type="${R}/slide"/></Relationships>`);
  zip.file('ppt/slides/slide1.xml', `<p:sld xmlns:p="${P}" show="false"><p:cSld><p:spTree/></p:cSld></p:sld>`);
  zip.file('ppt/slides/slide2.xml', `<p:sld xmlns:p="${P}"><p:cSld><p:spTree/></p:cSld></p:sld>`);
  return zip;
}
const zip = await fixture();
const bytes = await zip.generateAsync({ type: 'uint8array' });
const pkg = await parsePresentationBytes(bytes);
assert.equal(pkg.width, 1280); assert.equal(pkg.height, 720);
assert.equal(pkg.slides[0].path, 'ppt/slides/slide2.xml');
assert.equal(pkg.slides[0].hidden, false); assert.equal(pkg.slides[1].hidden, true);
await assert.rejects(() => parsePresentationBytes(new Uint8Array([0,1,2])), /Office/);
const wrong = await fixture(); wrong.remove('ppt/presentation.xml'); wrong.file('word/document.xml', '<document/>');
await assert.rejects(() => wrong.generateAsync({type:'uint8array'}).then(parsePresentationBytes), /PPTX/);
const external = await fixture();
external.file('ppt/_rels/presentation.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r2" Target="https://example.test/slide.xml" TargetMode="External" Type="${R}/slide"/></Relationships>`);
await assert.rejects(() => external.generateAsync({type:'uint8array'}).then(parsePresentationBytes), /引用已损坏/);
const tooLarge = await fixture(); tooLarge.file('ppt/presentation.xml', `<p:presentation xmlns:p="${P}"><p:sldSz cx="99999999999" cy="6858000"/></p:presentation>`);
await assert.rejects(() => tooLarge.generateAsync({type:'uint8array'}).then(parsePresentationBytes), /尺寸/);
const encrypted = bytes.slice(); const view = new DataView(encrypted.buffer);
for (let i = 0; i < encrypted.length - 46; i++) if (view.getUint32(i, true) === 0x02014b50) { view.setUint16(i + 8, 1, true); break; }
await assert.rejects(() => parsePresentationBytes(encrypted), /加密/);
console.log('PPT parser checks passed: original slide order/size/hidden pages, invalid format, external links, oversized pages, encryption.');
