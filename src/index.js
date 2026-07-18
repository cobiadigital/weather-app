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

// NWS requests a User-Agent that identifies the app and a contact. Update the
// contact if you fork this. See https://www.weather.gov/documentation/services-web-api
const USER_AGENT =
  "weather-radar-app (https://github.com/cobiadigital/weather-app)";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname.startsWith("/api/nws/")) {
      return proxyNWS(request, url);
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

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  });
}
