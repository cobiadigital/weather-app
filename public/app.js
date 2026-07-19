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
  const SHARE_URL = "https://bendar.app";
  const SHARE_TEXT = "Live weather radar — " + SHARE_URL;

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
    shareBtn: document.getElementById("shareBtn"),
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
  let basemapLayer; // CARTO dark base tiles
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

  // Publish the true full-screen height as --vh, which #map / body size to (see
  // styles.css). The measurement differs by mode:
  //
  //  - iOS home-screen (standalone) app: the web view covers the whole screen
  //    (content starts at physical y=0), but window.innerHeight comes back short
  //    by the top safe-area — the status bar / Dynamic Island — e.g. 812 on an
  //    874px screen. Sizing to innerHeight then leaves that ~60px as a blank
  //    strip along the bottom and floats the controls up. screen.height is the
  //    true drawable height here; the app is portrait-locked so it's stable.
  //  - Safari (and everything else): innerHeight is correct — the difference
  //    from screen.height there is the real browser toolbars, which we must not
  //    draw under. So we keep innerHeight.
  //
  // Re-measure whenever the height can change (see the listeners below).
  function isStandalone() {
    return (
      (window.matchMedia &&
        window.matchMedia("(display-mode: standalone)").matches) ||
      window.navigator.standalone === true
    );
  }
  function measuredViewportHeight() {
    if (isStandalone() && window.screen && screen.height) {
      // Guard with max so we never end up shorter than innerHeight.
      return Math.max(window.innerHeight, screen.height);
    }
    return window.innerHeight;
  }
  function setViewportHeight() {
    document.documentElement.style.setProperty(
      "--vh",
      measuredViewportHeight() + "px"
    );
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

    // crossOrigin lets us later read these tiles back off a <canvas> for the
    // "Share as image" feature without tainting it (all sources send CORS
    // headers). See shareView().
    basemapLayer = L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: "abcd",
        maxZoom: 19,
        crossOrigin: "anonymous",
      }
    ).addTo(map);

    radarLayer = L.tileLayer(RADAR_TILE_URL, {
      opacity: sliderToOpacity(els.opacity.value),
      attribution:
        'Radar: <a href="https://mesonet.agron.iastate.edu/">Iowa Env. Mesonet</a> / NWS NEXRAD',
      zIndex: 5,
      maxZoom: 15,
      crossOrigin: "anonymous",
    }).addTo(map);

    if (saved) {
      setMeMarker(saved.lat, saved.lon);
      loadWeather(saved.lat, saved.lon);
    }

    setStatus("Radar loaded.");
    scheduleRefresh();

    // Stop re-centering the saved location the moment the user drags the map, so
    // the settle timers below can't yank it back from where they panned.
    let userPanned = false;
    map.on("dragstart", () => {
      userPanned = true;
    });

    // The map fills body, which is sized to var(--vh) (measured innerHeight).
    // The real height in an iOS standalone/web-app can settle late, so as the
    // measured height converges, keep Leaflet's canvas in sync so it loads tiles
    // for the full area. --vh itself is re-measured by setViewportHeightSettled
    // (fired at boot) and the resize/visualViewport listeners. Once sized, also
    // re-apply the upward-biased center for a saved location so it sits in the
    // visible band rather than low behind the control panel. (These timers fire
    // after DOMContentLoaded collapses the location controls, so the panel is
    // already at its resting height.)
    [0, 150, 600, 1000].forEach((ms) =>
      setTimeout(() => {
        if (!map) return;
        map.invalidateSize();
        if (saved && !userPanned) centerOnLocation(saved.lat, saved.lon, false);
      }, ms)
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

  // Height of the upper safe-area inset (notch / status bar), in CSS px.
  function safeAreaTop() {
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:absolute;visibility:hidden;pointer-events:none;" +
      "padding-top:env(safe-area-inset-top,0px);";
    document.body.appendChild(probe);
    const v = parseFloat(getComputedStyle(probe).paddingTop) || 0;
    probe.remove();
    return v;
  }

  // Center the map on a point, biased upward so it lands in the visual center of
  // the *unobscured* map — the band between the upper safe area and the top of
  // the bottom control panel — rather than the container's geometric center,
  // which sits ~10-15% too low, partly behind the panel. Collapse the location
  // controls before calling so the panel is at its resting height.
  // animate=true flies; false snaps.
  function centerOnLocation(lat, lon, animate) {
    if (!map) return;
    const zoom = LOCATED_ZOOM;
    const size = map.getSize();
    if (!size || !size.y) {
      map.setView([lat, lon], zoom);
      return;
    }
    // The map fills the screen from (0,0), so screen/container coords coincide.
    const controls = document.querySelector(".controls");
    const controlsTop = controls
      ? controls.getBoundingClientRect().top
      : size.y;
    const desiredY = (safeAreaTop() + controlsTop) / 2;
    const offsetY = size.y / 2 - desiredY; // > 0 shifts the marker up
    let center = [lat, lon];
    if (Math.abs(offsetY) >= 1) {
      // Shift the center point down (south) in pixel space so the actual
      // location renders that many pixels higher, at desiredY.
      center = map.unproject(
        map.project([lat, lon], zoom).add([0, offsetY]),
        zoom
      );
    }
    if (animate) map.flyTo(center, zoom, { duration: 0.8 });
    else map.setView(center, zoom);
  }

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
        setMeMarker(lat, lon);
        saveLocation(lat, lon);
        loadWeather(lat, lon);
        setStatus("Centered on your location.");
        collapseLocationControls();
        centerOnLocation(lat, lon, true);
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
      setMeMarker(lat, lon);
      saveLocation(lat, lon);
      loadWeather(lat, lon);
      els.zipInput.blur();
      setStatus("Centered on ZIP " + zip + ".");
      collapseLocationControls();
      centerOnLocation(lat, lon, true);
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
      crossOrigin: "anonymous",
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
        crossOrigin: "anonymous", // keep loop frames canvas-exportable (Share)
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

  // --- Share current view as an image --------------------------------------

  // Render the on-screen map to a PNG and hand it to the native share sheet as
  // a file (Web Share API Level 2), so people can send it like a photo. Falls
  // back to a plain download where file-sharing isn't supported (most desktops).
  //
  // Share files + title + text (same shape that already delivered both image and
  // caption on iOS). Put the site in `text` as a full https:// URL so targets
  // can make it tappable — but do not also set `url`, which iOS often treats as
  // a link-only share and drops the attachment for.
  async function shareView() {
    if (!map) return;
    els.shareBtn.disabled = true;
    setStatus("Preparing image…");

    let blob;
    try {
      blob = await captureView();
    } catch (_) {
      setStatus("Couldn't create the image.", true);
      els.shareBtn.disabled = false;
      return;
    }

    const file = new File([blob], "bendar-radar.png", { type: "image/png" });
    const data = {
      files: [file],
      title: "Bendar.app radar",
      text: SHARE_TEXT,
    };

    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share(data);
        setStatus("Shared.");
      } else {
        downloadBlob(blob, "bendar-radar.png");
        setStatus("Radar image saved.");
      }
    } catch (err) {
      // User dismissing the share sheet throws AbortError — not an error.
      if (err && err.name === "AbortError") {
        setStatus("Share canceled.");
      } else {
        downloadBlob(blob, "bendar-radar.png");
        setStatus("Radar image saved.");
      }
    } finally {
      els.shareBtn.disabled = false;
    }
  }

  // Paint the current map view (base + overlays + location pin + caption) onto
  // a canvas and resolve a PNG blob. Every tile source sends CORS headers and
  // the layers set crossOrigin, so the canvas stays untainted and exportable.
  function captureView() {
    const size = map.getSize(); // CSS px (the visible map)
    const zoom = map.getZoom();
    const origin = map.getPixelBounds().min; // viewport top-left, layer px

    // Cap at 2× for a crisp share without ballooning the file on hi-dpi phones.
    const scale = Math.min(2, window.devicePixelRatio || 1);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(size.x * scale);
    canvas.height = Math.round(size.y * scale);
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);

    // Backdrop matches the map's base so any gap (a not-yet-loaded tile) blends.
    ctx.fillStyle = "#0b1220";
    ctx.fillRect(0, 0, size.x, size.y);

    // Bottom-to-top, mirroring the on-screen z-order:
    // basemap → clouds (zIndex 4) → radar (zIndex 5).
    drawTileLayer(ctx, basemapLayer, zoom, origin);
    if (cloudLayer) drawTileLayer(ctx, cloudLayer, zoom, origin);
    if (loopOn && loopLayers[loopIndex]) {
      drawTileLayer(ctx, loopLayers[loopIndex], zoom, origin);
    } else if (radarLayer && map.hasLayer(radarLayer)) {
      drawTileLayer(ctx, radarLayer, zoom, origin);
    }

    if (meMarker) {
      const p = map.latLngToContainerPoint(meMarker.getLatLng());
      drawPin(ctx, p.x, p.y);
    }
    drawCaption(ctx, size);

    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))),
        "image/png"
      );
    });
  }

  // Copy a Leaflet grid layer's currently-loaded tiles onto the canvas at their
  // viewport offset. Tile global px = coords * 256; subtract the viewport origin
  // to get the on-canvas position. WMS loop frames sit on the same tile grid, so
  // this handles them too.
  function drawTileLayer(ctx, layer, zoom, origin) {
    const tiles = layer && layer._tiles;
    if (!tiles) return;
    const T = 256; // Leaflet's default tile size
    const op = layer.options.opacity == null ? 1 : layer.options.opacity;
    if (op <= 0) return;
    ctx.globalAlpha = op;
    for (const key in tiles) {
      const tile = tiles[key];
      if (!tile.current || !tile.loaded || !tile.el) continue;
      if (!tile.coords || tile.coords.z !== zoom) continue;
      const el = tile.el;
      // Skip broken/undecoded images — drawImage would throw on them.
      if (el.tagName === "IMG" && !el.naturalWidth) continue;
      const x = tile.coords.x * T - origin.x;
      const y = tile.coords.y * T - origin.y;
      try {
        ctx.drawImage(el, x, y, T, T);
      } catch (_) {
        /* one bad tile shouldn't sink the whole capture */
      }
    }
    ctx.globalAlpha = 1;
  }

  // The location marker, matching the CSS .me-marker (accent dot, white ring,
  // soft glow).
  function drawPin(ctx, x, y) {
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(59, 130, 246, 0.35)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#3b82f6";
    ctx.fill();
  }

  // Branding + timestamp + source attribution along the bottom edge. Two rows
  // (title/time, then attribution) so nothing collides on a narrow phone width.
  function drawCaption(ctx, size) {
    const barH = 52;
    const top = size.y - barH;
    const grad = ctx.createLinearGradient(0, top - 14, 0, size.y);
    grad.addColorStop(0, "rgba(11, 18, 32, 0)");
    grad.addColorStop(1, "rgba(11, 18, 32, 0.9)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, top - 14, size.x, barH + 14);

    const font = "-apple-system, system-ui, Helvetica, Arial, sans-serif";
    const x = 12;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";

    // Row 1: "Bendar.app" (bold) · <live radar / loop time> (dim).
    ctx.fillStyle = "#dbe8ff";
    ctx.font = "600 15px " + font;
    ctx.fillText("Bendar.app", x, top + 22);
    const brandW = ctx.measureText("Bendar.app").width;
    ctx.fillStyle = "rgba(219, 232, 255, 0.8)";
    ctx.font = "400 13px " + font;
    ctx.fillText("  ·  " + captionStamp(), x + brandW, top + 22);

    // Row 2: source attribution (OSM/CARTO/IEM licensing).
    ctx.fillStyle = "rgba(219, 232, 255, 0.5)";
    ctx.font = "400 10px " + font;
    ctx.fillText(
      "Radar: NWS NEXRAD / IEM  ·  © OpenStreetMap, © CARTO",
      x,
      top + 42
    );
  }

  function captionStamp() {
    if (loopOn && loopFrames[loopIndex]) {
      if (loopIndex === loopFrames.length - 1) return "Radar loop · now";
      const t = loopFrames[loopIndex].toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      });
      return "Radar loop · " + t;
    }
    return "Live radar · " + timeNow();
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
    els.shareBtn.addEventListener("click", shareView);
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
