# Bendar.app 🌧️

**Ben's instant radar and weather app** ([bendar.app](https://bendar.app)) — a
tiny mobile-first web app for checking your **local weather radar**, built as a
**Cloudflare Worker**. It shows live NEXRAD radar over a map, plus any active
National Weather Service alerts for your location, and a `/tropics` page with
tropical-cyclone model tracks, the NHC official forecast, and optional NHC
hazard overlays (TS wind arrival, probabilistic winds, storm-surge inundation).

All data is public and comes from the **National Weather Service**:

- **Radar** — NEXRAD base-reflectivity composite from the
  [Iowa Environmental Mesonet](https://mesonet.agron.iastate.edu/), which
  processes and tiles the NWS NEXRAD Level III (N0Q) product.
- **Alerts** — the [NWS API](https://www.weather.gov/documentation/services-web-api)
  (`api.weather.gov`), proxied through the Worker so it can send a proper
  `User-Agent` and cache responses at the edge.

## Features

- Full-screen dark map with a live radar overlay
- **My location** button (uses your device GPS) and remembers your last spot.
  Once a location is set, the location controls collapse to a small pin in the
  top bar (tap it to re-center or change location)
- **ZIP-code fallback** for when location services are off — an offline lookup
  table (`public/zipcodes.json`) maps the ZIP to a lat/lon and recenters the
  map. It stays hidden until a locate attempt fails
- Radar **opacity slider** and manual **refresh**; radar auto-refreshes every 5 min
- **Loop 2h** — animate the last 2 hours of radar with a play/pause + scrubber
  and a timestamp, so you can see where the weather is heading
- **Clouds** — optional GOES satellite (infrared) cloud-cover overlay
- **Install** — add it to your home screen as a full-screen app (a native
  prompt on Android/Chrome, guided steps on iOS Safari)
- Active-alert pill that opens a slide-up sheet with alert details
- Designed for phones — iOS Safari safe-area insets, large tap targets,
  dynamic viewport height, no rubber-band scrolling

## Data sources

- **Radar (live + loop)** — NEXRAD N0Q base-reflectivity composite from the
  [Iowa Environmental Mesonet](https://mesonet.agron.iastate.edu/). The live
  view uses IEM's current tile cache; the loop uses IEM's time-enabled NEXRAD
  WMS (`n0q-t.cgi`) to preload the past 12 frames (10-minute spacing).
- **Clouds** — GOES East infrared satellite composite, also from IEM. This is a
  separate *satellite* product (it shows cloud cover, not precipitation); the
  NEXRAD radar product does not include cloud coverage.
- **Alerts** — the NWS API, proxied through the Worker (see below).
- **ZIP centroids** — `public/zipcodes.json`, a compact `{ "zip": [lat, lon] }`
  table (~34k US ZIPs, coords rounded to 4 decimals, lazily fetched only when a
  ZIP is entered). Derived from the US Census Bureau's ZCTA centroids via the
  MIT-licensed [`us-zips`](https://www.npmjs.com/package/us-zips) dataset.

## Project layout

```
wrangler.toml      Worker + static-assets config
src/index.js       Worker: serves /api/nws/* proxy to api.weather.gov
public/            Static front-end (served automatically at the edge)
  index.html
  styles.css
  app.js
```

Static files in `public/` are served directly by Cloudflare's asset hosting.
Requests that don't match a static file (i.e. `/api/nws/*`) fall through to the
Worker in `src/index.js`.

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
