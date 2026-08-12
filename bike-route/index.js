// GeoLibre Bike Route — a komoot-style bicycle route plugin.
//
// Finds the fastest bicycle route between two points and reports distance,
// estimated time, elevation gain/loss, an elevation profile, a terrain /
// difficulty rating, a turn-by-turn list, calories, an estimated surface
// breakdown, and points of interest (water, bike shops, viewpoints) along the
// way. Draws the route on the map, coloured by steepness, with start/end and
// highlight pins, and fits the view to the route.
//
// Self-contained ES module: no bundler, no external imports. GeoLibre loads
// this as the `entry` from plugin.json and expects a default-exported
// `GeoLibrePlugin` whose id/name/version match the manifest.
//
// Data sources (all keyless, CORS-enabled `Access-Control-Allow-Origin: *`):
//   - Routing:        OSRM demo server (bicycle profile): router.project-osrm.org
//   - Elevation:      Open-Meteo elevation API: api.open-meteo.com/v1/elevation
//   - Reverse geo:    Photon (komoot's geocoder): photon.komoot.io
//   - POIs / surface: Overpass API: overpass-api.de
// All are public demo endpoints with no SLA; swap for your own in CONFIG.

const PLUGIN_ID = "geolibre-bike-route";
const CONTROL_ID = "bike-route-control";
const RIGHT_PANEL_ID = "bike-route-panel";

// ---------------------------------------------------------------------------
// CONFIG -- swap these for your own backends.
// ---------------------------------------------------------------------------
const CONFIG = {
  routingBase: "https://router.project-osrm.org/route/v1",
  profile: "bicycle", // "bicycle" | "foot" | "driving"
  elevationBase: "https://api.open-meteo.com/v1/elevation",
  geocoderBase: "https://photon.komoot.io",
  overpassBase: "https://overpass-api.de/api/interpreter",
  maxElevationSamples: 240,
  timeoutMs: 25000,
  // Only estimate surfaces when the route bbox is smaller than this (km across),
  // to keep the Overpass query bounded.
  surfaceMaxBboxKm: 18,
};

// ---- small utilities ------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";
const BIKE_PATH =
  "M5.5 13a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zm0 2a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm13 0a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zm0 2a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM14 4l1.5 3H19l-3 5h2l-4.5 6L9 14l-3 1 1-3 3-1-4-7h3l2 3z";

