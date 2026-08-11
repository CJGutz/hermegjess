// GeoLibre Bike Route plugin
// Find the fastest bicycle route between two points and report distance,
// elevation, grade, and an estimated terrain classification for each segment.
//
// Self-contained ES module: no bundler, no external imports. GeoLibre loads
// this as the `entry` from plugin.json and expects a default-exported
// `GeoLibrePlugin` whose id/name/version match the manifest.
//
// Data sources (all keyless, CORS-enabled `Access-Control-Allow-Origin: *`):
//   - Routing:  OSRM demo server (bicycle profile): https://router.project-osrm.org
//   - Elevation: Open-Meteo elevation API: https://api.open-meteo.com/v1/elevation
// Both are public demo endpoints with no SLA; swap them for your own instance
// in the CONFIG block below.

const PLUGIN_ID = "geolibre-bike-route";
const CONTROL_ID = "bike-route-control";
const RIGHT_PANEL_ID = "bike-route-panel";

// ---------------------------------------------------------------------------
// CONFIG -- edit to point at your own routing/elevation backends.
// `profile` is appended to `routingBase` to form the OSRM endpoint.
// ---------------------------------------------------------------------------
const CONFIG = {
  routingBase: "https://router.project-osrm.org/route/v1",
  profile: "bicycle", // "bicycle" | "foot" | "driving"
  elevationBase: "https://api.open-meteo.com/v1/elevation",
  // Sample at most this many elevation points (Open-Meteo handles ~100/batch
  // comfortably; we chunk to stay safe).
  maxElevationSamples: 200,
  // Any fetch that takes longer than this (ms) is aborted.
  timeoutMs: 25000,
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

async function fetchJson(url, { timeout = CONFIG.timeoutMs } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Classify a segment by grade.
function gradeCategory(gradePct) {
  const g = Math.abs(gradePct);
  if (gradePct > 0) {
    if (g < 2) return "flat / gentle climb";
    if (g < 5) return "moderate climb";
    if (g < 9) return "steep climb";
    return "very steep climb";
  }
  if (g < 2) return "flat / gentle descent";
  if (g < 5) return "moderate descent";
  if (g < 9) return "steep descent";
  return "very steep descent";
}

// ---------------------------------------------------------------------------
// Route + elevation processing
// ---------------------------------------------------------------------------

async function fetchRoute(start, end) {
  const coords = `${start[0]},${start[1]};${end[0]},${end[1]}`;
  const url =
    `${CONFIG.routingBase}/${CONFIG.profile}/${coords}` +
    `?overview=full&geometries=geojson&steps=false`;
  const data = await fetchJson(url);
  if (!data || data.code !== "Ok" || !data.routes || !data.routes.length) {
    throw new Error(data && data.message ? data.message : "No route found");
  }
  const route = data.routes[0];
  return {
    coordinates: route.geometry.coordinates, // [ [lon,lat], ... ]
    distance: route.distance,
    duration: route.duration,
  };
}

// Sample the elevation along a route. We keep the route's vertices and add
// interpolated midpoints only if the route is long, capping the total sample
// count so the single elevation call stays small.
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
  const lats = coordinates.map((c) => c[1]).join(",");
  const lons = coordinates.map((c) => c[0]).join(",");
  const url = `${CONFIG.elevationBase}?latitude=${lats}&longitude=${lons}`;
  const data = await fetchJson(url);
  if (!data || !Array.isArray(data.elevation)) {
    throw new Error("Elevation service returned no data");
  }
  return data.elevation; // metres, same order as coordinates
}

// Build per-step metrics and aggregate stats from coords + elevations.
function buildMetrics(coordinates, elevations) {
  const steps = [];
  let ascent = 0;
  let descent = 0;
  let maxEle = -Infinity;
  let minEle = Infinity;
  let flat = 0;
  let rolling = 0;
  let hilly = 0;
  let steep = 0;

  for (let i = 1; i < coordinates.length; i++) {
    const a = coordinates[i - 1];
    const b = coordinates[i];
    const segLen = haversine(a, b);
    const dEle = elevations[i] - elevations[i - 1];
    const grade = segLen > 0 ? (dEle / segLen) * 100 : 0;
    if (dEle > 0) ascent += dEle;
    else descent += -dEle;
    maxEle = Math.max(maxEle, elevations[i]);
    minEle = Math.min(minEle, elevations[i]);

    const cat = gradeCategory(grade);
    if (Math.abs(grade) < 2) flat += segLen;
    else if (Math.abs(grade) < 5) rolling += segLen;
    else if (Math.abs(grade) < 9) hilly += segLen;
    else steep += segLen;

    steps.push({
      from: a,
      to: b,
      length: segLen,
      dElevation: dEle,
      grade,
      category: cat,
    });
  }

  const total = coordinates.reduce(
    (acc, _, i) => (i === 0 ? 0 : acc + haversine(coordinates[i - 1], coordinates[i])),
    0,
  );
  const pct = (v) => (total > 0 ? (v / total) * 100 : 0);

  return {
    steps,
    summary: {
      ascent,
      descent,
      maxEle,
      minEle,
      flatPct: pct(flat),
      rollingPct: pct(rolling),
      hillyPct: pct(hilly),
      steepPct: pct(steep),
      total,
    },
  };
}

// Pick an overall terrain label for the route.
function terrainLabel(s) {
  if (s.flatPct >= 70) return "Flat";
  if (s.flatPct + s.rollingPct >= 70) return "Rolling";
  if (s.hillyPct + s.steepPct >= 50) return "Hilly / mountainous";
  return "Mixed";
}

// ---------------------------------------------------------------------------
// Map interaction
// ---------------------------------------------------------------------------

let mapInstance = null; // the MapLibre map, captured in control.onAdd
let routeSourceId = null;
let routeLayerId = null;
let startMarker = null;
let endMarker = null;

function clearOverlays() {
  if (!mapInstance) return;
  try {
    if (routeLayerId && mapInstance.getLayer(routeLayerId)) {
      mapInstance.removeLayer(routeLayerId);
    }
    if (routeSourceId && mapInstance.getSource(routeSourceId)) {
      mapInstance.removeSource(routeSourceId);
    }
    startMarker?.remove?.();
    endMarker?.remove?.();
  } catch (e) {
    // best effort
  }
  routeLayerId = routeSourceId = null;
  startMarker = endMarker = null;
}

function drawRoute(coordinates) {
  if (!mapInstance) return;
  clearOverlays();
  routeSourceId = `${CONTROL_ID}-src`;
  routeLayerId = `${CONTROL_ID}-layer`;

  const geojson = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates },
      },
    ],
  };

  if (mapInstance.getSource(routeSourceId)) {
    mapInstance.removeSource(routeSourceId);
  }
  mapInstance.addSource(routeSourceId, { type: "geojson", data: geojson });
  mapInstance.addLayer({
    id: routeLayerId,
    type: "line",
    source: routeSourceId,
    layout: { "line-join": "round", "line-cap": "round" },
    paint: {
      "line-color": "#e8590c",
      "line-width": 5,
      "line-opacity": 0.9,
    },
  });

  const start = coordinates[0];
  const end = coordinates[coordinates.length - 1];
  if (window.maplibregl) {
    startMarker = new window.maplibregl.Marker({ color: "#1c7ed6" })
      .setLngLat(start)
      .addTo(mapInstance);
    endMarker = new window.maplibregl.Marker({ color: "#e03131" })
      .setLngLat(end)
      .addTo(mapInstance);
  }

  try {
    const b = new window.maplibregl.LngLatBounds(start, start);
    coordinates.forEach((c) => b.extend(c));
    mapInstance.fitBounds(b, { padding: 60, duration: 800, maxZoom: 16 });
  } catch (e) {
    // fit optional
  }
}

