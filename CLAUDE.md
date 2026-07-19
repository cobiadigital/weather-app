# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**Bendar.app** — a mobile-first web app for viewing local NEXRAD weather radar
and active National Weather Service alerts. It's deployed as a **Cloudflare
Worker** using **Static Assets**. All data is public and comes from the NWS.

## Architecture

- **`public/`** — the entire front-end (plain HTML/CSS/JS, no framework, no
  build step). Cloudflare's static-asset hosting serves these files directly at
  the edge. Requests that don't match a file fall through to the Worker.
  - `index.html` — markup; loads Leaflet from unpkg (with SRI hashes).
  - `styles.css` — mobile-first styles tuned for iOS Safari.
  - `app.js` — Leaflet map, radar layer, geolocation, alerts, refresh logic.
  - `tropics.html` / `tropics.js` — a second, standalone page served at
    `/tropics` (Cloudflare `html_handling` maps `/tropics` → `tropics.html`).
    Shows active Atlantic + East Pacific tropical cyclones with their model
    ("spaghetti") tracks and the NHC official forecast. Reuses `styles.css` +
    the same Leaflet/CARTO setup; page-specific CSS is inline in `tropics.html`.
- **`src/index.js`** — the Worker. It handles `/api/nws/*` (proxying
  `https://api.weather.gov`) and `/api/nhc/*` (the National Hurricane Center),
  so it can set the `User-Agent` those services require (browsers can't set that
  header) and cache responses at the edge.
- **`wrangler.toml`** — binds `public/` as static assets and points `main` at
  the Worker.

## Data sources

- **Radar tiles (live)** — Iowa Environmental Mesonet NEXRAD N0Q composite:
  `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png`
  (standard web-mercator `{z}/{x}/{y}` tiles; refreshes ~every 5 min).
- **Radar loop (last 2 h)** — IEM's time-enabled NEXRAD WMS
  `https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi`, layer
  `nexrad-n0q-wmst`, driven by the WMS `TIME` parameter (5-minute archive).
  `app.js` preloads one `L.tileLayer.wms` per 10-minute frame (12 layers, all
  added at opacity 0) and animates by toggling opacity between already-loaded
  layers, so frames don't flash blank while tiles load. It's a different
  endpoint than the live tile cache above.
- **Clouds (satellite)** — GOES East infrared composite, also from IEM:
  `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/goes-ir-4km-900913/{z}/{x}/{y}.png`.
  NEXRAD is precipitation only, so cloud cover comes from this separate GOES
  satellite product (companions exist: `goes-vis-1km-900913`,
  `goes-wv-4km-900913`).
- **Alerts / conditions** — the NWS API (`api.weather.gov`), always reached via
  the Worker proxy at `/api/nws/...`, never called directly from the browser.
- **Tropical cyclones (the `/tropics` page)** — the National Hurricane Center,
  proxied via `/api/nhc/...` (never called directly from the browser):
  - `GET /api/nhc/current` → NHC `CurrentStorms.json`, filtered to the Atlantic
    (`al`) + East Pacific (`ep`) basins. Positions, intensity, movement, and
    links to the official advisory/cone/discussion.
  - `GET /api/nhc/adeck?id=<stormId>` → the storm's ATCF "a-deck"
    (`https://ftp.nhc.noaa.gov/atcf/aid_public/a<id>.dat.gz`), a gzip'd text file
    of every forecast aid. The Worker gunzips it (`DecompressionStream`), keeps
    the latest synoptic cycle, and returns a **GeoJSON FeatureCollection** — one
    `LineString` per model (GFS, ECMWF, UKMET, HWRF, HMON, consensus aids, …)
    plus the official forecast (`OFCL`/`OFCI`, styled distinctly) — so the
    browser needs no ZIP/KML parser. `id` is validated (`^[a-z]{2}\d{6}$`) to
    prevent SSRF; any upstream/parse failure degrades to an empty collection so
    the page still shows the current-position markers.
  - `GET /api/nhc/gis[?layers=cone,watches]` → NOAA tropical MapServer
    (`…/NHC_tropical_weather_summary/MapServer`) queried as GeoJSON for the
    official forecast cone (layer 7) and coastal wind watches/warnings
    (layer 8, `tcww`). Filtered to AL/EP; bulky MapServer fields stripped.
    Edge-cached 300s. Failures degrade to empty collections.
  - **Hazard overlays on `/tropics` (client-side MapServer `/export`)** — the
    same NOAA tropical MapServer, loaded as viewport PNG image overlays so the
    browser gets official NHC symbology/labels without pulling multi‑MB
    GeoJSON (and so inundation, a raster mosaic, works at all):
    - Arrival Time of TS Winds — layers 18 (earliest reasonable) + 19 (most
      likely)
    - Probabilistic Winds — layers 30 / 31 / 32 (34 / 50 / 64 kt); the Winds
      button cycles thresholds
    - Inundation — layer 21 (storm-surge inundation mosaic; empty when NHC
      has not issued a product)
    Toggles default off. The Worker does not proxy these; Leaflet
    `imageOverlay` hits MapServer directly (images don't need CORS).
- **ZIP centroids (location fallback)** — `public/zipcodes.json`, a static
  `{ "zip": [lat, lon] }` table (~34k US ZIPs, 4-decimal coords). `app.js`
  fetches it lazily (only when a ZIP is entered) and memoizes it, so the ~0.9 MB
  file never loads unless used. It's how the app recenters when geolocation is
  off/denied. Regenerate from the MIT-licensed `us-zips` npm dataset (US Census
  ZCTA centroids) if it needs refreshing.

## PWA / install

`public/manifest.webmanifest` + `public/icons/*` make the app installable.
`index.html` links the manifest and an `apple-touch-icon`. The **Install**
button uses the `beforeinstallprompt` event on Android/Chrome and falls back to
an iOS "Add to Home Screen" instructions sheet. Icons are generated PNGs — if
you change the icon, regenerate all sizes (192, 512, maskable-512, 180 apple).

## Conventions & constraints

- **No build step.** Keep it that way — dashboard Git deploys run
  `npx wrangler deploy` with an empty build command. Don't introduce a bundler
  or framework unless explicitly asked.
- **Vanilla JS**, IIFE-wrapped in `app.js`. Match the existing plain-DOM,
  no-dependency style. Escape any NWS-supplied text before inserting it into
  the DOM (see `esc()`).
- **Mobile-first / iOS Safari.** Preserve the safe-area insets
  (`env(safe-area-inset-*)`), `100dvh` usage, ≥44–48px tap targets, and the
  no-rubber-band-scroll setup. Test changes against a narrow (phone) viewport.
- If you bump the Leaflet version, recompute the SRI `integrity` hashes in
  `index.html` (unpkg is blocked in this sandbox; fetch the file from the npm
  registry via `npm pack leaflet@<ver>` and hash `dist/` with
  `openssl dgst -sha256 -binary | openssl base64`).
- If the app is forked, update the `USER_AGENT` contact string in
  `src/index.js` — the NWS asks clients to identify themselves.

## Deploying

Deploy is via the Cloudflare dashboard's Git integration (Workers & Pages →
Connect to Git). Every commit to the connected branch redeploys. No local
Wrangler is required. See `README.md` for the step-by-step.

## Local dev (optional)

```sh
npm install
npm run dev      # wrangler dev
npm run deploy   # wrangler deploy
```
