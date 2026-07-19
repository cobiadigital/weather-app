/**
 * Weather Radar — Cloudflare Worker
 *
 * Static assets (the front-end in /public) are served automatically by the
 * platform. This Worker only handles the `/api/nws/*` routes, which proxy the
 * National Weather Service API (https://api.weather.gov).
 *
 * Why proxy instead of calling api.weather.gov straight from the browser:
 *   - The NWS asks every client to send a descriptive User-Agent. Browsers
 *     don't let page JS override User-Agent, so we set it here.
 *   - We can cache responses at the edge to stay well within NWS rate limits.
 */

const NWS_BASE = "https://api.weather.gov";

// National Hurricane Center endpoints (used by the /tropics page).
//  - CurrentStorms.json: active tropical cyclones with position/intensity + links.
//  - ATCF "a-deck" (aid_public): per-storm model guidance, one gzip'd text file
//    per storm holding every forecast aid (GFS, ECMWF, HWRF, the OFCL official
//    forecast, consensus aids, …) — i.e. the "spaghetti" model tracks.
//  - NOAA tropical MapServer: official cone + coastal wind watches/warnings as
//    queryable GeoJSON (no KMZ).
const NHC_CURRENT_URL = "https://www.nhc.noaa.gov/CurrentStorms.json";
const NHC_ADECK_BASE = "https://ftp.nhc.noaa.gov/atcf/aid_public/";
const NHC_MAPSERVER =
  "https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer";
// Layer ids on NHC_tropical_weather_summary (see MapServer?f=pjson).
const NHC_GIS_LAYERS = {
  cone: 7,
  watches: 8,
};

// NWS/NHC request a User-Agent that identifies the app and a contact. Update the
// contact if you fork this. See https://www.weather.gov/documentation/services-web-api
const USER_AGENT = "Bendar.app weather app (https://bendar.app)";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname.startsWith("/api/nws/")) {
      return proxyNWS(request, url);
    }

    if (pathname.startsWith("/api/nhc/")) {
      return handleNHC(request, url);
    }

    // Anything else that reaches the Worker (i.e. not a static asset) is a 404.
    return new Response("Not found", { status: 404 });
  },
};

/**
 * Forward a request to api.weather.gov.
 *
 * The path after `/api/nws/` is appended to the NWS base URL, and the original
 * query string is preserved, e.g.
 *   /api/nws/alerts/active?point=39.7,-104.9
 *   -> https://api.weather.gov/alerts/active?point=39.7,-104.9
 *
 * Only GET requests to api.weather.gov are allowed.
 */
async function proxyNWS(request, url) {
  if (request.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  const nwsPath = url.pathname.slice("/api/nws/".length);
  const target = `${NWS_BASE}/${nwsPath}${url.search}`;

  let upstream;
  try {
    upstream = await fetch(target, {
      headers: {
        "User-Agent": USER_AGENT,
        // geo+json is the richest NWS representation; api.weather.gov falls
        // back gracefully for endpoints that don't support it.
        Accept: "application/geo+json,application/json",
      },
      // Cache at the edge. NWS data (alerts, observations) refreshes on the
      // order of minutes, so a short TTL keeps things fresh but cheap.
      cf: { cacheTtl: 60, cacheEverything: true },
    });
  } catch (err) {
    return json({ error: "Failed to reach the National Weather Service" }, 502);
  }

  const body = await upstream.arrayBuffer();
  const headers = new Headers();
  headers.set(
    "content-type",
    upstream.headers.get("content-type") || "application/json"
  );
  headers.set("cache-control", "public, max-age=60");
  headers.set("access-control-allow-origin", "*");

  return new Response(body, { status: upstream.status, headers });
}

// ---------------------------------------------------------------------------
// National Hurricane Center (/api/nhc/*) — powers the /tropics page.
// ---------------------------------------------------------------------------

async function handleNHC(request, url) {
  if (request.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }
  const sub = url.pathname.slice("/api/nhc/".length);
  if (sub === "current") return nhcCurrent();
  if (sub === "adeck") return nhcAdeck(url.searchParams.get("id"));
  if (sub === "gis") return nhcGis(url.searchParams.get("layers"));
  return json({ error: "Not found" }, 404);
}

// Active storms, trimmed to the Atlantic (al) + East Pacific (ep) basins.
async function nhcCurrent() {
  let upstream;
  try {
    upstream = await fetch(NHC_CURRENT_URL, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      cf: { cacheTtl: 60, cacheEverything: true },
    });
  } catch (_) {
    return json({ error: "Failed to reach the National Hurricane Center" }, 502);
  }
  if (!upstream.ok) return json({ activeStorms: [] }, 200, 60);

  let data;
  try {
    data = await upstream.json();
  } catch (_) {
    return json({ activeStorms: [] }, 200, 60);
  }

  const storms = (data.activeStorms || []).filter((s) => {
    const id = String(s.id || "").toLowerCase();
    return id.startsWith("al") || id.startsWith("ep");
  });
  return json({ activeStorms: storms }, 200, 60);
}

