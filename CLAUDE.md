# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**Bendar.app** — a mobile-first web app for viewing local weather radar (NOAA
MRMS by default, plus NEXRAD and other products) and active National Weather
Service alerts. It's deployed as a **Cloudflare Worker** using **Static
Assets**. All data is public and comes from NOAA / the NWS.

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
  `https://api.weather.gov`), `/api/nhc/*` (the National Hurricane Center),
  `/api/mrms/*` + `/api/site/*` (re-tiling NCEP's MRMS mosaic and single-radar
  WMS — see below), `/api/glm/*` (GOES lightning tiles) and `/api/legend/*`, so
  it can set the `User-Agent` those services require (browsers can't set that
  header), re-tile where needed, and cache responses at the edge.
- **`wrangler.toml`** — binds `public/` as static assets and points `main` at
  the Worker.

## Data sources

The settings sheet has 5 selectable **mosaic** products — **Base Reflectivity
(MRMS)** (the default), **Base Reflectivity (NEXRAD)**, **Composite
Reflectivity**, **Precipitation Type**, **Echo Tops** — plus a **single radar
site** picker (any of 201 individual NEXRAD/TDWR radars, see its own bullet
below). The 4 MRMS-backed mosaics and every site product share the
Worker-proxied, cached pipeline (the "Radar (MRMS, cached)" bullet); NEXRAD
base reflectivity is IEM-sourced with its own time-enabled WMS loop.

- **Radar tiles (IEM NEXRAD, live)** — Iowa Environmental Mesonet NEXRAD N0Q
  composite (the "Base Reflectivity (NEXRAD)" product):
  `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png`
  (standard web-mercator `{z}/{x}/{y}` tiles; refreshes ~every 5 min).
- **Radar loop (last 2 h, IEM NEXRAD)** — IEM's time-enabled NEXRAD WMS
  `https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi`, layer
  `nexrad-n0q-wmst`, driven by the WMS `TIME` parameter (5-minute archive).
  `app.js` builds one `L.tileLayer.wms` per 5-minute frame (24 layers, all at
  opacity 0 except the visible one) and animates by toggling opacity between
  already-loaded layers, so frames don't flash blank while tiles load. Frames
  are loaded **progressively in dyadic waves** (`LOOP_STRIDES = [8,4,2,1]`):
  every 8th frame first — a coarse, wide-spaced loop that starts playing after
  just ~3 frames — then every 4th, 2nd, and finally all 24, each wave doubling
  the temporal resolution down to the native 5-minute spacing. A wave's layers
  are only added to the map (which is what starts their tile requests) once the
  previous, coarser wave has finished, and the animating set grows as each wave
  lands, so the loop densifies mid-play without ever waiting on a blank frame.
  It's a different endpoint than the live tile cache above.
