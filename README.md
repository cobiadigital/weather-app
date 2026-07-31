# Bendar.app 🌧️

**Ben's instant radar and weather app** ([bendar.app](https://bendar.app)) — a
tiny mobile-first web app for checking your **local weather radar**, built as a
**Cloudflare Worker**. It shows live radar over a map, plus any active
National Weather Service alerts for your location, and a `/tropics` page with
tropical-cyclone model tracks, the NHC official forecast, and optional NHC
hazard overlays (TS wind arrival, probabilistic winds, storm-surge inundation).

All data is public and comes from **NOAA / the National Weather Service**:

- **Radar** — the default is **NOAA MRMS** quality-controlled base reflectivity
  (1 km, ~2-min updates), served through the Worker as on-device-cached tiles.
  A NEXRAD composite and other products (composite reflectivity, precip type,
  echo tops) from the
  [Iowa Environmental Mesonet](https://mesonet.agron.iastate.edu/) are also
  selectable in settings.
- **Alerts** — the [NWS API](https://www.weather.gov/documentation/services-web-api)
  (`api.weather.gov`), proxied through the Worker so it can send a proper
  `User-Agent` and cache responses at the edge.

## Features

- Full-screen dark map with a live radar overlay (NOAA MRMS by default)
- **Radar products** — a settings sheet to switch base reflectivity (MRMS or
  NEXRAD), composite reflectivity, precipitation type, or echo tops
- **My location** button (uses your device GPS) and remembers your last spot.
  Once a location is set, the location controls collapse to a small pin in the
  top bar (tap it to re-center or change location)
- **ZIP-code fallback** for when location services are off — a tiny offline
  lookup table (`public/zip3.json`) maps the ZIP's 3-digit prefix to a lat/lon
  and recenters the map. It stays hidden until a locate attempt fails
- Radar **opacity slider** and manual **refresh**; radar auto-refreshes every 5 min
- **Loop 2h** — animate the last 2 hours of radar with a play/pause + scrubber
  and a timestamp. On the MRMS default, frames you've already viewed replay
  instantly from an on-device cache instead of re-downloading
- **Clouds** — optional GOES satellite (infrared) cloud-cover overlay
- **Install** — add it to your home screen as a full-screen app (a native
  prompt on Android/Chrome, guided steps on iOS Safari)
- Active-alert pill that opens a slide-up sheet with alert details
- Designed for phones — iOS Safari safe-area insets, large tap targets,
  dynamic viewport height, no rubber-band scrolling

## Data sources

- **Radar (default: MRMS, cached)** — NOAA's **MRMS** quality-controlled base
  reflectivity (`conus_bref_qcd`, 1 km, ~2-min updates), served through the
  Worker, which re-tiles NCEP's WMS as `{z}/{x}/{y}` and bakes the frame time
  into the URL. The live view and the 2-hour loop share an on-device tile cache
  (Cache Storage API), so frames you've already viewed replay in the loop with
  no re-download. MRMS is CONUS-only, so outside the lower 48 the default falls
  back to the IEM NEXRAD product.
- **Radar (IEM products)** — the NEXRAD N0Q base-reflectivity composite, the
  MRMS hybrid-scan composite, HRRR precipitation type, and echo tops, all tiled
  by the [Iowa Environmental Mesonet](https://mesonet.agron.iastate.edu/). The
  NEXRAD base product's 2-hour loop uses IEM's time-enabled WMS (`n0q-t.cgi`),
  preloading 24 frames (5-minute spacing) in progressive dyadic waves.
- **Clouds** — GOES East infrared satellite composite, also from IEM. This is a
  separate *satellite* product (it shows cloud cover, not precipitation); the
  NEXRAD radar product does not include cloud coverage.
- **Alerts** — the NWS API, proxied through the Worker (see below).
- **ZIP centroids** — `public/zip3.json`, a compact `{ "zip3": [lat, lon] }`
  table keyed by 3-digit ZIP prefix (~900 entries, ~18 KB, lazily fetched only
  when a ZIP is entered). Radar is regional, so a prefix centroid (~30 km
  median from the true ZIP) recenters the map fine at a fraction of the
  payload. Aggregated by prefix from the US Census Bureau's ZCTA centroids via
  the MIT-licensed [`us-zips`](https://www.npmjs.com/package/us-zips) dataset.

## Project layout

```
wrangler.toml      Worker + static-assets config
src/index.js       Worker: /api/nws/* (NWS), /api/nhc/* (hurricanes),
                   /api/mrms/* (MRMS radar tiles)
public/            Static front-end (served automatically at the edge)
  index.html       main radar page
  styles.css
  app.js
  tropics.html     /tropics page (cyclone tracks)
  tropics.js
  zip3.json        3-digit ZIP → lat/lon table
```

Static files in `public/` are served directly by Cloudflare's asset hosting.
Requests that don't match a static file (the `/api/*` routes) fall through to
the Worker in `src/index.js`.

## Deploy from the Cloudflare dashboard (no local tooling needed)

Since Wrangler isn't required to deploy:

1. Push this repo to GitHub.
2. In the Cloudflare dashboard go to **Workers & Pages → Create → Workers**,
   then **Connect to Git** and pick this repository.
3. Cloudflare reads `wrangler.toml` automatically. Leave the build command
   empty (there's no build step) and the deploy command as the default
   (`npx wrangler deploy`).
4. Save & deploy. Every commit to the connected branch redeploys.

Your app will be available at `https://weather-app.<your-subdomain>.workers.dev`.

## Local development (optional)

If you ever want to run it locally:

```sh
npm install
npm run dev      # wrangler dev
npm run deploy   # wrangler deploy
```

## Notes / customization

- If you fork this, update the `USER_AGENT` contact string in `src/index.js` —
  the NWS asks API clients to identify themselves.
- The map base layer is CARTO dark tiles; swap the `L.tileLayer(...)` URL in
  `public/app.js` for a different style if you prefer.
