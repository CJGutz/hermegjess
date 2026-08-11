# GeoLibre Bike Route plugin

A komoot-style bicycle route plugin for GeoLibre. Find the **fastest bike
route** between two points and get a full ride readout: distance, estimated
time, elevation profile, a difficulty rating, turn-by-turn directions, calories,
an estimated surface breakdown, and points of interest (water, bike shops,
viewpoints, peaks) along the way. The route is drawn on the map, coloured by
steepness, with start/end pins; highlights are dropped as clickable pins.

## Features

- **Fastest bike route** via OSRM `bicycle` profile.
- **Distance + estimated time** from the router.
- **Elevation profile** chart (inline SVG) with min/max and total climb.
- **Ascent / descent**, min/max elevation.
- **Terrain breakdown** bars: flat / rolling / hilly / steep (by grade %).
- **Difficulty rating** (Easy / Moderate / Difficult) from distance + climb + steep share.
- **Calorie estimate** (~25 kcal/km + 0.8 kcal per metre climbed).
- **Turn-by-turn directions** with maneuver arrows (from OSRM steps).
- **POIs along the route**: drinking water, bike shops, charging, viewpoints,
  picnic sites, peaks (from Overpass) — clickable on the map.
- **Surface estimate** (paved vs unpaved) from OpenStreetMap surface tags.
- **Place names** for start/end via Photon (komoot's geocoder) reverse lookup.
- **Route colouring** by steepness, start/end pins, fit-to-route view.
- **Drop pins on map** mode + "use map center as end" button.
- Tabs: Overview / Directions / Highlights.

## Install (no build step needed)

The plugin lives in `bike-route/` of `CJGutz/hermegjess`:
`https://github.com/CJGutz/hermegjess/tree/main/bike-route`

### Via jsDelivr CDN (recommended)

In GeoLibre: **Settings → Manage Plugins → Settings** → add a **manifest URL**:

```
https://cdn.jsdelivr.net/gh/CJGutz/hermegjess@main/bike-route/plugin.json
```

Then **All** tab → find **Bike Route** → **Install**.

### Via GitHub Pages (if enabled)

```
https://cjgutz.github.io/hermegjess/bike-route/plugin.json
```

### Host it yourself / local desktop

Put `index.js`, `plugin.json`, `style.css` anywhere over HTTPS with permissive
CORS, or copy the folder into `~/.local/share/org.geolibre.desktop/plugins/geolibre-bike-route/`.

## Data sources (keyless, CORS-enabled)

- Routing: `router.project-osrm.org` (bicycle profile)
- Elevation: `api.open-meteo.com/v1/elevation`
- Reverse geocode: `photon.komoot.io` (komoot's geocoder)
- POIs / surface: `overpass-api.de`

All are public demo endpoints with no SLA. Swap for your own backends in the
`CONFIG` block at the top of `index.js`.

## Testing

`test-harness.mjs` runs the **real** `index.js` in Node against the live APIs,
with a minimal DOM/`fetch` shim, activates the plugin, and clicks "Plan route":
it asserts the route metrics, turn-by-turn list, difficulty badge, and
elevation chart render. Run:

```
node --check index.js && node test-harness.mjs
```

Expected (Berlin Alexanderplatz → Brandenburg Gate): ~3.77 km, ~7 min,
~57 m ascent, 11 turn steps, difficulty "Easy".

## Plugin API surface used

- `app.addMapControl` / `removeMapControl` — the MapLibre control captures the
  map instance (`onAdd(map)`) so the plugin can draw/query the map.
- `app.registerRightPanel` — the route planner sidebar (tabs).
- `app.registerToolbarMenu` — "Bike Route" menu (Open / Clear overlays).

All optional host APIs are called with `?.` so it degrades gracefully.

## Notes / limitations

- OSRM `bicycle` is car-weighted with bike allowances; swap in a bike-aware
  backend (Valhalla/GraphHopper) for true bike routing.
- Elevation is SRTM/NASADEM-scale (~30–90 m); per-vertex grade is smoothed and
  measured over a 50 m window to reflect real terrain.
- Surface is an area estimate from OSM tags near the route, not per-segment.
- Overpass/Photon are best-effort: a timeout there won't fail the core route.