// Official NHC GIS overlays (cone + wind watches/warnings) from the NOAA
// tropical MapServer, returned as GeoJSON FeatureCollections so the browser
// needs no KMZ/KML parser. Filtered to Atlantic + East Pacific.
// Optional ?layers=cone,watches (default: both). Failures degrade to empty
// collections — tracks/markers still render.
async function nhcGis(rawLayers) {
  const empty = () => ({ type: "FeatureCollection", features: [] });
  const requested = parseGisLayers(rawLayers);
  const results = await Promise.all(
    requested.map(async (key) => {
      try {
        return await fetchMapServerLayer(NHC_GIS_LAYERS[key]);
      } catch (_) {
        return empty();
      }
    })
  );

  const out = {};
  requested.forEach((key, i) => {
    out[key] = filterAtlanticEastPacific(results[i]);
  });
  return json(out, 200, 300);
}

function parseGisLayers(raw) {
  const all = Object.keys(NHC_GIS_LAYERS);
  if (!raw) return all;
  const wanted = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter((k) => NHC_GIS_LAYERS[k] != null);
  return wanted.length ? wanted : all;
}

async function fetchMapServerLayer(layerId) {
  const params = new URLSearchParams({
    where: "1=1",
    outFields: "*",
    returnGeometry: "true",
    outSR: "4326",
    f: "geojson",
  });
  const upstream = await fetch(
    `${NHC_MAPSERVER}/${layerId}/query?${params}`,
    {
      headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json,application/json" },
      cf: { cacheTtl: 300, cacheEverything: true },
    }
  );
  if (!upstream.ok) {
    return { type: "FeatureCollection", features: [] };
  }
  const data = await upstream.json();
  if (!data || data.type !== "FeatureCollection" || !Array.isArray(data.features)) {
    return { type: "FeatureCollection", features: [] };
  }
  // Drop bulky MapServer bookkeeping fields the client never uses.
  data.features = data.features.map(slimGisFeature);
  return data;
}

function slimGisFeature(feat) {
  const p = feat.properties || {};
  const keep = {};
  for (const k of [
    "stormname",
    "stormtype",
    "basin",
    "advdate",
    "advisnum",
    "fcstprd",
    "stormnum",
    "tcww",
  ]) {
    if (p[k] != null && p[k] !== "") keep[k] = p[k];
  }
  return {
    type: "Feature",
    geometry: feat.geometry,
    properties: keep,
  };
}

// Keep only Atlantic + East Pacific features (basin field on cone / wind WW).
function filterAtlanticEastPacific(fc) {
  const features = (fc.features || []).filter((f) => {
    const basin = String((f.properties || {}).basin || "").toUpperCase();
    return basin === "AL" || basin === "EP";
  });
  return { type: "FeatureCollection", features };
}