- **Radar (MRMS, cached)** — NCEP's GeoServer (`opengeo.ncep.noaa.gov`,
  `conus` workspace) publishes exactly 4 MRMS layers, and all 4 are wired up as
  products, each `RADAR_PRODUCTS` entry naming its Worker route key via
  `mrmsLayer` (see `MRMS_LAYERS` in `src/index.js` for the real GeoServer layer
  name each maps to):
  - `mrmsLayer: "base"` → `conus_bref_qcd` — **Base Reflectivity (MRMS)**, the
    default on page open (`DEFAULT_PRODUCT = "mrms"`).
  - `mrmsLayer: "composite"` → `conus_cref_qcd` — **Composite Reflectivity**.
  - `mrmsLayer: "ptype"` → `conus_pcpn_typ` — **Precipitation Type**.
  - `mrmsLayer: "eet"` → `conus_neet_v18` — **Echo Tops**.

  NCEP's GeoServer only speaks WMS `GetMap` (arbitrary bbox), so the Worker
  re-tiles each layer as `{z}/{x}/{y}` and **bakes the frame time into the
  URL**:
  - `GET /api/mrms/{product}/frames` → that layer's advertised `time`
    dimension (a rolling ~2 h list of ~2-minute instants) as a sorted ISO
    array. `{product}` is one of `base`/`composite`/`ptype`/`eet`. Both the
    live view and the loop snap to these canonical times.
  - `GET /api/mrms/{product}/{z}/{x}/{y}.png?t=<iso>` → one 256px tile,
    rendered by NCEP for that tile's EPSG:3857 bbox at frame `t` (WMS 1.1.1, so
    BBOX axis order is x,y). Immutable per `(product,z,x,y,t)`, so it's
    edge-cached hard. `{product}` is checked against the `MRMS_LAYERS`
    allowlist before being used to build the upstream request.

  Because the live tile URL now carries the timestamp (IEM's live tiles are
  timeless), a frame the live view fetched can be **reused by the loop**.
  `app.js` wraps every MRMS layer in a `cachedTileLayer` (a `L.TileLayer`
  subclass) that reads/writes the **Cache Storage API** (`mrms-tiles-v1`,
  shared across all 4 products — the URL's `{product}` segment keeps entries
  distinct): cache-first tile loads, so tapping **Loop 2h** replays frames
  already on the device with no re-download, and the cache persists across
  reloads. The live view pins to the newest canonical frame for its product
  (re-pinned on each 5-min refresh, the same cadence at which the cache
  accumulates frames), and the loop's newest slot snaps to that exact frame —
  guaranteeing the current view is a cache hit. Everything degrades to plain
  network tiles where Cache Storage is unavailable (e.g. private mode). Frame
  lists are memoized per source (`framesByKey`, keyed by `tileSource().key`),
  since each product — and each radar — updates on its own schedule.

  **Cache budget (`evictTileCache`).** The 2 h window alone doesn't bound
  *size*: one loop is ~288 tiles (~8 MB), and with 201 sites × 8 products
  sweeping a few radars would pile up hundreds of MB inside the window —
  enough for iOS Safari to evict the whole bucket. So eviction is two passes:
  age out anything past `MRMS_CACHE_WINDOW_MS` (**including entries whose `?t=`
  is missing or unparseable** — those used to linger forever), then cap the
  total at `TILE_CACHE_MAX_ENTRIES` (800 ≈ 23 MB), trimming to
  `TILE_CACHE_TRIM_TO` (600, hysteresis so a sweep isn't re-triggered by the
  next tile). Overflow is shed **from products the user isn't looking at
  first, oldest frame first**, so the active loop — the whole point of the
  cache — survives. `navigator.storage.estimate()` is consulted as an advisory
  backstop that only ever tightens the target. Sweeps run on prime, refresh,
  product switch, and after the final loop wave lands (the biggest allocator).

  All 4 MRMS layers cover the **lower 48 only**. When the map is centered
  outside CONUS (Alaska, Hawaii, Puerto Rico, …), each MRMS-backed product
  silently falls back to the product it replaced: `MRMS_FALLBACK` maps
  `mrms → base` (IEM NEXRAD, a visible product in its own right) and
  `composite/ptype/eet → …Iem` (hidden `RADAR_PRODUCTS` entries — the original
  IEM configs, not rendered in settings, that these products replaced — see
  `compositeIem`/`ptypeIem`/`eetIem`). `app.js` splits `selectedProduct()` (the
  persisted choice, drives the settings radio) from `currentProduct()` →
  `effectiveProductId()` (what's shown; applies the fallback). The live layer
  is rebuilt on every `moveend` that crosses the CONUS box; the fallback only
  applies to MRMS-backed products, not to an explicitly-chosen IEM product.
- **Radar (single site)** — the same NCEP GeoServer also publishes **201
  individual radars**, one workspace per site (`kmob`, `ktlx`, `tatl`, …), each
  with its own time dimension (~20 frames over ~2 h at the radar's ~6-minute
  volume-scan cadence). Two radar types, with different products:
  - **156 WSR-88D (NEXRAD)** — `sr_bref` (super-res base reflectivity),
    `sr_bvel` (base radial velocity — the app's only view of storm
    **rotation**), `bdhc` (dual-pol hydrometeor classification), `bdsa` (storm
    total precip), `boha` (1-hour accumulation).
  - **45 TDWR** — `bref1`, `brefl` (long range), `bvel`.

  Worker routes mirror the MRMS ones: `GET /api/site/{site}/{product}/frames`
  and `GET /api/site/{site}/{product}/{z}/{x}/{y}.png?t=<iso>`. The site id is
  both the GeoServer workspace and the layer prefix (`<site>_<product>`).
  **`SITE_RE = /^[kpt][a-z0-9]{3}$/` is the security boundary** — 4 chars from
  that class can't contain a slash, dot, colon or percent, so a site id
  provably cannot escape its path segment; the product is a closed allowlist
  (`SITE_PRODUCTS`). Only validated values ever reach the upstream URL.
  `GET /api/legend/{product}.png` proxies GeoServer's `GetLegendGraphic`;
  the image depends only on the product's style, so it's rendered from one
  reference site (`LEGEND_REF`) — 8 cache entries rather than 201 × 8.

  Client-side, a site selection is encoded as a **single composite product id**,
  `"site:kmob:sr_bref"`, stored in the same `radar.product` key. That keeps the
  blast radius tiny: every existing invariant is a string comparison, and
  `effectiveProductId()` needs no change (a composite id misses the
  `RADAR_PRODUCTS` lookup and is returned verbatim, so site products correctly
  never off-CONUS-fallback). `productById()` resolves an id to either a
  `RADAR_PRODUCTS` entry or a memoized synthetic one from `siteProduct()`, and
  **`tileSource(p)` is the single discriminator** every layer/loop/refresh path
  uses to pick between the MRMS route, the site route, and plain IEM tiles.
  `public/radar-sites.json` (~7.7 KB, `{site: [lat, lon, name, type]}`,
  generated from NCEP's workspace list ∩ `api.weather.gov/radar/stations`) is
  fetched lazily — a cold start on a mosaic never requests it.

  Sites are chosen by **tapping a marker on the map** (201 entries is far too
  many for a list): `enterSitePicking()` renders viewport-culled markers capped
  at `SITE_MARKER_MAX`, using 4 shared `L.divIcon`s so 200 markers aren't 200
  allocations. The selected radar keeps a marker plus a dashed **coverage ring**
  (`SITE_RANGE_KM`), which is what makes "why is it blank over there" obvious.
  Panning outside that range shows a prompt offering the nearest radar but
  **never switches automatically** — the user picked this one. The one
  exception is an **outage**: if a site's frame list comes back empty the radar
  isn't reporting (indistinguishable on screen from clear skies), so
  `siteOutage` temporarily forces the mosaic via `effectiveProductId()` while
  leaving the saved choice alone, so the site returns by itself.
- **Lightning (GOES GLM)** — an optional overlay (the **Lightning** toggle),
  not a radar product: it draws *on top of* whatever radar is selected.
  **`api.weather.gov` has no lightning data at all** — NWS licenses its
  ground-strike feed (Vaisala NLDN) commercially and can't redistribute it, and
  NCEP's GeoServer publishes none either. The public alternative is **GLM**, the
  optical lightning mapper on GOES, which sees *total* lightning (in-cloud and
  cloud-to-ground). The raw L2 granules on AWS are netCDF-4/HDF5 every 20 s —
  unparseable in a Worker without a WASM HDF5 reader, which the no-build-step
  rule rules out — so tiles come from UW-Madison SSEC's **RealEarth**, which
  already renders the `GOESEastGLMFEDRadC` product (flash extent density: how
  many flashes hit each ~10 km cell in the last 5 minutes, republished every
  minute) as a Web Mercator XYZ pyramid.
  - `GET /api/glm/{product}/frames` → RealEarth's `/api/times` converted to the
    same sorted-ISO shape `/api/mrms/*/frames` returns, windowed to 2 h.
    `{product}` is checked against the `GLM_PRODUCTS` allowlist.
  - `GET /api/glm/{product}/{z}/{x}/{y}.png?t=<iso>` → proxies
    `realearth…/tiles/{product}/{YYYYMMDD}/{HHMMSS}/{z}/{x}/{y}.png`. The
    upstream path segments are rebuilt from the *parsed* `t`, so only digits we
    generated ourselves reach the outbound URL. Unlike MRMS there's nothing to
    re-tile — the proxy exists to set a real `cache-control` (RealEarth sends
    `no-store`) and keep the browser off a third-party host.

  Client-side it deliberately stays *outside* the Cache Storage pipeline: there
  is no lightning loop to replay, and a new frame every minute would churn the
  tile budget the radar loop depends on (`tileUrlPrefix` would also rank every
  GLM entry as non-active and shed it first). Immutable `?t=` URLs mean the
  ordinary HTTP cache still does the work. `refreshLightning()` polls on a
  1-minute timer while the overlay is on, and passes `maxAgeMs: 0` to
  `ensureFrames` — on the default 60 s memo TTL it would race its own beat and
  sit a frame behind.

  Two rendering details that are easy to regress:
  - RealEarth renders FED with a blue→green→red ramp, near enough to the
    reflectivity ramp beneath it that the two are genuinely confusable, so the
    overlay is re-rendered. `GLM_STYLE` in `app.js` picks how:
    - `"firefly"` (default) — `glmDotTileLayer` makes each tile a `<canvas>`,
      reads the source pixels, and redraws the frame as one spark per ~10 km
      cell: a hot near-white core with a warm halo, its size scaled by that
      cell's value (`cellIntensity` recovers the value by inverting the ramp —
      hue 240° is the bottom of the scale, 0° the top). Sparks are drawn with
      `lighter` so overlapping halos build up, and the layer screen-blends over
      the map, which is the point: flat paint of any colour gets lost over the
      yellows and reds of heavy reflectivity — exactly where the lightning is —
      but light only ever brightens what's beneath it. Sparks grow with the map
      up to `GLM_DOT_CAP_PX`, then hold; uncapped they merge into one wash by
      ~z12. Because the result is baked into the canvas the share compositor
      already draws, screen and shared image agree with no extra work, and the
      `zoomend` → `redraw()` hook is what keeps the cap honest, since Leaflet
      would otherwise just rescale the existing canvases.
      `cellIntensity` counts a source pixel as data only if it has real
      chroma. Transparency alone is not a safe test: RealEarth's "no data"
      tile is a 1-bit PNG whose transparency lives in a tRNS chunk, and a
      decoder that ignores it (iOS Safari did) hands back an opaque *black*
      tile. Reading black as mid-scale painted a full grid of identical sparks
      over every empty tile — lightning where there was none. Black, white and
      grey are never on the ramp, so they are no-data.
    - `"amber"` — leaves the raster alone and recolours it in CSS
      (`.glm-tiles`: `brightness(0)` keeps alpha, the invert/sepia/saturate
      chain rebuilds the hue). A CSS filter is invisible to the canvas, so
      `GLM_CANVAS_FILTER` re-applies it in `drawTileLayer` — keep the two in
      step. `.glm-blend` (the screen blending both styles share) is likewise
      mirrored by `canvasBlend`.
    - `"native"` — untouched, for checking values against RealEarth's legend.
  - The layer sets `maxNativeZoom: 7` (GLM's grid is ~10 km), so its tile coords
    sit *below* the map zoom. `drawTileLayer` therefore keys off
    `layer._tileZoom` and scales, rather than assuming tile z == map zoom —
    without that the share snapshot silently drops the overlay entirely.
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
- **ZIP centroids (location fallback)** — `public/zip3.json`, a static
  `{ "zip3": [lat, lon] }` table keyed by **3-digit ZIP prefix** (~900
  sectional-center centroids, 2-decimal coords, ~18 KB). `app.js` fetches it
  lazily (only when a ZIP is entered), memoizes it, and looks up the entered
  ZIP's first three digits. It's how the app recenters when geolocation is
  off/denied. Radar is regional, so a prefix centroid (median ~30 km from the
  true ZIP) is plenty precise while keeping the payload tiny on cellular — the
  full 5-digit table would be ~0.9 MB. Regenerate from the MIT-licensed
  `us-zips` npm dataset (US Census ZCTA centroids), aggregated by prefix.

## PWA / install

`public/manifest.webmanifest` + `public/icons/*` make the app installable.
`index.html` links the manifest and an `apple-touch-icon`. The **Install**
button uses the `beforeinstallprompt` event on Android/Chrome and falls back to
an iOS "Add to Home Screen" instructions sheet. Icons are generated PNGs — if
you change the icon, regenerate all sizes (192, 512, maskable-512, 180 apple).

## Conventions & constraints

### Mobile first — this is the top constraint, not one of many

**~99% of real usage is on a phone.** Every design decision — layout, type
size, hit areas, spacing, wording length — is made for a one-handed phone user
first. Desktop is an afterthought that happens to work, never the case you
design around. When the two conflict, the phone wins, every time.

Concretely, before you consider any UI change done:

- **Tap targets are ≥44px, and 48px is the house default.** `.btn` already sets
  `min-height: 48px` — match it. Do **not** reuse `.icon-btn` (34px) for
  anything a user has to hit deliberately; it's sized for a compact glyph in a
  header, not for an action button. A 34px control is a bug, not a style
  choice.
- **Text controls get real padding and ≥14px type.** 12px labels crammed into a
  pill are unreadable at arm's length in daylight.
- **Don't crowd a row.** A message plus two buttons on one line collapses badly
  at 390px. Stack, wrap, or give the actions their own full-width row.
- **Respect the safe-area insets** (`env(safe-area-inset-*)`), the `100dvh`
  usage, and the no-rubber-band-scroll setup.
- **Test at a narrow viewport** (390×844 or smaller) — not just a desktop
  window that happens to be narrow. The headless-Chromium harness used for the
  radar work runs at that size; keep it that way.
- Prefer putting new chrome **inside `<footer class="controls">`**, whose flex
  column already handles safe-area spacing and reflows as rows appear and
  collapse. Floating elements with hard-coded offsets collide the moment
  another row (like the loop bar) turns on.

- **No build step.** Keep it that way — dashboard Git deploys run
  `npx wrangler deploy` with an empty build command. Don't introduce a bundler
  or framework unless explicitly asked.
- **Vanilla JS**, IIFE-wrapped in `app.js`. Match the existing plain-DOM,
  no-dependency style. Escape any NWS-supplied text before inserting it into
  the DOM (see `esc()`).
- If you bump the Leaflet version, recompute the SRI `integrity` hashes in
  `index.html` (unpkg is blocked in this sandbox; fetch the file from the npm
  registry via `npm pack leaflet@<ver>` and hash `dist/` with
  `openssl dgst -sha256 -binary | openssl base64`).
- If the app is forked, update the `USER_AGENT` contact string in
  `src/index.js` — the NWS asks clients to identify themselves.

## Deploying

Deploy is via the Cloudflare dashboard's Git integration (Workers & Pages →
Connect to Git). Every commit to the production branch redeploys. No local
Wrangler is required. See `README.md` for the step-by-step.

**Branch previews.** `wrangler.toml` sets `preview_urls = true` and
non-production branch builds are enabled, so each branch gets
`https://<branch-name>-weather-app.cobiadigital.workers.dev` (`/` in the branch
name becomes `-`) plus a per-version URL, both posted to the PR by the
Cloudflare GitHub app. The branch URL is stable across commits; the version one
changes every build, so prefer the branch URL when sharing.

⚠️ A preview URL only keeps a branch **off production** if the Workers Builds
non-production deploy command is `npx wrangler versions upload`. The default
`npx wrangler deploy` publishes to production from whatever branch it builds —
with non-production builds on, that means any branch push overwrites
bendar.app. Check this setting before assuming a branch is safely sandboxed.

## Local dev (optional)

```sh
npm install
npm run dev      # wrangler dev
npm run deploy   # wrangler deploy
```
