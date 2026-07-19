/* ----------------------------------------------------------------------------
   Bendar.app — front-end logic.

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

  // Radar loop: 2 hours of frames at 10-minute spacing (12 frames), advanced
  // roughly twice a second. IEM composites lag real time by a few minutes, so
  // we end the loop one step back from "now" to avoid requesting a blank frame.
  const LOOP_HOURS = 2;
  const LOOP_STEP_MIN = 10;
  const LOOP_FRAME_COUNT = (LOOP_HOURS * 60) / LOOP_STEP_MIN; // 12
  const LOOP_LAG_MIN = 5;
  const LOOP_PLAY_MS = 500; // ms per frame while playing
  const LOOP_END_DWELL_MS = 1200; // linger on the newest frame before looping
  const LOOP_SAFETY_MS = 25000; // start playing even if some frames stall loading

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
    zipForm: document.getElementById("zipForm"),
    zipInput: document.getElementById("zipInput"),
    zipBtn: document.getElementById("zipBtn"),
    locateRow: document.getElementById("locateRow"),
    locPinBtn: document.getElementById("locPinBtn"),
  };

  let map;
  let radarLayer; // live radar (current frame)
  let cloudLayer; // GOES satellite cloud layer (optional)
  let meMarker;
  let refreshTimer;

  // Radar-loop state.
  let loopOn = false;
  let loopPlaying = false;
  let loopReady = false; // true once frames are preloaded
  let loopTimer;
  let loopSafety; // fallback timer so a stalled frame can't hang preload
  let loopLoaded = 0; // how many frame layers have finished loading
  let loopLayers = []; // one WMS tile layer per frame, parallel to loopFrames
  let loopFrames = []; // array of Date objects, oldest -> newest
  let loopIndex = 0;

  // Deferred PWA install prompt (Chrome/Android). Null on iOS Safari.
  let deferredInstallPrompt = null;

  // ZIP -> [lat, lon] lookup table, lazily fetched on first use (it's ~0.9 MB,
  // so we don't load it unless someone actually enters a ZIP).
  let zipData = null;
  let zipLoading = null;

  // --- Viewport height -----------------------------------------------------

  // iOS home-screen (standalone) / fullscreen apps have a long-standing WebKit
  // bug: the viewport that `position:fixed` + `100vh`/`100dvh` resolve against
  // renders shorter than the real screen on first paint, leaving a blank strip
  // (~150px) along the bottom — the dark map stops short and the control bar
  // floats too high. `window.innerHeight`, read from JS, reports the true usable
  // height, so we publish it as `--vh` and drive the full-screen surfaces off it
  // (see #map / body in styles.css). Re-measure whenever the height can change.
  function setViewportHeight() {
    document.documentElement.style.setProperty("--vh", window.innerHeight + "px");
  }

  // iOS standalone reports its final innerHeight a beat late: the value on first
  // paint can be short, and no single event reliably marks "settled." So besides
  // the live listeners we re-measure a few times over the first second.
  function setViewportHeightSettled() {
    setViewportHeight();
    [50, 150, 300, 600, 1000].forEach((ms) =>
      setTimeout(setViewportHeight, ms)
    );
  }

  window.addEventListener("resize", setViewportHeight);
  window.addEventListener("orientationchange", () => {
    // Safari reports the pre-rotation height synchronously; re-measure after it
    // settles so the map/controls snap to the new bottom edge.
    setViewportHeightSettled();
  });
  // A restored-from-bfcache page (Safari back/forward) can come back with a
  // stale height; re-measure on show.
  window.addEventListener("pageshow", setViewportHeight);
  // visualViewport tracks the real drawable area and fires when it settles.
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", setViewportHeight);
  }

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

    // The map fills body, which is sized to var(--vh) (measured innerHeight).
    // The real height in an iOS standalone/web-app can settle late, so as the
    // measured height converges, keep Leaflet's canvas in sync so it loads tiles
    // for the full area. --vh itself is re-measured by setViewportHeightSettled
    // (fired at boot) and the resize/visualViewport listeners.
    [0, 150, 600, 1000].forEach((ms) =>
      setTimeout(() => map && map.invalidateSize(), ms)
    );
    window.addEventListener("orientationchange", () => {
      setTimeout(() => map && map.invalidateSize(), 350);
    });
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
      setStatus("Location isn't available — enter a ZIP code instead.", true);
      revealZip();
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
        collapseLocationControls();
      },
      (err) => {
        els.locateBtn.disabled = false;
        // Location off or denied — reveal the manual ZIP fallback.
        const msg =
          err.code === err.PERMISSION_DENIED
            ? "Location off. Enter a ZIP code, or enable location in Settings."
            : "Couldn't get your location — enter a ZIP code instead.";
        setStatus(msg, true);
        revealZip();
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

  // The ZIP fallback stays hidden until geolocation fails; then we show it and
  // focus the field so the user can type a ZIP right away.
  function revealZip() {
    els.zipForm.classList.remove("hidden");
    els.zipInput.focus();
  }

  // Once we have a location, tuck the location controls away and leave just a
  // small pin button in the top bar to reopen them.
  function collapseLocationControls() {
    els.locateRow.classList.add("hidden");
    els.zipForm.classList.add("hidden");
    els.locPinBtn.classList.remove("hidden");
  }

  function expandLocationControls() {
    els.locateRow.classList.remove("hidden");
    els.locPinBtn.classList.add("hidden");
    // The ZIP field stays hidden; it only reappears if a locate attempt fails.
  }

  // --- ZIP-code fallback ---------------------------------------------------

  // Fetch the ZIP table once and memoize it (also de-dupes concurrent calls).
  function loadZipData() {
    if (zipData) return Promise.resolve(zipData);
    if (!zipLoading) {
      zipLoading = fetch("/zipcodes.json")
        .then((res) => {
          if (!res.ok) throw new Error("zipcodes " + res.status);
          return res.json();
        })
        .then((data) => {
          zipData = data;
          return data;
        })
        .catch((err) => {
          zipLoading = null; // allow a retry on the next attempt
          throw err;
        });
    }
    return zipLoading;
  }

  async function goToZip() {
    const zip = (els.zipInput.value || "").trim();
    if (!/^\d{5}$/.test(zip)) {
      setStatus("Enter a 5-digit US ZIP code.", true);
      els.zipInput.focus();
      return;
    }

    setStatus("Looking up ZIP " + zip + "…");
    els.zipBtn.disabled = true;
    try {
      const data = await loadZipData();
      const hit = data[zip];
      if (!hit) {
        setStatus("ZIP " + zip + " not found.", true);
        return;
      }
      const [lat, lon] = hit;
      map.flyTo([lat, lon], LOCATED_ZOOM, { duration: 0.8 });
      setMeMarker(lat, lon);
      saveLocation(lat, lon);
      loadWeather(lat, lon);
      els.zipInput.blur();
      setStatus("Centered on ZIP " + zip + ".");
      collapseLocationControls();
    } catch (_) {
      setStatus("Couldn't load ZIP data. Check your connection.", true);
    } finally {
      els.zipBtn.disabled = false;
    }
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
    // While looping, only the visible frame should track the slider.
    if (loopOn && loopLayers[loopIndex]) loopLayers[loopIndex].setOpacity(op);
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
    loopReady = false;
    loopLoaded = 0;
    setToggle(els.loopBtn, true);
    els.loopBar.classList.remove("hidden");
    // Controls stay inert until the frames are preloaded.
    els.playBtn.disabled = true;
    els.loopScrub.disabled = true;

    // Live radar and the loop show the same product, so hide the live layer
    // while the loop drives the display.
    if (radarLayer) map.removeLayer(radarLayer);

    buildLoopFrames();
    loopIndex = loopFrames.length - 1; // start on the most recent frame

    const op = sliderToOpacity(els.opacity.value);
    const total = loopFrames.length;

    // Anti-strobe strategy: rather than swapping the TIME param on a single
    // layer (which re-fetches its tiles every frame and flashes blank while
    // they load), build one tile layer per frame up front. They're all added
    // at opacity 0 so their tiles preload in the background; animating is then
    // just flipping opacity between already-loaded layers, so a frame never
    // disappears mid-loop.
    loopLayers = loopFrames.map((frame, i) => {
      const layer = L.tileLayer.wms(RADAR_WMS_URL, {
        layers: RADAR_WMS_LAYER,
        format: "image/png",
        transparent: true,
        time: isoUTC(frame),
        // Show the newest frame right away; keep the rest hidden until shown.
        opacity: i === loopIndex ? op : 0,
        zIndex: 5,
        maxZoom: 15,
        updateWhenIdle: true, // don't refetch every frame while panning
        keepBuffer: 0, // 48 layers — keep each one's memory footprint small
        // One attribution entry is plenty (Leaflet de-dupes identical text).
        attribution:
          i === 0
            ? 'Radar: <a href="https://mesonet.agron.iastate.edu/">Iowa Env. Mesonet</a> / NWS NEXRAD'
            : undefined,
      });
      layer.once("load", () => onFrameLoaded(total));
      return layer;
    });
    loopLayers.forEach((layer) => layer.addTo(map));

    els.loopScrub.max = String(total - 1);
    els.loopScrub.value = String(loopIndex);
    updateLoopLabel();
    setStatus("Loading radar loop… 0%");

    // Safety net: if a frame's tiles never finish (server hiccup), start anyway.
    clearTimeout(loopSafety);
    loopSafety = setTimeout(markLoopReady, LOOP_SAFETY_MS);
  }

  function onFrameLoaded(total) {
    if (!loopOn) return; // loop was stopped mid-preload
    loopLoaded++;
    if (!loopReady) {
      const pct = Math.round((loopLoaded / total) * 100);
      setStatus("Loading radar loop… " + pct + "%");
    }
    if (loopLoaded >= total) markLoopReady();
  }

  // Preload finished (or timed out) — enable the controls and start playing.
  function markLoopReady() {
    if (loopReady || !loopOn) return;
    loopReady = true;
    clearTimeout(loopSafety);
    els.playBtn.disabled = false;
    els.loopScrub.disabled = false;
    playLoop();
  }

  function stopLoop() {
    loopOn = false;
    loopReady = false;
    pauseLoop();
    clearTimeout(loopSafety);
    setToggle(els.loopBtn, false);
    els.loopBar.classList.add("hidden");
    els.playBtn.disabled = false;
    els.loopScrub.disabled = false;

    loopLayers.forEach((layer) => map.removeLayer(layer));
    loopLayers = [];

    // Restore the live radar.
    if (radarLayer) {
      radarLayer.addTo(map);
      refreshRadar(false);
    }
    setStatus("Showing live radar.");
  }

  // Build 12 frame timestamps at 10-minute spacing, ending one lag-step back
  // from now (snapped down to the 10-minute grid the composites are built on).
  function buildLoopFrames() {
    const now = Date.now();
    const step = LOOP_STEP_MIN * 60 * 1000;
    let latest = Math.floor((now - LOOP_LAG_MIN * 60 * 1000) / step) * step;
    loopFrames = [];
    for (let i = LOOP_FRAME_COUNT - 1; i >= 0; i--) {
      loopFrames.push(new Date(latest - i * step));
    }
  }

  // Reveal frame i by flipping opacity — the layers are already loaded, so
  // this is instant and never blanks the map.
  function showLoopFrame(i) {
    const prev = loopIndex;
    loopIndex = Math.max(0, Math.min(loopLayers.length - 1, i));
    const op = sliderToOpacity(els.opacity.value);
    if (loopLayers[prev] && prev !== loopIndex) loopLayers[prev].setOpacity(0);
    if (loopLayers[loopIndex]) loopLayers[loopIndex].setOpacity(op);
    els.loopScrub.value = String(loopIndex);
    updateLoopLabel();
  }

  function playLoop() {
    if (!loopReady) return; // wait until frames are preloaded
    loopPlaying = true;
    els.playBtn.textContent = "⏸";
    els.playBtn.setAttribute("aria-label", "Pause loop");
    clearTimeout(loopTimer);
    // Recursive setTimeout (not setInterval) so we can linger on the newest
    // frame before wrapping back to the start.
    const tick = () => {
      let next = loopIndex + 1;
      if (next >= loopLayers.length) next = 0;
      showLoopFrame(next);
      const onNewest = loopIndex === loopLayers.length - 1;
      loopTimer = setTimeout(tick, onNewest ? LOOP_END_DWELL_MS : LOOP_PLAY_MS);
    };
    loopTimer = setTimeout(tick, LOOP_PLAY_MS);
  }

  function pauseLoop() {
    loopPlaying = false;
    clearTimeout(loopTimer);
    els.playBtn.textContent = "▶";
    els.playBtn.setAttribute("aria-label", "Play loop");
  }

  function togglePlay() {
    if (!loopReady) return;
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
    if (loopReady) els.status.textContent = "Radar loop · " + t;
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
    els.zipForm.addEventListener("submit", (e) => {
      e.preventDefault();
      goToZip();
    });
    els.locPinBtn.addEventListener("click", expandLocationControls);
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
    setViewportHeightSettled();
    initMap();
    bind();
    // Auto-request location on first load if we don't have a saved spot;
    // otherwise we already have a location, so collapse the controls.
    if (!loadLocation()) locate();
    else collapseLocationControls();
  });
})();