// Haversine distance in metres between [lon,lat] pairs.
function haversine(a, b) {
  const R = 6371000;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function fmtDistance(m) {
  if (m == null || !isFinite(m)) return "—";
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

function fmtDuration(s) {
  if (s == null || !isFinite(s)) return "—";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}

function fmtElev(m) {
  if (m == null || !isFinite(m)) return "—";
  return `${Math.round(m)} m`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function fetchJson(url, { timeout = CONFIG.timeoutMs, method = "GET", body } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: { Accept: "application/json", "User-Agent": "geolibre-bike-route/1.0.0" },
      body,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchText(url, body, { timeout = CONFIG.timeoutMs } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "geolibre-bike-route/1.0.0",
      },
      body,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Geocoding (Photon) — start/end place names
// ---------------------------------------------------------------------------

async function reverseGeocode(lon, lat) {
  try {
    const data = await fetchJson(
      `${CONFIG.geocoderBase}/reverse?lat=${lat}&lon=${lon}`,
    );
    const f = data && data.features && data.features[0];
    if (!f) return null;
    const p = f.properties || {};
    const parts = [p.name, p.street, p.district, p.city || p.county, p.country]
      .filter((x) => x && x !== p.name);
    return [p.name, parts.filter(Boolean)[0] || ""].filter(Boolean).join(", ");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Routing (OSRM) — geometry + turn-by-turn
// ---------------------------------------------------------------------------

function maneuverArrow(modifier) {
  const m = (modifier || "").toLowerCase();
  const map = {
    left: "↰", right: "↱", "slight left": "↖", "slight right": "↗",
    "sharp left": "⤙", "sharp right": "⤚", straight: "↑", uturn: "⮌",
  };
  return map[m] || "↑";
}

function maneuverText(step) {
  const mv = step.maneuver || {};
  const mod = mv.modifier || "";
  const name = step.name && step.name !== "" ? step.name : "unnamed road";
  switch (mv.type) {
    case "depart":
      return `Head out on ${name}`;
    case "arrive":
      return "Arrive at your destination";
    case "roundabout":
    case "rotary":
      return `Take the roundabout, exit ${mv.exit || ""} onto ${name}`;
    case "fork":
      return `Keep ${mod || "straight"} at the fork${name ? ` onto ${name}` : ""}`;
    case "merge":
      return `Merge ${mod || ""} onto ${name}`.trim();
    case "end of road":
      return `At the end of the road, turn ${mod} onto ${name}`;
    case "turn":
    default:
      return `Turn ${mod || "onto"} ${name}`;
  }
}

async function fetchRoute(start, end) {
  const coords = `${start[0]},${start[1]};${end[0]},${end[1]}`;
  const url =
    `${CONFIG.routingBase}/${CONFIG.profile}/${coords}` +
    `?overview=full&geometries=geojson&steps=true`;
  const data = await fetchJson(url);
  if (!data || data.code !== "Ok" || !data.routes || !data.routes.length) {
    throw new Error(data && data.message ? data.message : "No route found");
  }
  const route = data.routes[0];
  const steps = [];
  if (route.legs) {
    for (const leg of route.legs) {
      for (const s of leg.steps || []) {
        steps.push({
          text: maneuverText(s),
          arrow: maneuverArrow(s.maneuver && s.maneuver.modifier),
          distance: s.distance || 0,
          name: s.name || "",
        });
      }
    }
  }
  return {
    coordinates: route.geometry.coordinates, // [ [lon,lat], ... ]
    distance: route.distance,
    duration: route.duration,
    steps,
  };
}

// ---------------------------------------------------------------------------
// Elevation sampling + profile
// ---------------------------------------------------------------------------

function sampleAlong(coordinates, maxSamples) {
  const n = coordinates.length;
  if (n <= maxSamples) return coordinates;
  const step = n / maxSamples;
  const out = [];
  for (let i = 0; i < maxSamples; i++) out.push(coordinates[Math.floor(i * step)]);
  out.push(coordinates[n - 1]);
  return out;
}

async function fetchElevations(coordinates) {
  const CHUNK = 50; // Open-Meteo rejects >~100 points per call
  const out = [];
  for (let i = 0; i < coordinates.length; i += CHUNK) {
    const slice = coordinates.slice(i, i + CHUNK);
    const lats = slice.map((c) => c[1]).join(",");
    const lons = slice.map((c) => c[0]).join(",");
    const url = `${CONFIG.elevationBase}?latitude=${lats}&longitude=${lons}`;
    const data = await fetchJson(url);
    if (!data || !Array.isArray(data.elevation)) {
      throw new Error("Elevation service returned no data");
    }
    out.push(...data.elevation);
  }
  return out; // metres, same order as coordinates
}

// Moving-average smoothing of the elevation profile to kill SRTM-scale noise.
function smoothElevations(elevations, windowSize = 5) {
  const n = elevations.length;
  if (windowSize <= 1 || n < windowSize) return elevations.slice();
  const half = Math.floor(windowSize / 2);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const start = Math.max(0, i - half);
    const end = Math.min(n, i + half + 1);
    let sum = 0;
    for (let j = start; j < end; j++) sum += elevations[j];
    out[i] = sum / (end - start);
  }
  return out;
}

const GRADE_WINDOW = 50; // metres the per-vertex grade is averaged over

// Build the elevation profile (distance vs elevation) and per-vertex grade
// using a distance-windowed gradient so short segments don't produce spikes.
function buildProfile(coordinates, elevations) {
  const elev = smoothElevations(elevations, 5);
  const n = coordinates.length;
  const cum = new Array(n).fill(0);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + haversine(coordinates[i - 1], coordinates[i]);

  function gradeAt(i) {
    let lo = i, hi = i;
    while (lo > 0 && cum[i] - cum[lo] < GRADE_WINDOW / 2) lo--;
    while (hi < n - 1 && cum[hi] - cum[i] < GRADE_WINDOW / 2) hi++;
    const d = cum[hi] - cum[lo];
    return d <= 0 ? 0 : ((elev[hi] - elev[lo]) / d) * 100;
  }

  let ascent = 0, descent = 0, maxEle = -Infinity, minEle = Infinity;
  let flat = 0, rolling = 0, hilly = 0, steep = 0;
  const points = [];
  for (let i = 0; i < n; i++) {
    points.push({ dist: cum[i], ele: elev[i] });
    maxEle = Math.max(maxEle, elev[i]);
    minEle = Math.min(minEle, elev[i]);
  }
  const steps = [];
  for (let i = 1; i < n; i++) {
    const segLen = haversine(coordinates[i - 1], coordinates[i]);
    const dEle = elev[i] - elev[i - 1];
    if (dEle > 0) ascent += dEle; else descent += -dEle;
    const grade = gradeAt(i);
    const cat = gradeCategory(grade);
    if (Math.abs(grade) < 2) flat += segLen;
    else if (Math.abs(grade) < 5) rolling += segLen;
    else if (Math.abs(grade) < 9) hilly += segLen;
    else steep += segLen;
    steps.push({ length: segLen, dElevation: dEle, grade, category: cat });
  }

  const total = cum[n - 1] || 0;
  const pct = (v) => (total > 0 ? (v / total) * 100 : 0);
  const summary = {
    ascent, descent, maxEle, minEle,
    flatPct: pct(flat), rollingPct: pct(rolling), hillyPct: pct(hilly), steepPct: pct(steep),
    total,
  };
  return { points, steps, summary };
}

function gradeCategory(gradePct) {
  const g = Math.abs(gradePct);
  if (gradePct > 0) {
    if (g < 2) return "flat climb";
    if (g < 5) return "moderate climb";
    if (g < 9) return "steep climb";
    return "very steep climb";
  }
  if (g < 2) return "flat descent";
  if (g < 5) return "moderate descent";
  if (g < 9) return "steep descent";
  return "very steep descent";
}

function gradeColor(grade) {
  const g = Math.abs(grade);
  if (g < 2) return "#2f9e44";
  if (g < 5) return "#94d82d";
  if (g < 9) return "#f08c00";
  return "#e03131";
}

function terrainLabel(s) {
  if (s.flatPct >= 70) return "Flat";
  if (s.flatPct + s.rollingPct >= 70) return "Rolling";
  if (s.hillyPct + s.steepPct >= 50) return "Hilly / mountainous";
  return "Mixed";
}

// komoot-style difficulty: distance + climb + steep share.
function difficultyRating(s) {
  const km = s.total / 1000;
  const score = km + (s.ascent / 100) * 2 + (s.steepPct / 100) * 5;
  if (score < 8) return { label: "Easy", color: "#2f9e44" };
  if (score < 22) return { label: "Moderate", color: "#f08c00" };
  return { label: "Difficult", color: "#e03131" };
}

function estimateCalories(s) {
  // Rough cycling burn: ~25 kcal/km on the flat + ~0.8 kcal per metre climbed.
  return Math.round((s.total / 1000) * 25 + s.ascent * 0.8);
}

// ---------------------------------------------------------------------------
// Overpass — POIs and surface estimate along the route
// ---------------------------------------------------------------------------

function routeBbox(coordinates) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const [lon, lat] of coordinates) {
    if (lat < s) s = lat; if (lat > n) n = lat;
    if (lon < w) w = lon; if (lon > e) e = lon;
  }
  // pad ~8%
  const dLat = (n - s) * 0.08 || 0.01;
  const dLon = (e - w) * 0.08 || 0.01;
  return [s - dLat, w - dLon, n + dLat, e + dLon];
}

const POI_DEFS = [
  { key: "drinking_water", label: "Drinking water", color: "#1c7ed6", icon: "💧" },
  { key: "bicycle_shop", label: "Bike shop", color: "#7048e8", icon: "🔧" },
  { key: "charging_station", label: "Charging", color: "#0ca678", icon: "⚡" },
  { key: "viewpoint", label: "Viewpoint", color: "#e8590c", icon: "👁" },
  { key: "picnic_site", label: "Picnic site", color: "#2f9e44", icon: "🧺" },
  { key: "peak", label: "Peak", color: "#9c36b5", icon: "⛰" },
];

async function fetchHighlights(coordinates) {
  const [s, w, n, e] = routeBbox(coordinates);
  const bbox = `${s},${w},${n},${e}`;
  const q =
    "[out:json][timeout:25];(" +
    'node["amenity"="drinking_water"](' + bbox + ");" +
    'node["amenity"="bicycle_shop"](' + bbox + ");" +
    'node["amenity"="charging_station"](' + bbox + ");" +
    'node["tourism"="viewpoint"](' + bbox + ");" +
    'node["tourism"="picnic_site"](' + bbox + ");" +
    'node["natural"="peak"](' + bbox + ");" +
    ");out center;";
  const txt = await fetchText(CONFIG.overpassBase, "data=" + encodeURIComponent(q));
  const data = JSON.parse(txt);
  const out = [];
  for (const el of data.elements || []) {
    const ll = el.lat != null ? [el.lon, el.lat] : el.center ? [el.center.lon, el.center.lat] : null;
    if (!ll) continue;
    const tags = el.tags || {};
    let def = POI_DEFS.find((d) => tags.amenity === d.key || tags.tourism === d.key || tags.natural === d.key);
    if (!def) continue;
    out.push({ def, lon: ll[0], lat: ll[1], name: tags.name || def.label });
  }
  return out;
}

async function fetchSurfaceBreakdown(coordinates) {
  const [s, w, n, e] = routeBbox(coordinates);
  const diag = haversine([w, s], [e, n]) / 1000;
  if (diag > CONFIG.surfaceMaxBboxKm) return null; // keep the query bounded
  const bbox = `${s},${w},${n},${e}`;
  const q = `[out:json][timeout:20];way["surface"](${bbox});out tags 300;`;
  const txt = await fetchText(CONFIG.overpassBase, "data=" + encodeURIComponent(q));
  const data = JSON.parse(txt);
  const tally = {};
  let total = 0;
  for (const el of data.elements || []) {
    const surf = (el.tags && el.tags.surface) || "unknown";
    tally[surf] = (tally[surf] || 0) + 1;
    total++;
  }
  if (!total) return null;
  const paved = ["asphalt", "paved", "concrete", "cobblestone", "sett", "metal", "wood"];
  let pavedN = 0;
  for (const [k, v] of Object.entries(tally)) if (paved.includes(k)) pavedN += v;
  return {
    pavedPct: (pavedN / total) * 100,
    unpavedPct: ((total - pavedN) / total) * 100,
    raw: tally,
  };
}

// ---------------------------------------------------------------------------
// Map interaction
//
// GeoLibre exposes the map via `app.getMap()` (NOT a global `window.maplibregl`,
// which is not defined inside the plugin sandbox). We draw the route line and
// all points (start / end / POIs) as native MapLibre sources+geojson layers so
// we never depend on the Marker/Popup classes either. Bounds fitting uses the
// host's `app.fitBounds()`.
// ---------------------------------------------------------------------------

let mapInstance = null;
let overlayIds = []; // ids of every source/layer/source we added, for cleanup

function getMap() {
  if (mapInstance) return mapInstance;
  try {
    if (appApi && typeof appApi.getMap === "function") {
      mapInstance = appApi.getMap();
      return mapInstance;
    }
  } catch (e) { /* ignore */ }
  return null;
}

function addId(kind, id) {
  overlayIds.push({ kind, id });
}

function clearOverlays() {
  const map = getMap();
  if (!map) return;
  for (const { kind, id } of overlayIds.slice().reverse()) {
    try {
      if (kind === "layer" && map.getLayer && map.getLayer(id)) map.removeLayer(id);
      if (kind === "source" && map.getSource && map.getSource(id)) map.removeSource(id);
    } catch (e) { /* best effort */ }
  }
  overlayIds = [];
}

function ensureSource(map, id, data) {
  if (map.getSource && map.getSource(id)) {
    map.getSource(id).setData(data);
  } else {
    map.addSource(id, { type: "geojson", data });
    addId("source", id);
  }
}

function drawRoute(coordinates, steps) {
  const map = getMap();
  if (!map) { console.warn("[bike-route] no map available to draw"); return; }
  clearOverlays();

  // One line layer, many coloured segment features (komoot-style steepness colour).
  const feats = [];
  for (let i = 1; i < coordinates.length; i++) {
    const grade = steps && steps[i - 1] ? steps[i - 1].grade : 0;
    feats.push({
      type: "Feature",
      properties: { color: gradeColor(grade) },
      geometry: { type: "LineString", coordinates: [coordinates[i - 1], coordinates[i]] },
    });
  }
  const routeSrc = `${CONTROL_ID}-route-src`;
  const routeLayer = `${CONTROL_ID}-route-layer`;
  ensureSource(map, routeSrc, { type: "FeatureCollection", features: feats });
  if (!map.getLayer || !map.getLayer(routeLayer)) {
    map.addLayer({
      id: routeLayer,
      type: "line",
      source: routeSrc,
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": ["get", "color"], "line-width": 5, "line-opacity": 0.95 },
    });
    addId("layer", routeLayer);
  }

  // Points (start/end) as a circle layer — no Marker class needed.
  const start = coordinates[0];
  const end = coordinates[coordinates.length - 1];
  const ptSrc = `${CONTROL_ID}-points-src`;
  const ptLayer = `${CONTROL_ID}-points-layer`;
  ensureSource(map, ptSrc, {
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: { kind: "start", color: "#1c7ed6" }, geometry: { type: "Point", coordinates: start } },
      { type: "Feature", properties: { kind: "end", color: "#e03131" }, geometry: { type: "Point", coordinates: end } },
    ],
  });
  if (!map.getLayer || !map.getLayer(ptLayer)) {
    map.addLayer({
      id: ptLayer,
      type: "circle",
      source: ptSrc,
      paint: {
        "circle-radius": 7,
        "circle-color": ["get", "color"],
        "circle-stroke-width": 2,
        "circle-stroke-color": "#fff",
      },
    });
    addId("layer", ptLayer);
  }

  fitRoute(coordinates);
}

function drawPois(pois) {
  const map = getMap();
  if (!map || !pois.length) return;
  const src = `${CONTROL_ID}-poi-src`;
  const layer = `${CONTROL_ID}-poi-layer`;
  ensureSource(map, src, {
    type: "FeatureCollection",
    features: pois.map((p) => ({
      type: "Feature",
      properties: { color: p.def.color, label: `${p.def.icon} ${escapeHtml(p.def.label)}`, name: escapeHtml(p.name) },
      geometry: { type: "Point", coordinates: [p.lon, p.lat] },
    })),
  });
  if (!map.getLayer || !map.getLayer(layer)) {
    map.addLayer({
      id: layer,
      type: "circle",
      source: src,
      paint: {
        "circle-radius": 5,
        "circle-color": ["get", "color"],
        "circle-stroke-width": 1.5,
        "circle-stroke-color": "#fff",
      },
    });
    addId("layer", layer);
  }
}

function fitRoute(coordinates) {
  if (!coordinates.length) return;
  let s = 90, w = 180, n = -90, e = -180;
  for (const [lon, lat] of coordinates) {
    if (lat < s) s = lat; if (lat > n) n = lat;
    if (lon < w) w = lon; if (lon > e) e = lon;
  }
  const bounds = [w, s, e, n];
  if (appApi && typeof appApi.fitBounds === "function") {
    appApi.fitBounds(bounds);
  } else {
    const map = getMap();
    if (map && map.fitBounds) map.fitBounds(bounds, { padding: 60, duration: 800, maxZoom: 16 });
  }
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

function statGrid(pairs) {
  const grid = el("div", "bike-stats");
  for (const [label, value] of pairs) {
    const cell = el("div", "bike-stat");
    cell.append(el("span", "bike-stat-label", label), el("span", "bike-stat-value", value));
    grid.appendChild(cell);
  }
  return grid;
}

function barRow(label, pct, color) {
  const wrap = el("div", "bike-bar-row");
  const head = el("div", "bike-bar-head");
  head.append(el("span", null, label), el("span", null, `${pct.toFixed(0)}%`));
  const track = el("div", "bike-bar-track");
  const fill = el("div", "bike-bar-fill");
  fill.style.width = `${Math.min(100, pct)}%`;
  fill.style.background = color;
  track.appendChild(fill);
  wrap.append(head, track);
  return wrap;
}

// Inline SVG elevation profile (distance x, elevation y) with gradient fill,
// coloured by steepness.
function elevationChart(profile) {
  const W = 300, H = 90, PAD = 6;
  const pts = profile.points;
  if (!pts.length) return el("div");
  const minE = Math.min(...pts.map((p) => p.ele));
  const maxE = Math.max(...pts.map((p) => p.ele));
  const span = Math.max(1, maxE - minE);
  const totalD = Math.max(1, pts[pts.length - 1].dist);
  const x = (d) => PAD + (d / totalD) * (W - 2 * PAD);
  const y = (e) => H - PAD - ((e - minE) / span) * (H - 2 * PAD);

  let dLine = "";
  pts.forEach((p, i) => { dLine += (i === 0 ? "M" : "L") + x(p.dist).toFixed(1) + " " + y(p.ele).toFixed(1) + " "; });
  const area = `M${x(0).toFixed(1)} ${H - PAD} ` + pts.map((p) => "L" + x(p.dist).toFixed(1) + " " + y(p.ele).toFixed(1)).join(" ") + ` L${x(totalD).toFixed(1)} ${H - PAD} Z`;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "bike-elev-chart");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.innerHTML =
    `<defs><linearGradient id="eg" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0%" stop-color="hsl(var(--accent))" stop-opacity="0.55"/>` +
    `<stop offset="100%" stop-color="hsl(var(--accent))" stop-opacity="0.05"/>` +
    `</linearGradient></defs>` +
    `<path d="${area}" fill="url(#eg)" stroke="none"/>` +
    `<path d="${dLine}" fill="none" stroke="hsl(var(--foreground))" stroke-width="1.6" stroke-opacity="0.9"/>`;
  return svg;
}

// ---------------------------------------------------------------------------
// Panel body (tabs: Overview / Directions / Highlights)
// ---------------------------------------------------------------------------

function buildPanelBody(container, app) {
  const wrap = el("div", "bike-panel");

  // --- input row -----------------------------------------------------------
  const intro = el("p", "bike-intro",
    "Fastest bicycle route between two points. Enter coordinates (lon, lat) or drop pins on the map.");
  wrap.appendChild(intro);

  const modeBtn = el("button", "bike-btn bike-btn-ghost", "Drop pins on map: OFF");
  let pickMode = false, pickWhich = null;
  modeBtn.addEventListener("click", () => {
    pickMode = !pickMode;
    if (pickMode) {
      pickWhich = !startInput.value ? "start" : "end";
      modeBtn.textContent = `Pick ${pickWhich} (click map)`;
      modeBtn.classList.add("is-on");
      if (mapInstance && mapInstance.getCanvas) mapInstance.getCanvas().style.cursor = "crosshair";
    } else {
      modeBtn.textContent = "Drop pins on map: OFF";
      modeBtn.classList.remove("is-on");
      if (mapInstance && mapInstance.getCanvas) mapInstance.getCanvas().style.cursor = "";
    }
  });
  wrap.appendChild(modeBtn);

  function field(label, placeholder, inputEl) {
    const f = el("label", "bike-field");
    f.append(el("span", null, label));
    inputEl.className = "bike-input";
    inputEl.placeholder = placeholder;
    f.appendChild(inputEl);
    return f;
  }
  const startInput = document.createElement("input");
  const endInput = document.createElement("input");
  const startWrap = field("Start (lon, lat)", "13.4132, 52.5220", startInput);
  const endWrap = field("End (lon, lat)", "13.3777, 52.5169", endInput);

  const centerBtn = el("button", "bike-btn bike-btn-ghost bike-btn-sm", "Use map center → end");
  centerBtn.addEventListener("click", () => {
    if (mapInstance && mapInstance.getCenter) {
      const c = mapInstance.getCenter();
      endInput.value = `${c.lng.toFixed(5)}, ${c.lat.toFixed(5)}`;
    }
  });
  endWrap.appendChild(centerBtn);
  wrap.append(startWrap, endWrap);

  const runBtn = el("button", "bike-btn bike-btn-primary", "Plan route");
  const status = el("div", "bike-status");
  wrap.append(runBtn, status);

  // --- tabs -----------------------------------------------------------------
  const tabBar = el("div", "bike-tabs");
  const tabKeys = ["overview", "directions", "highlights"];
  const tabLabels = { overview: "Overview", directions: "Directions", highlights: "Highlights" };
  const tabBtns = {};
  for (const k of tabKeys) {
    const b = el("button", "bike-tab", tabLabels[k]);
    b.addEventListener("click", () => setTab(k));
    tabBtns[k] = b;
    tabBar.appendChild(b);
  }
  wrap.appendChild(tabBar);

  const tabContent = {};
  for (const k of tabKeys) {
    const c = el("div", "bike-tab-content");
    c.style.display = k === "overview" ? "block" : "none";
    tabContent[k] = c;
    wrap.appendChild(c);
  }
  function setTab(k) {
    for (const key of tabKeys) {
      tabContent[key].style.display = key === k ? "block" : "none";
      tabBtns[key].classList.toggle("is-active", key === k);
    }
  }
  setTab("overview");

  function drawTempPin(coords, color) {
    const map = getMap();
    if (!map) return;
    const src = `${CONTROL_ID}-pin-src`;
    const layer = `${CONTROL_ID}-pin-layer`;
    const data = { type: "FeatureCollection", features: [
      { type: "Feature", properties: { color }, geometry: { type: "Point", coordinates: coords } },
    ] };
    if (map.getSource && map.getSource(src)) map.getSource(src).setData(data);
    else map.addSource(src, { type: "geojson", data });
    if (!map.getLayer || !map.getLayer(layer)) {
      map.addLayer({
        id: layer, type: "circle", source: src,
        paint: { "circle-radius": 7, "circle-color": color, "circle-stroke-width": 2, "circle-stroke-color": "#fff" },
      });
      overlayIds.push({ kind: "layer", id: layer });
      overlayIds.push({ kind: "source", id: src });
    }
  }

  function onClick(e) {
    if (!pickMode || !pickWhich) return;
    const ll = e.lngLat;
    const txt = `${ll.lng.toFixed(5)}, ${ll.lat.toFixed(5)}`;
    if (pickWhich === "start") {
      startInput.value = txt;
      drawTempPin([ll.lng, ll.lat], "#1c7ed6");
    } else {
      endInput.value = txt;
      drawTempPin([ll.lng, ll.lat], "#e03131");
    }
    pickMode = false; pickWhich = null;
    modeBtn.textContent = "Drop pins on map: OFF";
    modeBtn.classList.remove("is-on");
    const map = getMap();
    if (map && map.getCanvas) map.getCanvas().style.cursor = "";
  }
  const map = getMap();
  if (map && map.on) map.on("click", onClick);

  // --- run handler -----------------------------------------------------------
  runBtn.addEventListener("click", async () => {
    const parse = (s) => {
      const parts = s.split(",").map((x) => parseFloat(x.trim()));
      if (parts.length !== 2 || parts.some((n) => !isFinite(n))) return null;
      return parts;
    };
    const start = parse(startInput.value);
    const end = parse(endInput.value);
    if (!start || !end) {
      status.textContent = "Enter both points as 'longitude, latitude'.";
      status.className = "bike-status bike-status-err";
      return;
    }
    status.textContent = "Routing…";
    status.className = "bike-status";
    runBtn.disabled = true;
    try {
      const route = await fetchRoute(start, end);
      const samples = sampleAlong(route.coordinates, CONFIG.maxElevationSamples);
      const elevations = await fetchElevations(samples);
      const profile = buildProfile(samples, elevations);

      drawRoute(samples, profile.steps);
      renderOverview(tabContent.overview, route, profile);
      renderDirections(tabContent.directions, route.steps);
      tabContent.highlights.innerHTML = '<div class="bike-loading">Loading highlights…</div>';

      // Place names (non-blocking for the main result)
      const [sn, en] = await Promise.all([
        reverseGeocode(start[0], start[1]),
        reverseGeocode(end[0], end[1]),
      ]);
      if (sn || en) {
        const sub = tabContent.overview.querySelector(".bike-places");
        if (sub) sub.textContent = `${sn || "start"} → ${en || "end"}`;
      }

      // Highlights + surface (best-effort, don't block the core result)
      try {
        const [pois, surface] = await Promise.all([
          fetchHighlights(samples),
          fetchSurfaceBreakdown(samples),
        ]);
        drawPois(pois);
        renderHighlights(tabContent.highlights, pois, surface);
      } catch (err) {
        tabContent.highlights.innerHTML = '<div class="bike-loading">Highlights unavailable (Overpass timeout or blocked).</div>';
      }

      setTab("overview");
      status.textContent = `Done — ${fmtDistance(profile.summary.total)} in ${fmtDuration(route.duration)}.`;
      status.className = "bike-status bike-status-ok";
    } catch (err) {
      console.error("[bike-route] route failed", err);
      status.textContent = `Error: ${err.message || err}`;
      status.className = "bike-status bike-status-err";
    } finally {
      runBtn.disabled = false;
    }
  });

  container.appendChild(wrap);
  return () => { const m = getMap(); if (m && m.off) m.off("click", onClick); };
}

function renderOverview(node, route, profile) {
  node.innerHTML = "";
  const s = profile.summary;
  const diff = difficultyRating(s);
  const cal = estimateCalories(s);

  const places = el("div", "bike-places", "");
  node.appendChild(places);

  node.appendChild(statGrid([
    ["Distance", fmtDistance(s.total)],
    ["Est. time", fmtDuration(route.duration)],
    ["Ascent", fmtElev(s.ascent)],
    ["Descent", fmtElev(s.descent)],
    ["Min elev.", fmtElev(s.minEle)],
    ["Max elev.", fmtElev(s.maxEle)],
  ]));

  const diffCard = el("div", "bike-card bike-diff");
  diffCard.style.borderLeft = `4px solid ${diff.color}`;
  diffCard.append(
    el("div", "bike-card-title", "Difficulty"),
    (() => { const d = el("div", "bike-diff-badge", diff.label); d.style.background = diff.color; return d; })(),
    el("div", "bike-card-sub", `≈ ${cal} kcal · terrain: ${terrainLabel(s)}`),
  );
  node.appendChild(diffCard);

  const chartCard = el("div", "bike-card");
  chartCard.append(el("div", "bike-card-title", "Elevation profile"));
  chartCard.appendChild(elevationChart(profile));
  const leg = el("div", "bike-card-sub",
    `${fmtElev(s.minEle)} ↘  ${fmtElev(s.maxEle)} ↗  ·  total climb ${fmtElev(s.ascent)}`);
  chartCard.appendChild(leg);
  node.appendChild(chartCard);

  const terr = el("div", "bike-card");
  terr.append(el("div", "bike-card-title", "Terrain breakdown"));
  terr.append(barRow("Flat", s.flatPct, "#2f9e44"));
  terr.append(barRow("Rolling (2–5%)", s.rollingPct, "#94d82d"));
  terr.append(barRow("Hilly (5–9%)", s.hillyPct, "#f08c00"));
  terr.append(barRow("Steep (9%+)", s.steepPct, "#e03131"));
  node.appendChild(terr);
}

function renderDirections(node, steps) {
  node.innerHTML = "";
  if (!steps.length) { node.appendChild(el("div", "bike-loading", "No turn-by-turn data.")); return; }
  const list = el("ol", "bike-turns");
  steps.forEach((st) => {
    const li = el("li", "bike-turn");
    const arrow = el("span", "bike-turn-arrow", st.arrow);
    const body = el("div", "bike-turn-body");
    body.append(el("div", "bike-turn-text", st.text));
    body.append(el("div", "bike-turn-dist", fmtDistance(st.distance)));
    li.append(arrow, body);
    list.appendChild(li);
  });
  node.appendChild(list);
}

function renderHighlights(node, pois, surface) {
  node.innerHTML = "";
  if (surface) {
    const card = el("div", "bike-card");
    card.append(el("div", "bike-card-title", "Surface (est. from OSM)"));
    card.append(barRow("Paved", surface.pavedPct, "#2f9e44"));
    card.append(barRow("Unpaved", surface.unpavedPct, "#e8590c"));
    card.append(el("div", "bike-card-sub", "Estimated from OpenStreetMap surface tags in the route area."));
    node.appendChild(card);
  }
  const card = el("div", "bike-card");
  card.append(el("div", "bike-card-title", `Highlights along the route (${pois.length})`));
  if (!pois.length) {
    card.append(el("div", "bike-card-sub", "No drinking water, bike shops, viewpoints or peaks found nearby."));
  } else {
    const list = el("ul", "bike-pois");
    pois.forEach((p) => {
      const li = el("li", "bike-poi");
      li.append(el("span", "bike-poi-icon", p.def.icon));
      const b = el("div", "bike-poi-body");
      b.append(el("div", "bike-poi-name", p.name));
      b.append(el("div", "bike-poi-type", p.def.label));
      li.appendChild(b);
      li.addEventListener("click", () => {
        const m = getMap();
        if (m && m.flyTo) m.flyTo({ center: [p.lon, p.lat], zoom: 15 });
      });
      list.appendChild(li);
    });
    card.appendChild(list);
  }
  node.appendChild(card);
}

// ---------------------------------------------------------------------------
// Map control (MapLibre IControl)
// ---------------------------------------------------------------------------

const control = {
  _container: null,
  _map: null,
  onAdd(map) {
    if (map) mapInstance = map;
    else if (appApi && typeof appApi.getMap === "function") mapInstance = appApi.getMap();
    const container = document.createElement("div");
    container.className = "maplibregl-ctrl maplibregl-ctrl-group bike-route-control";
    const button = document.createElement("button");
    button.type = "button";
    button.title = "Bike route planner";
    button.setAttribute("aria-label", "Bike route planner");
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "20");
    svg.setAttribute("height", "20");
    svg.setAttribute("fill", "currentColor");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", BIKE_PATH);
    svg.appendChild(path);
    button.appendChild(svg);
    button.addEventListener("click", () => {
      if (appApi?.openRightPanel) appApi.openRightPanel(RIGHT_PANEL_ID);
      else button.classList.toggle("is-active");
    });
    container.appendChild(button);
    this._container = container;
    this._map = map;
    return container;
  },
  onRemove() {
    this._container?.remove();
    this._container = null;
    this._map = null;
  },
};

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

