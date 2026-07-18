/* ----------------------------------------------------------------------------
   Local Radar — front-end logic.

   - Leaflet map with an OpenStreetMap base layer.
   - NEXRAD radar overlay from the Iowa Environmental Mesonet (IEM), which
     composites the National Weather Service's NEXRAD Level III (N0Q) product.
   - Active weather alerts + nearest-station conditions via the NWS API,
     proxied through this Worker at /api/nws/* (see src/index.js).
---------------------------------------------------------------------------- */

(function () {
  "use strict";

  // IEM NEXRAD base-reflectivity composite (EPSG:3857 / web-mercator tiles).
  // Works as a standard {z}/{x}/{y} tile layer. Refreshed by IEM ~every 5 min.
  const RADAR_TILE_URL =
    "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png";

  const DEFAULT_VIEW = { lat: 39.5, lon: -98.35, zoom: 4 }; // continental US
  const LOCATED_ZOOM = 9;
  const REFRESH_MS = 5 * 60 * 1000; // auto-refresh radar every 5 minutes
  const STORE_KEY = "radar.lastLocation";

  const els = {
    status: document.getElementById("status"),
    locateBtn: document.getElementById("locateBtn"),
    refreshBtn: document.getElementById("refreshBtn"),
    opacity: document.getElementById("opacity"),
    opacityVal: document.getElementById("opacityVal"),
    alertPill: document.getElementById("alertPill"),
    alertPillText: document.getElementById("alertPillText"),
    alertSheet: document.getElementById("alertSheet"),
    alertList: document.getElementById("alertList"),
    alertClose: document.getElementById("alertClose"),
  };

  let map;
  let radarLayer;
  let meMarker;
  let refreshTimer;

  // --- Map setup -----------------------------------------------------------

  function initMap() {
    const saved = loadLocation();
    const start = saved || DEFAULT_VIEW;

    map = L.map("map", {
      zoomControl: false,
      attributionControl: true,
      // Snappier feel on touch; keep inertia for a native scroll feel.
      tap: true,
      maxZoom: 15,
      minZoom: 3,
    }).setView([start.lat, start.lon], saved ? LOCATED_ZOOM : DEFAULT_VIEW.zoom);

    L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: "abcd",
        maxZoom: 19,
      }
    ).addTo(map);

    radarLayer = L.tileLayer(RADAR_TILE_URL, {
      opacity: sliderToOpacity(els.opacity.value),
      attribution:
        'Radar: <a href="https://mesonet.agron.iastate.edu/">Iowa Env. Mesonet</a> / NWS NEXRAD',
      zIndex: 5,
      maxZoom: 15,
    }).addTo(map);

    if (saved) {
      setMeMarker(saved.lat, saved.lon);
      loadWeather(saved.lat, saved.lon);
    }

    setStatus("Radar loaded.");
    scheduleRefresh();
  }

  // --- Radar refresh -------------------------------------------------------

  // Re-request the radar tiles by bumping a cache-busting param so we pull the
  // latest NEXRAD frame. Leaflet keeps the old tiles visible until the new
  // ones load, so there's no flash.
  function refreshRadar(userInitiated) {
    if (!radarLayer) return;
    radarLayer.setUrl(RADAR_TILE_URL + "?_=" + Date.now());
    if (userInitiated) {
      els.refreshBtn.classList.add("spin");
      setStatus("Radar updated " + timeNow() + ".");
      setTimeout(() => els.refreshBtn.classList.remove("spin"), 800);
    }
  }

  function scheduleRefresh() {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => refreshRadar(false), REFRESH_MS);
  }

  // --- Geolocation ---------------------------------------------------------

  function locate() {
    if (!("geolocation" in navigator)) {
      setStatus("Location isn't available on this device.", true);
      return;
    }
    setStatus("Finding your location…");
    els.locateBtn.disabled = true;

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        els.locateBtn.disabled = false;
        const { latitude: lat, longitude: lon } = pos.coords;
        map.flyTo([lat, lon], LOCATED_ZOOM, { duration: 0.8 });
        setMeMarker(lat, lon);
        saveLocation(lat, lon);
        loadWeather(lat, lon);
        setStatus("Centered on your location.");
      },
      (err) => {
        els.locateBtn.disabled = false;
        const msg =
          err.code === err.PERMISSION_DENIED
            ? "Location permission denied. Enable it in Settings › Safari."
            : "Couldn't get your location.";
        setStatus(msg, true);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

  function setMeMarker(lat, lon) {
    const icon = L.divIcon({
      className: "",
      html: '<div class="me-marker"></div>',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
    if (meMarker) {
      meMarker.setLatLng([lat, lon]);
    } else {
      meMarker = L.marker([lat, lon], { icon, keyboard: false }).addTo(map);
    }
  }

  // --- Weather (alerts + conditions) via the NWS proxy ---------------------

  async function loadWeather(lat, lon) {
    loadAlerts(lat, lon);
  }

  async function loadAlerts(lat, lon) {
    try {
      const point = lat.toFixed(4) + "," + lon.toFixed(4);
      const res = await fetch(
        "/api/nws/alerts/active?point=" + encodeURIComponent(point)
      );
      if (!res.ok) throw new Error("alerts " + res.status);
      const data = await res.json();
      renderAlerts(data.features || []);
    } catch (err) {
      // Alerts are a nice-to-have; never let a failure hide the radar.
      els.alertPill.classList.add("hidden");
    }
  }

  function renderAlerts(features) {
    if (!features.length) {
      els.alertPill.classList.add("hidden");
      els.alertList.innerHTML =
        '<p class="status">No active alerts for this area.</p>';
      return;
    }

    // Sort most severe first.
    const rank = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 };
    features.sort(
      (a, b) =>
        (rank[a.properties.severity] ?? 5) - (rank[b.properties.severity] ?? 5)
    );

    const worst = features[0].properties.severity;
    const severe = worst === "Extreme" || worst === "Severe";

    els.alertPill.classList.remove("hidden");
    els.alertPill.classList.toggle("severe", severe);
    els.alertPillText.textContent =
      "⚠ " +
      features.length +
      " alert" +
      (features.length > 1 ? "s" : "");

    els.alertList.innerHTML = features
      .map((f) => {
        const p = f.properties;
        const sev = (p.severity || "unknown").toLowerCase();
        return (
          '<div class="alert-card sev-' +
          esc(sev) +
          '">' +
          "<h3>" +
          esc(p.event || "Weather Alert") +
          "</h3>" +
          '<div class="meta">' +
          esc(p.severity || "") +
          (p.areaDesc ? " · " + esc(p.areaDesc) : "") +
          "</div>" +
          "<p>" +
          esc(p.headline || p.description || "") +
          "</p>" +
          "</div>"
        );
      })
      .join("");
  }

  function openSheet() {
    if (els.alertPill.classList.contains("hidden")) return;
    els.alertSheet.classList.remove("hidden");
    els.alertSheet.setAttribute("aria-hidden", "false");
    els.alertPill.setAttribute("aria-expanded", "true");
  }

  function closeSheet() {
    els.alertSheet.classList.add("hidden");
    els.alertSheet.setAttribute("aria-hidden", "true");
    els.alertPill.setAttribute("aria-expanded", "false");
  }

  // --- Opacity slider ------------------------------------------------------

  function onOpacity() {
    const v = Number(els.opacity.value);
    els.opacityVal.textContent = v + "%";
    els.opacity.style.setProperty("--fill", v + "%");
    if (radarLayer) radarLayer.setOpacity(sliderToOpacity(v));
  }

  function sliderToOpacity(v) {
    return Math.max(0, Math.min(1, Number(v) / 100));
  }

  // --- Persistence ---------------------------------------------------------

  function saveLocation(lat, lon) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ lat, lon }));
    } catch (_) {
      /* private mode / storage disabled — ignore */
    }
  }

  function loadLocation() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (typeof o.lat === "number" && typeof o.lon === "number") return o;
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  // --- Helpers -------------------------------------------------------------

  function setStatus(msg, isError) {
    els.status.textContent = msg;
    els.status.classList.toggle("error", !!isError);
  }

  function timeNow() {
    return new Date().toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c];
    });
  }

  // --- Wire up -------------------------------------------------------------

  function bind() {
    els.locateBtn.addEventListener("click", locate);
    els.refreshBtn.addEventListener("click", () => refreshRadar(true));
    els.opacity.addEventListener("input", onOpacity);
    els.alertPill.addEventListener("click", openSheet);
    els.alertClose.addEventListener("click", closeSheet);

    // Refresh radar when returning to the tab (iOS suspends background tabs).
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refreshRadar(false);
    });

    onOpacity(); // sync the slider fill + layer opacity to the default value
  }

  document.addEventListener("DOMContentLoaded", () => {
    initMap();
    bind();
    // Auto-request location on first load if we don't have a saved spot.
    if (!loadLocation()) locate();
  });
})();
