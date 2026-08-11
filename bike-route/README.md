# GeoLibre Bike Route plugin

Find the **fastest bicycle route** between two points in GeoLibre and get a
full readout of the ride: distance, estimated time, elevation gain/loss,
min/max elevation, a terrain breakdown (flat / rolling / hilly / steep), and a
per-segment grade table. The route is drawn on the map with start/end pins.

## What it does

- Routes with the OSRM `bicycle` profile (fastest, not shortest).
- Samples elevation along the route with the Open-Meteo elevation API.
- Reports:
  - Distance, estimated riding time
  - Total ascent / descent
  - Min / max elevation
  - Overall terrain label (Flat / Rolling / Hilly / Mixed)
  - A terrain-breakdown bar chart (share of distance spent flat, rolling, hilly, steep)
  - A per-segment table: distance, elevation change, grade %, and terrain class
- Draws the route line on the map and drops blue (start) / red (end) pins, then fits the view to the route.
- "Drop pins on map" mode: click the map to set start/end instead of typing coordinates.

## Install (no build step needed)

This plugin is a self-contained ES module, so you can install it straight from
GitHub Pages **without cloning or building anything**.

1. The plugin is published at:
   `https://pages.github.io/...` (see the exact URL below after deploy)
   Manifest: `<repo>/plugin.json` served over HTTPS with CORS.
2. In GeoLibre: **Settings → Manage Plugins → Settings** (the extra-sources
   section) → add a **manifest URL**:
   `https://<pages-url>/plugin.json`
3. Switch to the **All** tab, find **Bike Route**, and click **Install**.

If you host the three files (`index.js`, `plugin.json`, `style.css`) anywhere
over HTTPS, just point the manifest URL at that `plugin.json` instead.

### Local test (desktop app)

Put the folder somewhere and add it as a **local directory** source in
Settings → Manage Plugins → Settings, or copy it into the desktop plugins dir
(`~/.local/share/org.geolibre.desktop/plugins/geolibre-bike-route/`) and restart.

## Files

- `index.js` — the whole plugin (routing + elevation + UI + map draw).
- `plugin.json` — the manifest; `entry`/`style` paths are relative to it.
- `style.css` — theme-aware styling (GeoLibre design tokens, light/dark).

## Data sources

Both are keyless and CORS-enabled (`Access-Control-Allow-Origin: *`):

- **Routing:** OSRM demo server, `bicycle` profile —
  `https://router.project-osrm.org`
- **Elevation:** Open-Meteo elevation API —
  `https://api.open-meteo.com/v1/elevation`

These are public demo endpoints with no SLA. To use your own backends, edit the
`CONFIG` block at the top of `index.js`:

```js
const CONFIG = {
  routingBase: "https://router.project-osrm.org/route/v1",
  profile: "bicycle",            // "bicycle" | "foot" | "driving"
  elevationBase: "https://api.open-meteo.com/v1/elevation",
  maxElevationSamples: 200,
  timeoutMs: 25000,
};
```

A self-hosted OSRM/Valhalla or an OpenTopoData/Mapzen elevation tile server
works the same way — keep the same response shapes.

## Plugin API surface used

- `app.addMapControl` / `app.removeMapControl` — the map control (MapLibre
  IControl); `onAdd(map)` captures the map instance so the plugin can draw the
  route and read clicks.
- `app.registerRightPanel` — the route-planner sidebar.
- `app.registerToolbarMenu` — a "Bike Route" menu with Open / Clear actions.
- `app.openRightPanel` — open the panel from the control button.

All optional host APIs are called with `?.` so the plugin degrades gracefully
on older hosts.

## Notes / limitations

- OSRM `bicycle` is a car-ish weighting with bike allowances; it avoids
  motorways but does not know bike-specific surfaces or dedicated lanes. Swap in
  a bike-aware backend (e.g. Valhalla `bicycle`, GraphHopper) for true bike
  routing.
- Open-Meteo elevation is ~30–90 m resolution (SRTM/NASADEM); short, punchy
  hills may be smoothed out.
- Elevation is sampled at up to 200 points along the route, so very long routes
  average the grade over longer segments.
