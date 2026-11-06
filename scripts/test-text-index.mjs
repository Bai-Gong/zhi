import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import ts from 'typescript';

// Exercise the real store and indexing service with deterministic PDF proxies.
const root = fileURLToPath(new URL('../', import.meta.url));
const cache = path.join(root, 'node_modules/.cache');
await mkdir(cache, { recursive: true });
const temp = await mkdtemp(path.join(cache, 'text-index-test-'));
try {
  for (const name of ['store', 'textIndex']) {
    const source = await readFile(path.join(root, `src/core/document/${name}.ts`), 'utf8');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    });
    await writeFile(path.join(temp, `${name}.mjs`), outputText.replaceAll('"./store"', '"./store.mjs"'));
  }
  const { useDocumentStore } = await import(pathToFileURL(path.join(temp, 'store.mjs')));
  const { ensureTabTextIndex, ensurePageTextIndex, searchTextIndex, getTabTextIndexStats } =
    await import(pathToFileURL(path.join(temp, 'textIndex.mjs')));

  const calls = new Map();
  let failSecondPage = true;
  const doc = {
    numPages: 3,
    async getPage(page) {
      calls.set(page, (calls.get(page) ?? 0) + 1);
      return { async getTextContent() {
        if (page === 2 && failSecondPage) throw new Error('Expected transient parse failure');
        return { items: page === 3 ? [] : [
          { str: 'needle', width: 60, transform: [10, 0, 0, 10, 0, 0], hasEOL: false },
        ] };
      } };
    },
  };
  const tab = { id: 'one', status: 'ready', document: doc, numPages: 3, loadGeneration: 1 };
  useDocumentStore.setState({ tabs: [tab], activeTabId: tab.id });
  const search = (scope = { kind: 'all' }) => searchTextIndex({ tabId: 'one', query: 'needle', scope });
  assert.equal((await ensureTabTextIndex({ tabId: 'one' }).done).status, 'ready');
  assert.equal(search().complete, false);
  assert.equal(search().hits.length, 1);
  assert.equal(search({ kind: 'page', pageNumber: 2 }).complete, false);
  assert.equal(search({ kind: 'page', pageNumber: 2 }).hasText, false);
  assert.deepEqual(getTabTextIndexStats('one'), { built: 2, total: 3 });
  assert.equal(search({ kind: 'page', pageNumber: 3 }).complete, true);
  assert.equal(search({ kind: 'page', pageNumber: 3 }).hasText, false);

  failSecondPage = false;
  await ensureTabTextIndex({ tabId: 'one' }).done;
  assert.equal(search().complete, true);
  assert.equal(search().hasText, true);
  assert.equal(search().hits.length, 2);
  assert.deepEqual([...calls], [[1, 1], [2, 2], [3, 1]]);
  assert.deepEqual(getTabTextIndexStats('one'), { built: 3, total: 3 });

  // A single-page request before a full build must not skip earlier pages.
  useDocumentStore.setState({ tabs: [{ ...tab, loadGeneration: 2 }] });
  calls.clear();
  assert.equal(await ensurePageTextIndex('one', 3), true);
  assert.deepEqual(getTabTextIndexStats('one'), { built: 1, total: 3 });
  await ensureTabTextIndex({ tabId: 'one' }).done;
  assert.deepEqual([...calls], [[3, 1], [1, 1], [2, 1]]);
  assert.equal(search().complete, true);

  // Closing a tab while parsing invalidates both the in-flight build and results.
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const delayedDoc = { numPages: 1, async getPage() {
    return { async getTextContent() { await pending; return { items: [] }; } };
  } };
  useDocumentStore.setState({ tabs: [{ ...tab, document: delayedDoc, numPages: 1, loadGeneration: 3 }] });
  const handle = ensureTabTextIndex({ tabId: 'one' });
  useDocumentStore.setState({ tabs: [] });
  release();
  assert.equal((await handle.done).status, 'cancelled');
  assert.equal(search(), null);
  console.log('PASS: retry, partial results, scanned pages, single-page cache, and tab cancellation');
} finally {
  await rm(temp, { recursive: true, force: true });
}
