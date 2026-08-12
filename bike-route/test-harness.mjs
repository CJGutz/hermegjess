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
  _sources: {}, _layers: {},
  on() {}, off() {}, getCanvas() { return { style: {} }; },
  getCenter() { return { lng: 13.3777, lat: 52.5169 }; },
  getSource(id) { return this._sources[id] || null; },
  getLayer(id) { return this._layers[id] || null; },
  addSource(id, def) { this._sources[id] = { setData: (d) => { this._sources[id].data = d; } }; return id; },
  addLayer(def) { this._layers[def.id] = def; return def.id; },
  removeSource(id) { delete this._sources[id]; },
  removeLayer(id) { delete this._layers[id]; },
  fitBounds() { this._fit = true; },
  flyTo() {},
};

const fakeApp = {
  addMapControl() { return true; },
  removeMapControl() {},
  getMap() { return fakeMap; },
  fitBounds() { fakeMap._fit = true; },
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

// --- MAP DRAWING ASSERTIONS (the user's bug: "no points/lines") ---
console.log("map layers added:",
  "route=" + (fakeMap._layers["bike-route-control-route-layer"] ? "yes" : "NO"),
  "points=" + (fakeMap._layers["bike-route-control-points-layer"] ? "yes" : "NO"),
  "fitBounds=" + (fakeMap._fit ? "yes" : "NO"));
console.assert(fakeMap._layers["bike-route-control-route-layer"], "route line layer missing");
console.assert(fakeMap._layers["bike-route-control-points-layer"], "start/end points layer missing");
console.assert(fakeMap._fit, "fitBounds not called");

// --- PATH-TYPE / SURFACE ASSERTIONS (user req #3) ---
// Give the async path-types + POI fetch time to resolve.
await new Promise((r) => setTimeout(r, 8000));
const allTabs = [];
(function collect(n) { for (const c of n._children || []) { if (c.className === "bike-tab-content") allTabs.push(c); collect(c); } })(container);
let ptText = "";
for (const t of allTabs) {
  (function walk(n) { for (const c of n._children || []) { if (c.textContent) ptText += c.textContent + " "; walk(c); } })(t);
}
console.log("highlights mentions Path type:", /Path type/.test(ptText) ? "yes" : "no");
console.log("highlights mentions Surface:", /Surface/.test(ptText) ? "yes" : "no");
console.log("highlights mentions Paved:", /Paved/.test(ptText) ? "yes" : "no");
console.log("highlights sample:", ptText.slice(0, 260).replace(/\s+/g, " "));

// Assertions on real data
const distance = statValues[0] || "";
console.assert(/km|m/.test(distance), "distance formatted");
console.assert(parseFloat(distance) > 2 && parseFloat(distance) < 6, "distance in sane range (~3.8 km)");
console.log("\nRESULT:", distance ? "pipeline produced a route" : "NO ROUTE");

// Clean shutdown
plugin.deactivate(fakeApp);
console.log("deactivate: ok");
console.log("TEST COMPLETE");
