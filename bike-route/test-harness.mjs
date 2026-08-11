// Headless test harness for the Bike Route plugin.
// Loads the REAL index.js with a minimal DOM + fetch shim, activates the
// plugin against a fake app, then simulates clicking "Plan route" with real
// API calls and asserts the resulting DOM/metrics are sane.
//
// Run: node test-harness.mjs   (Node 22+; uses global fetch)

// ---- minimal DOM shim ------------------------------------------------------
let idSeq = 0;
function makeEl(tag) {
  const node = {
    tagName: tag,
    _children: [],
    _handlers: {},
    className: "",
    textContent: "",
    value: "",
    type: "",
    title: "",
    placeholder: "",
    disabled: false,
    innerHTML: "",
    style: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); if (node.className) node.className += " " + c; else node.className = c; },
      remove(c) { this._set.delete(c); },
      toggle(c, f) { if (f === undefined) f = !this._set.has(c); f ? this._set.add(c) : this._set.delete(c); return f; },
      contains(c) { return this._set.has(c); },
    },
    setAttribute(k, v) { if (k === "class") this.className = v; },
    appendChild(c) { this._children.push(c); return c; },
    append(...cs) { cs.forEach((c) => this._children.push(c)); },
    addEventListener(ev, fn) { (this._handlers[ev] ||= []).push(fn); },
    removeEventListener() {},
    querySelector(sel) {
      const cls = sel.replace(".", "");
      return findEl(this, (n) => (n.className || "").split(" ").includes(cls));
    },
    click() { (this._handlers.click || []).forEach((fn) => fn({})); },
  };
  return node;
}
function findEl(root, pred) {
  for (const c of root._children || []) {
    if (pred(c)) return c;
    const r = findEl(c, pred);
    if (r) return r;
  }
  return null;
}

const documentShim = {
  createElement: (t) => makeEl(t),
  createElementNS: (ns, t) => makeEl(t),
};

const windowShim = {
  maplibregl: {
    Marker: class { constructor() {} setLngLat() { return this; } addTo() { return this; } setPopup() { return this; } remove() {} },
    LngLatBounds: class { constructor(c) { this._c = c; } extend() { return this; } },
    Popup: class { constructor() {} setHTML() { return this; } },
  },
};

const fakeMap = {
  on() {}, off() {}, getCanvas() { return { style: {} }; },
  getCenter() { return { lng: 13.3777, lat: 52.5169 }; },
  fitBounds() {}, addSource() {}, addLayer() {},
  getSource() { return null; }, getLayer() { return null; }, flyTo() {},
};

const fakeApp = {
  addMapControl() { return true; },
  removeMapControl() {},
  registerRightPanel(panel) { fakeApp._render = panel.render; return () => {}; },
  openRightPanel() {},
  registerToolbarMenu() { return () => {}; },
};

// Wire globals before importing the module.
globalThis.document = documentShim;
globalThis.window = windowShim;

const mod = await import("./index.js?" + Date.now());
const plugin = mod.plugin || mod.default;
if (!plugin) throw new Error("module did not export a plugin");

// ---- activate ---------------------------------------------------------------
const ok = plugin.activate(fakeApp);
console.assert(ok !== false, "activate returned false");
console.log("activate:", ok === false ? "FAILED" : "ok");
console.assert(plugin.id === "geolibre-bike-route", "plugin id");
console.assert(plugin.name === "Bike Route", "plugin name");

// Render the panel body into a container.
const container = makeEl("div");
fakeApp._render(container);

// Find the run button by its label.
const runBtn = findEl(container, (n) => n.textContent === "Plan route");
console.assert(runBtn, "run button not found");
console.log("panel built, run button:", runBtn ? "found" : "MISSING");

// Pre-fill start/end inputs.
const inputs = [];
(function collect(n) { for (const c of n._children || []) { if (c.tagName === "input") inputs.push(c); collect(c); } })(container);
console.assert(inputs.length >= 2, "expected >=2 inputs");
inputs[0].value = "13.4132, 52.5220";
inputs[1].value = "13.3777, 52.5169";

// Click "Plan route" and let the async pipeline run against the live APIs.
console.log("running live route…");
runBtn.click();
await new Promise((r) => setTimeout(r, 12000));

// Inspect the overview tab content.
const overview = findEl(container, (n) => n.className === "bike-tab-content");
// The first tab-content is overview; walk to find stat values.
const statValues = [];
(function collect(n) { for (const c of n._children || []) { if (c.className === "bike-stat-value") statValues.push(c.textContent); collect(c); } })(container);
console.log("overview stats:", statValues.join(" | "));

const turns = findEl(container, (n) => n.className === "bike-turns");
console.log("turn-by-turn steps:", turns ? turns._children.length : 0);

const diff = findEl(container, (n) => n.className === "bike-diff-badge");
console.log("difficulty badge:", diff ? diff.textContent : "n/a");

const chart = findEl(container, (n) => n.className === "bike-elev-chart");
console.log("elevation chart rendered:", chart ? "yes" : "no");

// Assertions on real data
const distance = statValues[0] || "";
console.assert(/km|m/.test(distance), "distance formatted");
console.log("\nRESULT:", distance ? "pipeline produced a route" : "NO ROUTE");

// Clean shutdown
plugin.deactivate(fakeApp);
console.log("deactivate: ok");
console.log("TEST COMPLETE");