// Model guidance for one storm, decoded from the gzip'd ATCF a-deck and returned
// as a GeoJSON FeatureCollection (one LineString per model) so the browser needs
// no ZIP/parser. Failures degrade to an empty collection: the page still renders
// the current-position markers without the tracks.
async function nhcAdeck(rawId) {
  const id = String(rawId || "").toLowerCase();
  // Guard against SSRF — only well-formed storm ids (e.g. "al052026") get proxied.
  if (!/^[a-z]{2}\d{6}$/.test(id)) {
    return json({ error: "Invalid storm id" }, 400);
  }

  const empty = { type: "FeatureCollection", properties: { id, init: null }, features: [] };
  let upstream;
  try {
    upstream = await fetch(NHC_ADECK_BASE + "a" + id + ".dat.gz", {
      headers: { "User-Agent": USER_AGENT },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
  } catch (_) {
    return json(empty, 200, 300);
  }
  if (!upstream.ok || !upstream.body) return json(empty, 200, 300);

  let text;
  try {
    const stream = upstream.body.pipeThrough(new DecompressionStream("gzip"));
    text = await new Response(stream).text();
  } catch (_) {
    return json(empty, 200, 300);
  }

  try {
    return json(parseAdeck(text, id), 200, 300);
  } catch (_) {
    return json(empty, 200, 300);
  }
}

// Track aids we plot. Interpolated variants (…I) are the position-adjusted aids
// NHC actually overlays; when both a raw and interpolated aid are present for a
// family we keep the higher-pref one. `family` de-dupes near-identical lines.
const TRACK_MODELS = {
  OFCL: { label: "NHC official", family: "OFCL", kind: "official", pref: 2 },
  OFCI: { label: "NHC official", family: "OFCL", kind: "official", pref: 1 },
  TVCN: { label: "Consensus (TVCN)", family: "TVCN", kind: "consensus", pref: 2 },
  TVCA: { label: "Consensus (TVCA)", family: "TVCN", kind: "consensus", pref: 1 },
  HCCA: { label: "Corrected consensus (HCCA)", family: "HCCA", kind: "consensus", pref: 1 },
  GFEX: { label: "GFS/ECMWF consensus", family: "GFEX", kind: "consensus", pref: 1 },
  AVNI: { label: "GFS", family: "GFS", kind: "model", pref: 3 },
  AVNO: { label: "GFS", family: "GFS", kind: "model", pref: 2 },
  GFSO: { label: "GFS", family: "GFS", kind: "model", pref: 1 },
  EMXI: { label: "ECMWF", family: "ECMWF", kind: "model", pref: 2 },
  EMX: { label: "ECMWF", family: "ECMWF", kind: "model", pref: 1 },
  UKXI: { label: "UKMET", family: "UKMET", kind: "model", pref: 4 },
  UKX: { label: "UKMET", family: "UKMET", kind: "model", pref: 3 },
  EGRI: { label: "UKMET", family: "UKMET", kind: "model", pref: 2 },
  EGRR: { label: "UKMET", family: "UKMET", kind: "model", pref: 1 },
  CMCI: { label: "Canadian", family: "CMC", kind: "model", pref: 2 },
  CMC: { label: "Canadian", family: "CMC", kind: "model", pref: 1 },
  NVGI: { label: "NAVGEM", family: "NAVGEM", kind: "model", pref: 2 },
  NVGM: { label: "NAVGEM", family: "NAVGEM", kind: "model", pref: 1 },
  HWFI: { label: "HWRF", family: "HWRF", kind: "model", pref: 2 },
  HWRF: { label: "HWRF", family: "HWRF", kind: "model", pref: 1 },
  HMNI: { label: "HMON", family: "HMON", kind: "model", pref: 2 },
  HMON: { label: "HMON", family: "HMON", kind: "model", pref: 1 },
  CTCI: { label: "COAMPS-TC", family: "COAMPS", kind: "model", pref: 2 },
  CTCX: { label: "COAMPS-TC", family: "COAMPS", kind: "model", pref: 1 },
  AEMI: { label: "GFS ensemble mean", family: "AEMN", kind: "model", pref: 2 },
  AEMN: { label: "GFS ensemble mean", family: "AEMN", kind: "model", pref: 1 },
  EEMI: { label: "ECMWF ensemble mean", family: "EEMN", kind: "model", pref: 2 },
  EEMN: { label: "ECMWF ensemble mean", family: "EEMN", kind: "model", pref: 1 },
};

// Order features so models draw first and the official track lands on top.
const KIND_ORDER = { model: 0, consensus: 1, official: 2 };

function parseAdeck(text, id) {
  const lines = text.split("\n");
  const rows = [];
  let latest = ""; // most recent synoptic (init) time, YYYYMMDDHH — lexical max works

  for (const line of lines) {
    if (!line) continue;
    const f = line.split(",");
    if (f.length < 9) continue;
    const tech = f[4].trim();
    if (!TRACK_MODELS[tech]) continue;
    const tau = parseInt(f[5], 10);
    if (!Number.isFinite(tau)) continue;
    const lat = decodeCoord(f[6]);
    const lon = decodeCoord(f[7]);
    if (lat == null || lon == null) continue;
    const dt = f[2].trim();
    const vmax = parseInt(f[8], 10);
    rows.push({ dt, tech, tau, lat, lon, vmax: Number.isFinite(vmax) ? vmax : null });
    if (dt > latest) latest = dt;
  }

  if (!latest) return { type: "FeatureCollection", properties: { id, init: null }, features: [] };

  // Keep only the latest init; dedupe repeated rows (wind-radii lines share a tau).
  const byTech = new Map(); // tech -> Map(tau -> point)
  for (const r of rows) {
    if (r.dt !== latest) continue;
    if (!byTech.has(r.tech)) byTech.set(r.tech, new Map());
    const perTau = byTech.get(r.tech);
    if (!perTau.has(r.tau)) perTau.set(r.tau, r);
  }

  // One track per model family (keep the highest-pref, then longest, aid).
  const bestByFamily = new Map();
  for (const [tech, perTau] of byTech) {
    const meta = TRACK_MODELS[tech];
    const points = [...perTau.values()].sort((a, b) => a.tau - b.tau);
    if (points.length < 2) continue;
    const cur = bestByFamily.get(meta.family);
    if (
      !cur ||
      meta.pref > cur.meta.pref ||
      (meta.pref === cur.meta.pref && points.length > cur.points.length)
    ) {
      bestByFamily.set(meta.family, { tech, meta, points });
    }
  }

  const features = [];
  for (const { tech, meta, points } of bestByFamily.values()) {
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: points.map((p) => [p.lon, p.lat]) },
      properties: {
        tech,
        label: meta.label,
        kind: meta.kind,
        official: meta.kind === "official",
        consensus: meta.kind === "consensus",
        taus: points.map((p) => p.tau),
        vmax: points.map((p) => p.vmax),
      },
    });
  }
  features.sort((a, b) => KIND_ORDER[a.properties.kind] - KIND_ORDER[b.properties.kind]);

  return { type: "FeatureCollection", properties: { id, init: latest }, features };
}

// ATCF packs coordinates as tenths of a degree with a hemisphere letter, e.g.
// "121N" -> 12.1, "606W" -> -60.6.
function decodeCoord(s) {
  const m = String(s).trim().match(/^(\d+)([NSEW])$/);
  if (!m) return null;
  let v = parseInt(m[1], 10) / 10;
  if (m[2] === "S" || m[2] === "W") v = -v;
  return v;
}

function json(obj, status = 200, cacheSeconds = 0) {
  const headers = {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  };
  if (cacheSeconds > 0) {
    headers["cache-control"] = "public, max-age=" + cacheSeconds;
  }
  return new Response(JSON.stringify(obj), { status, headers });
}