// ---------------------------------------------------------------------------
// UI — a right-sidebar panel populated with plain DOM.
// ---------------------------------------------------------------------------

function makeStat(label, value) {
  const row = document.createElement("div");
  row.className = "bike-stat";
  const l = document.createElement("span");
  l.className = "bike-stat-label";
  l.textContent = label;
  const v = document.createElement("span");
  v.className = "bike-stat-value";
  v.textContent = value;
  row.append(l, v);
  return row;
}

function makeBar(label, pct, color) {
  const wrap = document.createElement("div");
  wrap.className = "bike-bar-row";
  const head = document.createElement("div");
  head.className = "bike-bar-head";
  const l = document.createElement("span");
  l.textContent = label;
  const p = document.createElement("span");
  p.textContent = `${pct.toFixed(0)}%`;
  head.append(l, p);
  const track = document.createElement("div");
  track.className = "bike-bar-track";
  const fill = document.createElement("div");
  fill.className = "bike-bar-fill";
  fill.style.width = `${Math.min(100, pct)}%`;
  fill.style.background = color;
  track.appendChild(fill);
  wrap.append(head, track);
  return wrap;
}

function renderResults(resultsEl, result) {
  const { coordinates, metrics, summary, terrain } = result;

  const cards = document.createElement("div");
  cards.className = "bike-cards";

  // Summary card
  const sum = document.createElement("div");
  sum.className = "bike-card";
  sum.append(makeStat("Distance", fmtDistance(metrics.summary.total)));
  sum.append(makeStat("Est. time", fmtDuration(result.duration)));
  sum.append(makeStat("Ascent", fmtElev(metrics.summary.ascent)));
  sum.append(makeStat("Descent", fmtElev(metrics.summary.descent)));
  sum.append(makeStat("Min elevation", fmtElev(metrics.summary.minEle)));
  sum.append(makeStat("Max elevation", fmtElev(metrics.summary.maxEle)));
  sum.append(makeStat("Terrain", terrain));

  // Terrain breakdown card
  const brk = document.createElement("div");
  brk.className = "bike-card";
  const h = document.createElement("div");
  h.className = "bike-card-title";
  h.textContent = "Terrain breakdown";
  brk.appendChild(h);
  brk.append(makeBar("Flat", metrics.summary.flatPct, "#37b24d"));
  brk.append(makeBar("Rolling (2–5%)", metrics.summary.rollingPct, "#94d82d"));
  brk.append(makeBar("Hilly (5–9%)", metrics.summary.hillyPct, "#f59f00"));
  brk.append(makeBar("Steep (9%+)", metrics.summary.steepPct, "#e8590c"));

  cards.append(sum, brk);

  // Segment table
  const segWrap = document.createElement("div");
  segWrap.className = "bike-card";
  const sh = document.createElement("div");
  sh.className = "bike-card-title";
  sh.textContent = "Segments (by grade)";
  segWrap.appendChild(sh);

  const table = document.createElement("table");
  table.className = "bike-table";
  const thead = document.createElement("thead");
  thead.innerHTML =
    "<tr><th>#</th><th>Dist</th><th>±Elev</th><th>Grade</th><th>Terrain</th></tr>";
  const tbody = document.createElement("tbody");
  metrics.steps.forEach((s, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${i + 1}</td>` +
      `<td>${fmtDistance(s.length)}</td>` +
      `<td>${s.dElevation >= 0 ? "+" : ""}${s.dElevation.toFixed(1)} m</td>` +
      `<td>${s.grade.toFixed(1)}%</td>` +
      `<td>${escapeHtml(s.category)}</td>`;
    tbody.appendChild(tr);
  });
  table.append(thead, tbody);
  segWrap.appendChild(table);

  resultsEl.innerHTML = "";
  resultsEl.append(cards, segWrap);
}

// The picker UI: two coordinate inputs + "Use map click" toggle + Run button.
function buildPanelBody(container, app) {
  const wrap = document.createElement("div");
  wrap.className = "bike-panel";

  const intro = document.createElement("p");
  intro.className = "bike-intro";
  intro.textContent =
    "Fastest bicycle route between two points. Enter coordinates (lon,lat) or drop pins by clicking the map.";
  wrap.appendChild(intro);

  // Mode toggle
  const modeRow = document.createElement("div");
  modeRow.className = "bike-mode";
  const modeBtn = document.createElement("button");
  modeBtn.type = "button";
  modeBtn.className = "bike-btn bike-btn-ghost";
  modeBtn.textContent = "Drop pins on map: OFF";
  let pickMode = false;
  let pickWhich = null; // "start" | "end"

  modeBtn.addEventListener("click", () => {
    pickMode = !pickMode;
    if (pickMode) {
      pickWhich = !startInput.value ? "start" : "end";
      modeBtn.textContent = `Pick ${pickWhich} (click map)`;
      modeBtn.classList.add("is-on");
      if (mapInstance && mapInstance.getCanvas) {
        mapInstance.getCanvas().style.cursor = "crosshair";
      }
    } else {
      modeBtn.textContent = "Drop pins on map: OFF";
      modeBtn.classList.remove("is-on");
      if (mapInstance && mapInstance.getCanvas) {
        mapInstance.getCanvas().style.cursor = "";
      }
    }
  });
  modeRow.appendChild(modeBtn);
  wrap.appendChild(modeRow);

  function field(label, placeholder, inputEl) {
    const f = document.createElement("label");
    f.className = "bike-field";
    const l = document.createElement("span");
    l.textContent = label;
    inputEl.className = "bike-input";
    inputEl.placeholder = placeholder;
    f.append(l, inputEl);
    return f;
  }

  const startInput = document.createElement("input");
  const endInput = document.createElement("input");

  wrap.appendChild(
    field("Start (lon, lat)", "13.4132, 52.5220", startInput),
  );
  wrap.appendChild(field("End (lon, lat)", "13.3777, 52.5169", endInput));

  const runBtn = document.createElement("button");
  runBtn.type = "button";
  runBtn.className = "bike-btn bike-btn-primary";
  runBtn.textContent = "Find fastest bike route";
  const status = document.createElement("div");
  status.className = "bike-status";

  runBtn.addEventListener("click", async () => {
    const parse = (s) => {
      const parts = s.split(",").map((x) => parseFloat(x.trim()));
      if (parts.length !== 2 || parts.some((n) => !isFinite(n))) return null;
      return parts; // [lon, lat]
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
      const metrics = buildMetrics(samples, elevations);
      const result = {
        coordinates: samples,
        duration: route.duration,
        metrics,
        terrain: terrainLabel(metrics.summary),
      };
      drawRoute(samples);
      renderResults(resultsEl, result);
      status.textContent = `Done — ${fmtDistance(metrics.summary.total)} in ${fmtDuration(route.duration)}.`;
      status.className = "bike-status bike-status-ok";
    } catch (err) {
      console.error("[bike-route] route failed", err);
      status.textContent = `Error: ${err.message || err}`;
      status.className = "bike-status bike-status-err";
    } finally {
      runBtn.disabled = false;
    }
  });

  wrap.appendChild(runBtn);
  wrap.appendChild(status);

  const resultsEl = document.createElement("div");
  resultsEl.className = "bike-results";
  wrap.appendChild(resultsEl);

  // Map click handler for pin dropping.
  function onClick(e) {
    if (!pickMode || !pickWhich) return;
    const ll = e.lngLat;
    const txt = `${ll.lng.toFixed(5)}, ${ll.lat.toFixed(5)}`;
    if (pickWhich === "start") {
      startInput.value = txt;
      if (mapInstance && mapInstance.getCanvas) {
        new window.maplibregl.Marker({ color: "#1c7ed6" })
          .setLngLat([ll.lng, ll.lat])
          .addTo(mapInstance);
      }
    } else {
      endInput.value = txt;
      if (mapInstance && mapInstance.getCanvas) {
        new window.maplibregl.Marker({ color: "#e03131" })
          .setLngLat([ll.lng, ll.lat])
          .addTo(mapInstance);
      }
    }
    pickMode = false;
    pickWhich = null;
    modeBtn.textContent = "Drop pins on map: OFF";
    modeBtn.classList.remove("is-on");
    if (mapInstance && mapInstance.getCanvas) {
      mapInstance.getCanvas().style.cursor = "";
    }
  }

  // Wire the map click once the map is available.
  if (mapInstance && mapInstance.on) {
    mapInstance.on("click", onClick);
  }

  container.appendChild(wrap);
  return () => {
    if (mapInstance && mapInstance.off) mapInstance.off("click", onClick);
  };
}

// ---------------------------------------------------------------------------
// Map control (MapLibre IControl)
// ---------------------------------------------------------------------------

const control = {
  _container: null,
  _map: null,
  onAdd(map) {
    mapInstance = map;
    const container = document.createElement("div");
    container.className =
      "maplibregl-ctrl maplibregl-ctrl-group bike-route-control";

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
      if (appApi?.openRightPanel) {
        appApi.openRightPanel(RIGHT_PANEL_ID);
      } else {
        button.classList.toggle("is-active");
      }
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

    const keep = (dispose) => {
      if (typeof dispose === "function") disposers.push(dispose);
    };

    keep(
      app.registerRightPanel?.({
        id: RIGHT_PANEL_ID,
        title: "Bike Route",
        defaultWidth: 360,
        render: (container) => buildPanelBody(container, app),
      }),
    );

    keep(
      app.registerToolbarMenu?.({
        id: `${PLUGIN_ID}-menu`,
        label: "Bike Route",
        items: [
          {
            id: "open",
            label: "Open route planner",
            disabled: !app.openRightPanel,
            onSelect: () => app.openRightPanel?.(RIGHT_PANEL_ID),
          },
          {
            id: "clear",
            label: "Clear map overlays",
            onSelect: () => clearOverlays(),
          },
        ],
      }),
    );
  },
  deactivate(app) {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch (err) {
        console.error("[bike-route] cleanup failed", err);
      }
    }
    clearOverlays();
    app.removeMapControl(control);
    appApi = null;
  },
};

export default plugin;