let appApi = null;
const disposers = [];

export const plugin = {
  id: PLUGIN_ID,
  name: "Bike Route",
  version: "1.0.0",
  activate(app) {
    appApi = app;
    const added = app.addMapControl(control, "top-right");
    if (!added) {
      console.error("[bike-route] could not add map control");
      return false;
    }
    const keep = (dispose) => { if (typeof dispose === "function") disposers.push(dispose); };
    keep(
      app.registerRightPanel?.({
        id: RIGHT_PANEL_ID,
        title: "Bike Route",
        defaultWidth: 380,
        render: (container) => buildPanelBody(container, app),
      }),
    );
    keep(
      app.registerToolbarMenu?.({
        id: `${PLUGIN_ID}-menu`,
        label: "Bike Route",
        items: [
          { id: "open", label: "Open route planner", disabled: !app.openRightPanel, onSelect: () => app.openRightPanel?.(RIGHT_PANEL_ID) },
          { id: "clear", label: "Clear map overlays", onSelect: () => clearOverlays() },
        ],
      }),
    );
  },
  deactivate(app) {
    for (const dispose of disposers.splice(0)) {
      try { dispose(); } catch (err) { console.error("[bike-route] cleanup failed", err); }
    }
    clearOverlays();
    app.removeMapControl(control);
    appApi = null;
  },
};

export default plugin;
