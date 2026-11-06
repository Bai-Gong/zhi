// Run with: node scripts/test-archive-ui.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function load(file, dependencies = {}, globals = {}) {
  const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(output, {
    exports,
    require(name) {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    ...globals,
  }, { filename: file });
  return exports;
}
const bridge = load("src/features/viewer/scrollBridge.ts");
let fits = 0;
const unregister = bridge.registerFitWidthHandler(() => fits++);
bridge.requestFitWidth();
assert.equal(fits, 1);
assert.equal(bridge.isAutoFit(), true);
bridge.clearAutoFit();
assert.equal(bridge.isAutoFit(), false);
unregister();
bridge.requestFitWidth();
assert.equal(fits, 1, "Unmounted viewer must not receive fit requests");
bridge.clearAutoFit();

const listeners = new Map();
const window = {
  location: { hash: "#/viewer" },
  getSelection: () => null,
  addEventListener: (name, handler, capture = false) => listeners.set(`${name}:${capture}`, handler),
  removeEventListener: (name, _handler, capture = false) => listeners.delete(`${name}:${capture}`),
};
let scale = 1;
let immersive = true;
const state = { setScale: (value) => { scale = value; } };
const ui = { get immersive() { return immersive; }, setImmersive: (value) => { immersive = value; } };
const hotkeys = load("src/shell/hotkeys.ts", {
  "../core/document": {
    activeTabOf: () => ({ scale, numPages: 3, currentPage: 1 }),
    useDocumentStore: { getState: () => state },
  },
  "./routes": {},
  "./uiStore": { useUiStore: { getState: () => ui } },
  "../features/viewer/scrollBridge": bridge,
  "../features/viewer/pageGeometry": { clampScale: (value) => value, ZOOM_STEP: 1.1 },
}, {
  window,
  document: { documentElement: { dataset: {} } },
  Element: class {},
});
const uninstall = hotkeys.installHotkeys(() => {});
function event(overrides) {
  return { key: "=", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false,
    isComposing: false, defaultPrevented: false, target: null,
    preventDefault() { this.defaultPrevented = true; }, ...overrides };
}
bridge.requestFitWidth();
listeners.get("keydown:false")(event({ isComposing: true }));
assert.equal(scale, 1, "IME composition must not zoom");
assert.equal(bridge.isAutoFit(), true, "IME composition must not cancel fit mode");
listeners.get("keydown:true")(event({ key: "Escape", ctrlKey: false, isComposing: true }));
assert.equal(immersive, true, "IME Escape must not exit immersive mode");
listeners.get("keydown:false")(event({}));
assert.equal(scale, 1.1);
assert.equal(bridge.isAutoFit(), false, "Manual zoom must cancel automatic fitting");
listeners.get("keydown:true")(event({ key: "Escape", ctrlKey: false }));
assert.equal(immersive, false);
uninstall();
assert.equal(listeners.size, 0, "Listeners must be removed on cleanup");
console.log("Archive UI regression checks passed");
