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

  // Time-enabled NEXRAD N0Q WMS (IEM "time machine"). Serves any 5-minute
  // composite from the archive via the WMS TIME parameter, which is how we
  // build the last-4-hours loop. See mesonet.agron.iastate.edu/ogc/.
  const RADAR_WMS_URL =
    "https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi";
  const RADAR_WMS_LAYER = "nexrad-n0q-wmst";

  // GOES East infrared composite from IEM. This is *satellite* cloud imagery
  // (NOT part of the NEXRAD radar product) — infrared shows cloud cover day and
  // night. Same {z}/{x}/{y} tile scheme as the radar layer.
  const CLOUD_TILE_URL =
    "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/goes-ir-4km-900913/{z}/{x}/{y}.png";

  const DEFAULT_VIEW = { lat: 39.5, lon: -98.35, zoom: 4 }; // continental US
  const LOCATED_ZOOM = 9;
  const REFRESH_MS = 5 * 60 * 1000; // auto-refresh radar every 5 minutes
  const STORE_KEY = "radar.lastLocation";

  // Radar loop: 4 hours of frames at 5-minute spacing (48 frames), advanced
  // roughly twice a second. IEM composites lag real time by a few minutes, so
  // we end the loop one step back from "now" to avoid requesting a blank frame.
  const LOOP_HOURS = 4;
  const LOOP_STEP_MIN = 5;
  const LOOP_FRAME_COUNT = (LOOP_HOURS * 60) / LOOP_STEP_MIN; // 48
  const LOOP_LAG_MIN = 5;
  const LOOP_PLAY_MS = 500;

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
    cloudsBtn: document.getElementById("cloudsBtn"),
    loopBtn: document.getElementById("loopBtn"),
    installBtn: document.getElementById("installBtn"),
    installSheet: document.getElementById("installSheet"),
    installClose: document.getElementById("installClose"),
    loopBar: document.getElementById("loopBar"),
    playBtn: document.getElementById("playBtn"),
    loopScrub: document.getElementById("loopScrub"),
    loopTime: document.getElementById("loopTime"),
  };

  let map;
  let radarLayer; // live radar (current frame)
  let cloudLayer; // GOES satellite cloud layer (optional)
  let loopLayer; // time-enabled WMS layer used while looping
  let meMarker;
  let refreshTimer;

  // Radar-loop state.
  let loopOn = false;
  let loopPlaying = false;
  let loopTimer;
  let loopFrames = []; // array of Date objects, oldest -> newest
  let loopIndex = 0;

  // Deferred PWA install prompt (Chrome/Android). Null on iOS Safari.
  let deferredInstallPrompt = null;

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
    if (!radarLayer || loopOn) return; // the loop drives its own frames
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
    // The slider controls whichever precipitation layer is showing.
    const op = sliderToOpacity(v);
    if (radarLayer) radarLayer.setOpacity(op);
    if (loopLayer) loopLayer.setOpacity(op);
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

  // --- Cloud (satellite) layer ---------------------------------------------

  // GOES infrared satellite imagery. This is a different product than the
  // NEXRAD radar (which only shows precipitation), so it's an optional overlay
  // rather than something baked into the radar tiles.
  function toggleClouds() {
    if (cloudLayer) {
      map.removeLayer(cloudLayer);
      cloudLayer = null;
      setToggle(els.cloudsBtn, false);
      setStatus("Cloud layer off.");
      return;
    }
    cloudLayer = L.tileLayer(CLOUD_TILE_URL, {
      opacity: 0.5,
      attribution:
        'Clouds: <a href="https://mesonet.agron.iastate.edu/">Iowa Env. Mesonet</a> / NOAA GOES',
      zIndex: 4, // below the radar (zIndex 5)
      maxZoom: 15,
    }).addTo(map);
    setToggle(els.cloudsBtn, true);
    setStatus("Cloud cover (GOES satellite) on.");
  }

  // --- Radar loop (last 4 hours) -------------------------------------------

  function toggleLoop() {
    loopOn ? stopLoop() : startLoop();
  }

  function startLoop() {
    loopOn = true;
    setToggle(els.loopBtn, true);
    els.loopBar.classList.remove("hidden");

    // Live radar and the loop show the same product, so hide the live layer
    // while the loop drives the display.
    if (radarLayer) map.removeLayer(radarLayer);

    buildLoopFrames();
    loopIndex = loopFrames.length - 1; // start at the most recent frame

    loopLayer = L.tileLayer.wms(RADAR_WMS_URL, {
      layers: RADAR_WMS_LAYER,
      format: "image/png",
      transparent: true,
      time: isoUTC(loopFrames[loopIndex]),
      opacity: sliderToOpacity(els.opacity.value),
      attribution:
        'Radar: <a href="https://mesonet.agron.iastate.edu/">Iowa Env. Mesonet</a> / NWS NEXRAD',
      zIndex: 5,
      maxZoom: 15,
    }).addTo(map);

    els.loopScrub.max = String(loopFrames.length - 1);
    els.loopScrub.value = String(loopIndex);
    updateLoopLabel();
    playLoop();
  }

  function stopLoop() {
    loopOn = false;
    pauseLoop();
    setToggle(els.loopBtn, false);
    els.loopBar.classList.add("hidden");

    if (loopLayer) {
      map.removeLayer(loopLayer);
      loopLayer = null;
    }
    // Restore the live radar.
    if (radarLayer) {
      radarLayer.addTo(map);
      refreshRadar(false);
    }
    setStatus("Showing live radar.");
  }

  // Build 48 frame timestamps at 5-minute spacing, ending one lag-step back
  // from now (snapped down to the 5-minute grid the composites are built on).
  function buildLoopFrames() {
    const now = Date.now();
    const step = LOOP_STEP_MIN * 60 * 1000;
    let latest = Math.floor((now - LOOP_LAG_MIN * 60 * 1000) / step) * step;
    loopFrames = [];
    for (let i = LOOP_FRAME_COUNT - 1; i >= 0; i--) {
      loopFrames.push(new Date(latest - i * step));
    }
  }

  function showLoopFrame(i) {
    loopIndex = Math.max(0, Math.min(loopFrames.length - 1, i));
    if (loopLayer) loopLayer.setParams({ time: isoUTC(loopFrames[loopIndex]) });
    els.loopScrub.value = String(loopIndex);
    updateLoopLabel();
  }

  function playLoop() {
    loopPlaying = true;
    els.playBtn.textContent = "⏸";
    els.playBtn.setAttribute("aria-label", "Pause loop");
    clearInterval(loopTimer);
    loopTimer = setInterval(() => {
      // Loop back to the start, but pause a beat on the newest frame.
      let next = loopIndex + 1;
      if (next >= loopFrames.length) next = 0;
      showLoopFrame(next);
    }, LOOP_PLAY_MS);
  }

  function pauseLoop() {
    loopPlaying = false;
    clearInterval(loopTimer);
    els.playBtn.textContent = "▶";
    els.playBtn.setAttribute("aria-label", "Play loop");
  }

  function togglePlay() {
    loopPlaying ? pauseLoop() : playLoop();
  }

  function onScrub() {
    pauseLoop();
    showLoopFrame(Number(els.loopScrub.value));
  }

  function updateLoopLabel() {
    const d = loopFrames[loopIndex];
    if (!d) return;
    const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const newest = loopIndex === loopFrames.length - 1;
    els.loopTime.textContent = newest ? "Now" : t;
    els.status.textContent = "Radar loop · " + t;
  }

  // --- Install (Add to Home Screen) ----------------------------------------

  function isStandalone() {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true
    );
  }

  function isIOS() {
    return (
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      // iPadOS 13+ reports as a Mac, but has touch.
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    );
  }

  // Decide whether to surface the Install button. Chrome/Android fire
  // `beforeinstallprompt` (handled separately); iOS Safari never does, so we
  // offer manual instructions there instead.
  function updateInstallAffordance() {
    if (isStandalone()) {
      els.installBtn.classList.add("hidden");
      return;
    }
    if (deferredInstallPrompt || isIOS()) {
      els.installBtn.classList.remove("hidden");
    }
  }

  async function onInstall() {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      try {
        await deferredInstallPrompt.userChoice;
      } catch (_) {
        /* ignore */
      }
      deferredInstallPrompt = null;
      els.installBtn.classList.add("hidden");
      return;
    }
    // iOS / anything without a native prompt: show manual instructions.
    openInstallSheet();
  }

  function openInstallSheet() {
    els.installSheet.classList.remove("hidden");
    els.installSheet.setAttribute("aria-hidden", "false");
  }

  function closeInstallSheet() {
    els.installSheet.classList.add("hidden");
    els.installSheet.setAttribute("aria-hidden", "true");
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

  // Reflect a toggle button's on/off state (drives styling + a11y).
  function setToggle(btn, on) {
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }

  // WMS TIME wants ISO-8601 UTC with no milliseconds, e.g. 2026-07-18T17:35:00Z.
  function isoUTC(date) {
    return date.toISOString().replace(/\.\d+Z$/, "Z");
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
    els.cloudsBtn.addEventListener("click", toggleClouds);
    els.loopBtn.addEventListener("click", toggleLoop);
    els.playBtn.addEventListener("click", togglePlay);
    els.loopScrub.addEventListener("input", onScrub);
    els.installBtn.addEventListener("click", onInstall);
    els.installClose.addEventListener("click", closeInstallSheet);

    // Chrome/Android: capture the native install prompt for our own button.
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      updateInstallAffordance();
    });
    window.addEventListener("appinstalled", () => {
      deferredInstallPrompt = null;
      els.installBtn.classList.add("hidden");
      closeInstallSheet();
    });

    // Refresh radar when returning to the tab (iOS suspends background tabs).
    // Don't clobber the loop if it's the active view.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !loopOn) refreshRadar(false);
    });

    updateInstallAffordance();
    onOpacity(); // sync the slider fill + layer opacity to the default value
  }

  document.addEventListener("DOMContentLoaded", () => {
    initMap();
    bind();
    // Auto-request location on first load if we don't have a saved spot.
    if (!loadLocation()) locate();
  });
})();
