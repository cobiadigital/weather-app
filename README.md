# Local Radar 🌧️

A tiny mobile-first web app for checking your **local weather radar**, built as a
**Cloudflare Worker**. It shows live NEXRAD radar over a map, plus any active
National Weather Service alerts for your location.

All data is public and comes from the **National Weather Service**:

- **Radar** — NEXRAD base-reflectivity composite from the
  [Iowa Environmental Mesonet](https://mesonet.agron.iastate.edu/), which
  processes and tiles the NWS NEXRAD Level III (N0Q) product.
- **Alerts** — the [NWS API](https://www.weather.gov/documentation/services-web-api)
  (`api.weather.gov`), proxied through the Worker so it can send a proper
  `User-Agent` and cache responses at the edge.

## Features

- Full-screen dark map with a live radar overlay
- **My location** button (uses your device GPS) and remembers your last spot
- Radar **opacity slider** and manual **refresh**; radar auto-refreshes every 5 min
- Active-alert pill that opens a slide-up sheet with alert details
- Designed for phones — iOS Safari safe-area insets, large tap targets,
  dynamic viewport height, no rubber-band scrolling

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

Your app will be available at `https://weather-radar.<your-subdomain>.workers.dev`.

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
