/* ----------------------------------------------------------------------------
   Tropics — tropical-cyclone model tracks & the NHC official forecast.

   - Leaflet map (same CARTO dark basemap as the radar page).
   - Current storm positions + intensity from the NHC CurrentStorms feed,
     proxied by this Worker at /api/nhc/current (Atlantic + East Pacific).
   - "Spaghetti" model tracks + the official (OFCL) forecast decoded from the
     NHC ATCF a-deck at /api/nhc/adeck?id=<stormId> (see src/index.js).
   - Official cone and coastal wind watches/warnings from NOAA's tropical
     MapServer via /api/nhc/gis (GeoJSON).
   - Arrival-time, probabilistic-wind, and inundation products from the same
     MapServer as viewport export PNGs (official symbology + labels; inundation
     is a raster mosaic so GeoJSON isn't an option). Arrival uses its own overlay
     with CSS invert so the black contours read on the dark basemap.

   Vanilla JS, IIFE-wrapped, no dependencies — matches app.js conventions.
---------------------------------------------------------------------------- */

(function () {
  "use strict";

  // Centered on the tropical Atlantic; bounds are refit once storms load.
  const DEFAULT_VIEW = { lat: 22, lon: -72, zoom: 4 };
  const REFRESH_MS = 10 * 60 * 1000; // advisories update a few times a day

  // Same MapServer as /api/nhc/gis; hazard products use /export (see NHC_EXPORT_*).
  const NHC_MAPSERVER =
    "https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer";
  // Layer ids from MapServer?f=pjson (Arrival Time group 17, Prob. Winds 29, Inundation 21).
  const NHC_EXPORT_ARRIVAL = [18, 19]; // earliest reasonable + most likely TS arrival
  const NHC_EXPORT_INUNDATION = [21]; // inundation mosaic (raster + footprint)
  // Probabilistic winds: tap cycles 34 → 50 → 64 kt (off when index wraps).
  const NHC_EXPORT_WINDS = [
    { id: 30, label: "34 kt", status: "34-kt (tropical storm) wind probabilities" },
    { id: 31, label: "50 kt", status: "50-kt wind probabilities" },
    { id: 32, label: "64 kt", status: "64-kt (hurricane) wind probabilities" },
  ];

  // Model track styling. Highlighted aids (Google DeepMind, flagged by the
  // Worker) get their own color: violet sits clear of the white official
  // track, the blue consensus and every category color.
  const MODEL_OPACITY = 0.5;
  const HIGHLIGHT_OPACITY = 0.9;
  const HIGHLIGHT_COLOR = "#b388ff";

  // Coastal wind watch/warning line colors (NHC interactive-graphic palette).
  const WW_COLORS = {
    HWR: "#ff2d2d", // hurricane warning
    HWA: "#ff9ec8", // hurricane watch
    TWR: "#3d8bfd", // tropical storm warning
    TWA: "#ffdd33", // tropical storm watch
  };
  const WW_LABELS = {
    HWR: "Hurricane Warning",
    HWA: "Hurricane Watch",
    TWR: "Tropical Storm Warning",
    TWA: "Tropical Storm Watch",
  };

  const els = {
    status: document.getElementById("status"),
    stormsBtn: document.getElementById("stormsBtn"),
    stormsBadge: document.getElementById("stormsBadge"),
    modelsBtn: document.getElementById("modelsBtn"),
    coneBtn: document.getElementById("coneBtn"),
    outlookBtn: document.getElementById("outlookBtn"),
    arrivalBtn: document.getElementById("arrivalBtn"),
    windsBtn: document.getElementById("windsBtn"),
    windsBtnLabel: document.getElementById("windsBtnLabel"),
    inundationBtn: document.getElementById("inundationBtn"),
    refreshBtn: document.getElementById("refreshBtn"),
    stormSheet: document.getElementById("stormSheet"),
    stormList: document.getElementById("stormList"),
    stormClose: document.getElementById("stormClose"),
    legend: document.getElementById("legend"),
    legendToggle: document.getElementById("legendToggle"),
    legendWindsLabel: document.getElementById("legendWindsLabel"),
  };

  let map;
  let stormsLayer; // current-position markers
  let tracksLayer; // all model + official forecast lines
  let ptsLayer; // official forecast points (labeled dots)
  let coneLayer; // NHC forecast cone polygons
  let wwLayer; // coastal wind watches/warnings
  let outlookLayer; // NHC 7-day outlook areas (disturbances that may develop)
  let investLayer; // invest markers (their model tracks go in tracksLayer)
  // Separate export overlays: arrival is inverted (black → white); color
  // products (prob. winds / inundation) must not be inverted.
  let arrivalOverlay = null;
  let colorHazardOverlay = null;
  // Slots hold the shown overlay plus any still loading (see setExportOverlay).
  const arrivalSlot = {
    get: () => arrivalOverlay,
    set: (v) => {
      arrivalOverlay = v;
    },
    pending: null,
  };
  const colorHazardSlot = {
    get: () => colorHazardOverlay,
    set: (v) => {
      colorHazardOverlay = v;
    },
    pending: null,
  };
  const EXPORT_PAD = 0.25; // fraction of the viewport fetched beyond each edge
  let showModels = true; // spaghetti visible by default
  let showOutlook = true; // outlook areas visible by default
  let showCone = true; // cone + wind WW visible by default
  let showArrival = false; // TS wind arrival times (off by default — busy overlay)
  let showInundation = false; // storm-surge inundation mosaic
  let windMode = -1; // index into NHC_EXPORT_WINDS, or -1 when off
  let hazardRefreshTimer = null;
  let refreshTimer;
  let storms = []; // last-loaded storm list
  let hasFramedView = false; // fit bounds once on first load; refresh keeps the view
  // ?storm=<id> (e.g. the radar page's "TS Isaias tracking" link) frames that
  // storm on first load instead of every active one.
  const FOCUS_ID = (() => {
    try {
      const id = (new URLSearchParams(location.search).get("storm") || "").toLowerCase();
      return /^[a-z]{2}\d{6}$/.test(id) ? id : null;
    } catch (_) {
      return null;
    }
  })();

  // --- Viewport height -----------------------------------------------------

  // Same fix as app.js (see its "Viewport height" notes): body and #map size
  // to var(--vh), which styles.css defaults to 100dvh. In an iOS home-screen
  // (standalone) app that comes up short by the status-bar height, leaving a
  // blank strip along the bottom, so publish the real height instead:
  // screen.height when standalone, innerHeight everywhere else (where the gap
  // is real browser chrome we must not draw under).
  function isStandalone() {
    return (
      (window.matchMedia &&
        window.matchMedia("(display-mode: standalone)").matches) ||
      window.navigator.standalone === true
    );
  }
  function measuredViewportHeight() {
    if (isStandalone() && window.screen && screen.height) {
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
  // iOS standalone settles its height a beat late; re-measure over ~1 s.
  function setViewportHeightSettled() {
    setViewportHeight();
    [50, 150, 300, 600, 1000].forEach((ms) =>
      setTimeout(setViewportHeight, ms)
    );
  }

  window.addEventListener("resize", setViewportHeight);
  window.addEventListener("orientationchange", setViewportHeightSettled);
  window.addEventListener("pageshow", setViewportHeight);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", setViewportHeight);
  }

  // --- Map setup -----------------------------------------------------------

  function initMap() {
    map = L.map("map", {
      zoomControl: false,
      attributionControl: true,
      maxZoom: 12,
      minZoom: 2,
    }).setView([DEFAULT_VIEW.lat, DEFAULT_VIEW.lon], DEFAULT_VIEW.zoom);

    // Via the Worker (/api/basemap/*), which attaches the CARTO key — see app.js.
    L.tileLayer("/api/basemap/dark/{z}/{x}/{y}{r}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a> · Data: <a href="https://www.nhc.noaa.gov/">NOAA NHC</a>',
      maxZoom: 19,
    }).addTo(map);

    // MapServer hazard exports get their own pane under the vector overlays
    // (overlayPane is 400), so contours never cover the tracks or cone.
    map.createPane("hazardPane").style.zIndex = 350;

    // GIS overlays under tracks so official/model lines stay readable on top.
    outlookLayer = L.layerGroup().addTo(map);
    coneLayer = L.layerGroup().addTo(map);
    wwLayer = L.layerGroup().addTo(map);
    tracksLayer = L.layerGroup().addTo(map);
    ptsLayer = L.layerGroup().addTo(map);
    investLayer = L.layerGroup().addTo(map);
    stormsLayer = L.layerGroup().addTo(map);

    // Debounced export refresh — MapServer /export is per-viewport.
    map.on("moveend zoomend resize", scheduleHazardOverlayRefresh);

    // Keep Leaflet in step as --vh converges (see setViewportHeightSettled),
    // so it loads tiles for the full height rather than the first, short one.
    [0, 150, 600, 1000].forEach((ms) =>
      setTimeout(() => map && map.invalidateSize(), ms)
    );
    window.addEventListener("orientationchange", () => {
      setTimeout(() => {
        if (!map) return;
        map.invalidateSize();
        scheduleHazardOverlayRefresh();
      }, 250);
    });
  }

  // --- Saffir–Simpson category (from max sustained wind, knots) -------------

  function catInfo(kt, classification) {
    const w = Number(kt) || 0;
    if (w >= 137) return { name: "Category 5", color: "#ff4dd8" };
    if (w >= 113) return { name: "Category 4", color: "#e0192b" };
    if (w >= 96) return { name: "Category 3", color: "#ff5a1f" };
    if (w >= 83) return { name: "Category 2", color: "#ff8c00" };
    if (w >= 64) return { name: "Category 1", color: "#ffd11a" };
    if (w >= 34) return { name: "Tropical Storm", color: "#28c76f" };
    if (classification === "SD" || classification === "SS")
      return { name: "Subtropical", color: "#7aa0c4" };
    return { name: "Tropical Depression", color: "#7aa0c4" };
  }

  // --- Load current storms -------------------------------------------------

  async function loadStorms(userInitiated) {
    if (userInitiated) {
      els.refreshBtn.classList.add("spin");
      setTimeout(() => els.refreshBtn.classList.remove("spin"), 800);
    }
    try {
      const res = await fetch("/api/nhc/current");
      if (!res.ok) throw new Error("current " + res.status);
      const data = await res.json();
      storms = data.activeStorms || [];
    } catch (err) {
      setStatus("Couldn't reach the National Hurricane Center.", true);
      return;
    }

    clearOverlayLayers();
    legendSeen.clear();

    const bounds = L.latLngBounds([]);
    const focusBounds = L.latLngBounds([]); // just the ?storm= system, if any

    if (!storms.length) {
      renderEmpty();
      setStormCount(0);
      // Disturbances matter most when nothing is named yet.
      const found = await loadDisturbances(bounds);
      setStatus(
        found
          ? "No named storms. Showing " + found + " area" + (found > 1 ? "s" : "") + " NHC is watching."
          : "No active tropical cyclones."
      );
      // Only frame on the very first empty load.
      if (!hasFramedView) {
        if (bounds.isValid()) fitView(bounds);
        else map.setView([DEFAULT_VIEW.lat, DEFAULT_VIEW.lon], DEFAULT_VIEW.zoom);
        hasFramedView = true;
      }
      updateLegend();
      return;
    }

    storms.forEach((s) => {
      const lat = Number(s.latitudeNumeric);
      const lon = Number(s.longitudeNumeric);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      const cat = catInfo(s.intensity, s.classification);

      L.circleMarker([lat, lon], {
        radius: 9,
        color: "#0b1220",
        weight: 2,
        fillColor: cat.color,
        fillOpacity: 1,
      })
        .bindPopup(stormPopup(s, cat), { className: "storm-popup-wrap" })
        .addTo(stormsLayer);

      bounds.extend([lat, lon]);
      if (isFocus(s)) focusBounds.extend([lat, lon]);
      legendSeen.add(catKey(cat));
    });

    renderStormList();
    setStormCount(storms.length);
    setStatus(
      "Showing " + storms.length + " active storm" + (storms.length > 1 ? "s" : "") + "."
    );

    // Frame once on first successful load. Refresh / auto-refresh / tab-focus
    // reloads keep whatever pan/zoom the user has.
    const shouldFrame = !hasFramedView;
    const frame = () => (focusBounds.isValid() ? focusBounds : bounds);
    if (shouldFrame) fitView(frame());

    // Model tracks + official GIS overlays in parallel; each may extend bounds.
    // For the focused storm only its official track joins focusBounds.
    await Promise.all([
      Promise.all(storms.map((s) => loadTracks(s, bounds, isFocus(s) ? focusBounds : null))),
      loadGis(bounds),
      loadDisturbances(bounds),
    ]);
    if (shouldFrame) fitView(frame());
    if (shouldFrame) hasFramedView = true;
    updateLegend();
  }

  // Frame bounds into the part of the map not covered by the top bar and the
  // bottom control panel. A flat 50px pad on every side ignored the ~300px
  // panel yet ate a quarter of a 390px-wide phone, which pushed a
  // two-basin view (Gulf + East Pacific) out to zoom 2.
  function fitView(b) {
    if (!b || !b.isValid()) return;
    const mapRect = map.getContainer().getBoundingClientRect();
    const top = document.querySelector(".topbar");
    const controls = document.querySelector(".controls");
    const padTop = top ? Math.max(0, top.getBoundingClientRect().bottom - mapRect.top) : 0;
    const padBottom = controls
      ? Math.max(0, mapRect.bottom - controls.getBoundingClientRect().top)
      : 0;
    map.fitBounds(b, {
      paddingTopLeft: [16, padTop + 12],
      paddingBottomRight: [16, padBottom + 12],
      maxZoom: 6,
    });
  }

  function isFocus(s) {
    return !!FOCUS_ID && String(s.id || "").toLowerCase() === FOCUS_ID;
  }

  function clearOverlayLayers() {
    stormsLayer.clearLayers();
    tracksLayer.clearLayers();
    ptsLayer.clearLayers();
    coneLayer.clearLayers();
    wwLayer.clearLayers();
    outlookLayer.clearLayers();
    investLayer.clearLayers();
  }

  // --- Disturbances: NHC 7-day outlook areas + invest model tracks ---------

  // Outlook colors follow NHC's graphic: yellow low, orange medium, red high.
  const OUTLOOK_COLORS = { low: "#ffe14d", medium: "#ff9f1a", high: "#ff3b30" };

  // Returns how many areas were drawn (outlook polygons + invests, de-duplicated
  // is not attempted: an invest normally sits inside an outlook area).
  async function loadDisturbances(bounds) {
    const [areas, invests] = await Promise.all([
      loadOutlook(bounds),
      loadInvests(bounds),
    ]);
    applyOutlookVisibility();
    return Math.max(areas, invests);
  }

  async function loadOutlook(bounds) {
    let fc;
    try {
      const res = await fetch("/api/nhc/gis?layers=outlook");
      if (!res.ok) return 0;
      fc = (await res.json()).outlook;
    } catch (_) {
      return 0;
    }
    if (!fc || !fc.features || !fc.features.length) return 0;

    // Draw the lowest-chance areas first so a high-chance area is never buried.
    const rank = { low: 0, medium: 1, high: 2 };
    const feats = fc.features.slice().sort((a, b) => {
      const ra = rank[String((a.properties || {}).risk7day).toLowerCase()] || 0;
      const rb = rank[String((b.properties || {}).risk7day).toLowerCase()] || 0;
      return ra - rb;
    });
    feats.forEach((feat) => {
      const p = feat.properties || {};
      const risk = String(p.risk7day).toLowerCase();
      const color = OUTLOOK_COLORS[risk] || OUTLOOK_COLORS.low;
      legendSeen.add(OUTLOOK_COLORS[risk] ? risk : "low");
      const layer = L.geoJSON(feat, {
        style: {
          color: color,
          weight: 2,
          opacity: 0.95,
          dashArray: "6 5",
          fillColor: color,
          fillOpacity: 0.22,
        },
      });
      layer.bindPopup(outlookPopup(p), { className: "storm-popup-wrap" });
      layer.addTo(outlookLayer);
      extendBoundsFromGeom(feat.geometry, bounds);
    });
    return feats.length;
  }

  function outlookPopup(p) {
    return (
      '<div class="storm-popup"><h3>Area to watch</h3>' +
      "<div><b>" + esc(p.prob7day || "?") + "</b> chance of development in 7 days (" +
      esc(p.risk7day || "unknown") + ")</div>" +
      "<div>" + esc(p.prob2day || "?") + " in 2 days (" + esc(p.risk2day || "unknown") + ")</div>" +
      '<div class="links">' +
      link("https://www.nhc.noaa.gov/gtwo.php?basin=atlc&fdays=7", "NHC outlook") +
      "</div></div>"
    );
  }

  async function loadInvests(bounds) {
    let list;
    try {
      const res = await fetch("/api/nhc/invests");
      if (!res.ok) return 0;
      list = (await res.json()).invests;
    } catch (_) {
      return 0;
    }
    if (!list || !list.length) return 0;

    list.forEach((inv) => {
      L.circleMarker([inv.lat, inv.lon], {
        radius: 9,
        color: "#ffffff",
        weight: 2,
        dashArray: "3 3",
        fillColor: "#0b1220",
        fillOpacity: 0.85,
      })
        .bindPopup(investPopup(inv), { className: "storm-popup-wrap" })
        .addTo(investLayer);
      bounds.extend([inv.lat, inv.lon]);
      legendSeen.add("invest");
      addTrackFeatures(inv.tracks, bounds);
    });
    return list.length;
  }

  function investPopup(inv) {
    const when = fmtValid(inv.init, 0);
    return (
      '<div class="storm-popup"><h3>' + esc(inv.name) + " (disturbance)</h3>" +
      "<div>Not yet a tropical cyclone. Lines show model guidance.</div>" +
      (when ? "<div>Models initialized " + esc(when) + "</div>" : "") +
      "</div>"
    );
  }

  function applyOutlookVisibility() {
    setGroupOnMap(outlookLayer, showOutlook);
    setGroupOnMap(investLayer, showOutlook);
    bringInteractiveLayersFront();
    updateLegend();
  }

  function toggleOutlook() {
    showOutlook = !showOutlook;
    els.outlookBtn.setAttribute("aria-pressed", showOutlook ? "true" : "false");
    applyOutlookVisibility();
    setStatus(showOutlook ? "Areas NHC is watching shown." : "Outlook areas hidden.");
  }

  // --- Official NHC GIS (cone / wind WW) via MapServer ---------------------

  async function loadGis(bounds) {
    let data;
    try {
      const res = await fetch("/api/nhc/gis?layers=cone,watches");
      if (!res.ok) return;
      data = await res.json();
    } catch (_) {
      return; // overlays are nice-to-have; storms/tracks already rendered
    }
    if (!data) return;

    addCone(data.cone, bounds);
    addWatches(data.watches, bounds);
    applyGisVisibility();
  }

  function addCone(fc, bounds) {
    if (!fc || !fc.features || !fc.features.length) return;
    L.geoJSON(fc, {
      style: {
        color: "#ffffff",
        weight: 1.5,
        opacity: 0.9,
        fillColor: "#ffffff",
        fillOpacity: 0.18,
      },
      onEachFeature: (feat, layer) => {
        const p = feat.properties || {};
        const name = [p.stormtype, p.stormname].filter(Boolean).join(" ") || "Storm";
        const adv = p.advisnum != null ? "Adv #" + p.advisnum : "";
        layer.bindTooltip(
          "Cone · " + name + (adv ? " · " + adv : ""),
          { sticky: true }
        );
        extendBoundsFromGeom(feat.geometry, bounds);
        legendSeen.add("cone");
      },
    }).addTo(coneLayer);
  }

  function addWatches(fc, bounds) {
    if (!fc || !fc.features || !fc.features.length) return;
    L.geoJSON(fc, {
      style: (feat) => {
        const code = String((feat.properties || {}).tcww || "").toUpperCase();
        return {
          color: WW_COLORS[code] || "#ffffff",
          weight: 5,
          opacity: 0.95,
          lineCap: "round",
          lineJoin: "round",
        };
      },
      onEachFeature: (feat, layer) => {
        const p = feat.properties || {};
        const code = String(p.tcww || "").toUpperCase();
        const label = WW_LABELS[code] || "Watch/Warning";
        if (WW_COLORS[code]) legendSeen.add(code);
        const name = [p.stormtype, p.stormname].filter(Boolean).join(" ");
        layer.bindTooltip(
          label + (name ? " · " + name : ""),
          { sticky: true }
        );
        extendBoundsFromGeom(feat.geometry, bounds);
      },
    }).addTo(wwLayer);
  }

  function extendBoundsFromGeom(geom, bounds) {
    if (!geom || !bounds) return;
    const walk = (coords) => {
      if (!coords || !coords.length) return;
      if (typeof coords[0] === "number") {
        const [lon, lat] = coords;
        if (Number.isFinite(lat) && Number.isFinite(lon)) bounds.extend([lat, lon]);
        return;
      }
      coords.forEach(walk);
    };
    walk(geom.coordinates);
  }

  // --- Load model guidance (a-deck GeoJSON) --------------------------------

  async function loadTracks(storm, bounds, officialBounds) {
    const id = String(storm.id || "").toLowerCase();
    if (!/^[a-z]{2}\d{6}$/.test(id)) return;
    let fc;
    try {
      const res = await fetch("/api/nhc/adeck?id=" + encodeURIComponent(id));
      if (!res.ok) return;
      fc = await res.json();
    } catch (_) {
      return; // tracks are a nice-to-have; markers already rendered
    }
    addTrackFeatures(fc, bounds, officialBounds);
  }

  // Draw one a-deck FeatureCollection (storm or invest) into the track layers.
  // officialBounds, if given, also collects just the official forecast track.
  function addTrackFeatures(fc, bounds, officialBounds) {
    if (!fc || !fc.features || !fc.features.length) return;

    // Synoptic cycle the aids were initialized on (YYYYMMDDHH, UTC); combined
    // with each point's forecast hour (tau) to label points with a valid time.
    const init = (fc.properties && fc.properties.init) || null;

    fc.features.forEach((feat) => {
      const p = feat.properties || {};
      const modelOpacity = p.highlight ? HIGHLIGHT_OPACITY : MODEL_OPACITY;
      const style = p.official
        ? { color: "#ffffff", weight: 4, opacity: 0.95 }
        : p.consensus
        ? { color: "#66ccff", weight: 2.5, opacity: 0.85, dashArray: "5 4" }
        : p.highlight
        ? { color: HIGHLIGHT_COLOR, weight: 3, opacity: showModels ? modelOpacity : 0 }
        : { color: "#9fb3c8", weight: 1.5, opacity: showModels ? modelOpacity : 0 };

      legendSeen.add(
        p.official ? "official" : p.consensus ? "consensus" : p.highlight ? "highlight" : "model"
      );
      const line = L.geoJSON(feat, {
        style: style,
        onEachFeature: (f, layer) => {
          layer.bindTooltip(p.label || p.tech || "model", { sticky: true });
        },
      });
      // Tag model lines so the "Models" toggle can hide just those.
      if (!p.official && !p.consensus) {
        line._isModel = true;
        line._modelOpacity = modelOpacity;
      }
      line.addTo(tracksLayer);

      const coords = feat.geometry && feat.geometry.coordinates;
      // Only the official and consensus tracks frame the view. Individual
      // model runs are left out: one that wanders off across the Atlantic
      // used to zoom the first view out to the whole basin.
      if (coords && (p.official || p.consensus)) {
        coords.forEach(([lon, lat]) => bounds.extend([lat, lon]));
      }
      if (coords && p.official && officialBounds) {
        coords.forEach(([lon, lat]) => officialBounds.extend([lat, lon]));
      }

      // Drop forecast dots along the official and consensus tracks. Each has a
      // popup with its valid date/time (see addForecastPoints). Model spaghetti
      // is left as bare lines to keep the map readable.
      if ((p.official || p.consensus) && coords) addForecastPoints(feat, init);
    });

    applyModelVisibility();
  }

  // Plot a dot at each forecast point of a track. Official points are colored by
  // category and carry a popup with the point's valid date/time, forecast hour,
  // and intensity. Consensus points are plain blue dots (no popup) — just enough
  // to show where the consensus lands.
  function addForecastPoints(feat, init) {
    const p = feat.properties || {};
    const coords = feat.geometry && feat.geometry.coordinates;
    if (!coords) return;
    coords.forEach(([lon, lat], i) => {
      if (i === 0) return; // point 0 is ~the current position (already marked)
      const tau = p.taus ? p.taus[i] : null;
      const vmax = p.vmax ? p.vmax[i] : null;
      const marker = L.circleMarker([lat, lon], {
        radius: p.consensus ? 3.5 : 4,
        color: "#0b1220",
        weight: 1,
        fillColor: p.consensus ? "#66ccff" : catInfo(vmax, null).color,
        fillOpacity: 1,
      });
      if (!p.consensus) {
        marker.bindPopup(pointPopup(p.label, init, tau, vmax));
        legendSeen.add(catKey(catInfo(vmax, null)));
      }
      marker.addTo(ptsLayer);
    });
  }

  function pointPopup(label, init, tau, vmax) {
    const rows = ["<h3>" + esc(label || "Forecast") + "</h3>"];
    const when = fmtValid(init, tau);
    if (when) rows.push("<div>Valid " + esc(when) + "</div>");
    if (tau != null) rows.push("<div>Forecast +" + esc(String(tau)) + " h</div>");
    if (vmax != null)
      rows.push("<div>" + ktToMph(vmax) + " mph (" + esc(String(vmax)) + " kt)</div>");
    return '<div class="storm-popup">' + rows.join("") + "</div>";
  }

  // --- Popups & list -------------------------------------------------------

  function stormPopup(s, cat) {
    const mph = ktToMph(s.intensity);
    const move =
      s.movementDir != null && s.movementSpeed != null
        ? compass(s.movementDir) + " at " + s.movementSpeed + " kt"
        : "—";
    const links = [];
    if (s.forecastGraphics && s.forecastGraphics.url)
      links.push(link(s.forecastGraphics.url, "Cone graphic"));
    if (s.publicAdvisory && s.publicAdvisory.url)
      links.push(link(s.publicAdvisory.url, "Advisory"));
    if (s.forecastDiscussion && s.forecastDiscussion.url)
      links.push(link(s.forecastDiscussion.url, "Discussion"));

    return (
      '<div class="storm-popup">' +
      "<h3>" +
      esc(s.classification || "") +
      " " +
      esc(s.name || "Storm") +
      "</h3>" +
      "<div>" +
      esc(cat.name) +
      " · " +
      mph +
      " mph (" +
      esc(String(s.intensity)) +
      " kt)</div>" +
      "<div>Pressure " +
      esc(String(s.pressure)) +
      " mb</div>" +
      "<div>Moving " +
      esc(move) +
      "</div>" +
      "<div>Updated " +
      esc(fmtTime(s.lastUpdate)) +
      "</div>" +
      (links.length ? '<div class="links">' + links.join("") + "</div>" : "") +
      "</div>"
    );
  }

  function renderStormList() {
    els.stormList.innerHTML = storms
      .map((s, i) => {
        const cat = catInfo(s.intensity, s.classification);
        return (
          '<button class="storm-card" type="button" data-i="' +
          i +
          '">' +
          "<h3><span class=\"cat-dot\" style=\"background:" +
          cat.color +
          '"></span>' +
          esc(s.classification || "") +
          " " +
          esc(s.name || "Storm") +
          "</h3>" +
          '<div class="meta">' +
          esc(cat.name) +
          " · " +
          ktToMph(s.intensity) +
          " mph · " +
          esc(String(s.pressure)) +
          " mb · moving " +
          esc(compass(s.movementDir)) +
          "</div>" +
          "</button>"
        );
      })
      .join("");

    els.stormList.querySelectorAll(".storm-card").forEach((card) => {
      card.addEventListener("click", () => {
        const s = storms[Number(card.dataset.i)];
        const lat = Number(s.latitudeNumeric);
        const lon = Number(s.longitudeNumeric);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          map.flyTo([lat, lon], 6, { duration: 0.8 });
          closeSheet();
        }
      });
    });
  }

  function renderEmpty() {
    els.stormList.innerHTML =
      '<p class="storm-empty">No active tropical cyclones in the Atlantic or ' +
      "East Pacific right now.<br /><br />Areas NHC is watching appear on the " +
      'map. See the <a href="https://www.nhc.noaa.gov/gtwo.php" target="_blank" ' +
      'rel="noopener">Tropical Weather Outlook</a> for details.</p>';
  }

  // --- Toggles & sheet -----------------------------------------------------

  function toggleModels() {
    showModels = !showModels;
    els.modelsBtn.setAttribute("aria-pressed", showModels ? "true" : "false");
    applyModelVisibility();
    setStatus(showModels ? "Model guidance shown." : "Showing official forecast only.");
  }

  function applyModelVisibility() {
    tracksLayer.eachLayer((layer) => {
      if (layer._isModel) layer.setStyle({ opacity: showModels ? layer._modelOpacity : 0 });
    });
    updateLegend();
  }

  function toggleCone() {
    showCone = !showCone;
    els.coneBtn.setAttribute("aria-pressed", showCone ? "true" : "false");
    applyGisVisibility();
    setStatus(
      showCone
        ? "Forecast cone and wind watches/warnings shown."
        : "Cone and wind watches/warnings hidden."
    );
  }

  function toggleArrival() {
    showArrival = !showArrival;
    els.arrivalBtn.setAttribute("aria-pressed", showArrival ? "true" : "false");
    refreshHazardOverlay();
    setStatus(
      showArrival
        ? "Arrival time of tropical-storm-force winds shown."
        : "Wind-arrival overlay hidden."
    );
  }

  // Cycle off → 34 → 50 → 64 → off so one button covers the Probabilistic Winds group.
  function toggleWinds() {
    windMode = windMode + 1;
    if (windMode >= NHC_EXPORT_WINDS.length) windMode = -1;
    const on = windMode >= 0;
    const mode = on ? NHC_EXPORT_WINDS[windMode] : null;
    els.windsBtn.setAttribute("aria-pressed", on ? "true" : "false");
    if (els.windsBtnLabel) {
      els.windsBtnLabel.textContent = on ? mode.label : "Winds";
    }
    refreshHazardOverlay();
    setStatus(on ? mode.status + " shown." : "Probabilistic winds hidden.");
  }

  function toggleInundation() {
    showInundation = !showInundation;
    els.inundationBtn.setAttribute(
      "aria-pressed",
      showInundation ? "true" : "false"
    );
    refreshHazardOverlay();
    setStatus(
      showInundation
        ? "Storm-surge inundation shown (when NHC has issued a product)."
        : "Inundation overlay hidden."
    );
  }

  function applyGisVisibility() {
    setGroupOnMap(coneLayer, showCone);
    setGroupOnMap(wwLayer, showCone);
    bringInteractiveLayersFront();
    updateLegend();
  }

  function bringInteractiveLayersFront() {
    // Re-adding overlays can stack above markers; keep interaction targets on top.
    if (!map) return;
    // Plain LayerGroups have no bringToFront, so raise each member instead.
    const raise = (l) => (l.bringToFront ? l.bringToFront() : l.eachLayer && l.eachLayer(raise));
    [tracksLayer, ptsLayer, stormsLayer].forEach((g) => {
      if (map.hasLayer(g)) g.eachLayer(raise);
    });
  }

  // --- MapServer /export hazard overlays -----------------------------------

  function colorHazardLayerIds() {
    const ids = [];
    if (windMode >= 0) ids.push(NHC_EXPORT_WINDS[windMode].id);
    if (showInundation) ids.push.apply(ids, NHC_EXPORT_INUNDATION);
    return ids;
  }

  function scheduleHazardOverlayRefresh() {
    if (hazardRefreshTimer) clearTimeout(hazardRefreshTimer);
    hazardRefreshTimer = setTimeout(() => {
      hazardRefreshTimer = null;
      refreshHazardOverlay();
    }, 180);
  }

  // Request the export in Web Mercator (3857), the map's own projection. An
  // EPSG:4326 image is a plain lat/lon grid; stretched over Mercator bounds it
  // lands increasingly far north/south of the storm the further it is from
  // the center of the view. Pixels are scaled for retina (capped at 2x and at
  // the server's 4096px limit) with dpi raised to match, so labels and
  // contours come back sharp at their normal on-screen size.
  function exportImageUrl(layerIds, bounds, size) {
    const crs = map.options.crs;
    const sw = crs.project(bounds.getSouthWest());
    const ne = crs.project(bounds.getNorthEast());
    const scale = Math.min(window.devicePixelRatio || 1, 2, 4096 / Math.max(size.x, size.y, 1));
    const w = Math.max(64, Math.round(size.x * scale));
    const h = Math.max(64, Math.round(size.y * scale));
    const params = new URLSearchParams({
      bbox: [sw.x, sw.y, ne.x, ne.y].join(","),
      bboxSR: "3857",
      imageSR: "3857",
      size: w + "," + h,
      dpi: String(Math.round(96 * scale)),
      format: "png32",
      transparent: "true",
      layers: "show:" + layerIds.join(","),
      f: "image",
    });
    return NHC_MAPSERVER + "/export?" + params.toString();
  }

  // Double-buffered: the new viewport's image loads into a fresh, hidden
  // overlay and replaces the old one only once it has arrived. Swapping the
  // URL and bounds of a single overlay instead stretched the previous image
  // over the new bounds while the new one downloaded, which is what made the
  // overlay jump and smear after every pan or zoom.
  function setExportOverlay(slot, url, bounds, opts) {
    const current = slot.get();
    if (!url) {
      if (current) map.removeLayer(current);
      if (slot.pending) map.removeLayer(slot.pending);
      slot.pending = null;
      slot.set(null);
      return;
    }
    if (current && current._url === url) return;
    if (slot.pending) map.removeLayer(slot.pending);

    const next = L.imageOverlay(url, bounds, {
      pane: "hazardPane",
      opacity: 0,
      interactive: false,
      zIndex: opts.zIndex,
      className: opts.className || "",
    });
    slot.pending = next;
    next.once("load", () => {
      if (slot.pending !== next) return; // superseded by a newer viewport
      slot.pending = null;
      next.setOpacity(opts.opacity);
      const prev = slot.get();
      if (prev) map.removeLayer(prev);
      slot.set(next);
    });
    next.once("error", () => {
      if (slot.pending !== next) return;
      slot.pending = null;
      map.removeLayer(next);
    });
    next.addTo(map);
  }

  function refreshHazardOverlay() {
    if (!map) return;
    // Cover a margin around the viewport so a short pan doesn't uncover an
    // empty edge before the next export arrives.
    const bounds = map.getBounds().pad(EXPORT_PAD);
    const size = map.getSize().multiplyBy(1 + 2 * EXPORT_PAD);

    // Arrival alone so we can invert black contours without wrecking wind colors.
    const arrivalUrl = showArrival
      ? exportImageUrl(NHC_EXPORT_ARRIVAL, bounds, size)
      : null;
    setExportOverlay(
      arrivalSlot,
      arrivalUrl,
      bounds,
      {
        opacity: 0.95,
        zIndex: 360,
        className: "nhc-arrival-invert",
      }
    );

    const colorIds = colorHazardLayerIds();
    const colorUrl = colorIds.length
      ? exportImageUrl(colorIds, bounds, size)
      : null;
    setExportOverlay(
      colorHazardSlot,
      colorUrl,
      bounds,
      { opacity: 0.82, zIndex: 350 }
    );

    bringInteractiveLayersFront();
    updateLegend();
  }

  function setGroupOnMap(group, on) {
    if (!map || !group) return;
    if (on) {
      if (!map.hasLayer(group)) group.addTo(map);
    } else if (map.hasLayer(group)) {
      map.removeLayer(group);
    }
  }

  function openSheet() {
    if (!storms.length) return;
    els.stormSheet.classList.remove("hidden");
    els.stormSheet.setAttribute("aria-hidden", "false");
  }

  function closeSheet() {
    els.stormSheet.classList.add("hidden");
    els.stormSheet.setAttribute("aria-hidden", "true");
  }

  // --- Helpers -------------------------------------------------------------

  // --- Map key --------------------------------------------------------------

  // Keys of everything drawn on the last load (category keys, track kinds,
  // outlook risks, watch/warning codes, …), matching the key's data-k rows.
  // updateLegend() shows a row only if it was drawn AND its layer is toggled
  // on, hides any section left empty, and hides the key if nothing is left.
  const legendSeen = new Set();
  const CAT_KEYS = {
    "Category 5": "cat5",
    "Category 4": "cat4",
    "Category 3": "cat3",
    "Category 2": "cat2",
    "Category 1": "cat1",
    "Tropical Storm": "ts",
  };
  const LEGEND_OPEN_KEY = "tropics.legendOpen";

  function catKey(cat) {
    return CAT_KEYS[cat.name] || "td"; // depressions + subtropical share a color
  }

  function legendRowVisible(k) {
    if (k === "arrival") return showArrival;
    if (k === "winds") return windMode >= 0;
    if (k === "inundation") return showInundation;
    if (!legendSeen.has(k)) return false;
    if (k === "model" || k === "highlight") return showModels;
    if (k === "cone" || WW_COLORS[k]) return showCone;
    if (k === "low" || k === "medium" || k === "high" || k === "invest") return showOutlook;
    return true;
  }

  function updateLegend() {
    if (!els.legend) return;
    if (els.legendWindsLabel) {
      els.legendWindsLabel.textContent =
        windMode >= 0 ? "Prob. winds (" + NHC_EXPORT_WINDS[windMode].label + ")" : "Prob. winds";
    }
    let any = false;
    els.legend.querySelectorAll("section[data-sec]").forEach((sec) => {
      let shown = 0;
      sec.querySelectorAll(".row[data-k]").forEach((row) => {
        const on = legendRowVisible(row.dataset.k);
        row.hidden = !on;
        if (on) shown++;
      });
      sec.hidden = !shown;
      if (shown) any = true;
    });
    els.legend.classList.toggle("hidden", !any);
  }

  function setLegendOpen(open, remember) {
    els.legend.classList.toggle("collapsed", !open);
    els.legendToggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (!remember) return;
    try {
      localStorage.setItem(LEGEND_OPEN_KEY, open ? "1" : "0");
    } catch (_) {
      /* private mode — the choice just won't persist */
    }
  }

  function initLegend() {
    let open = false; // collapsed by default: the open key covers a third of a phone map
    try {
      open = localStorage.getItem(LEGEND_OPEN_KEY) === "1";
    } catch (_) {}
    setLegendOpen(open, false);
    els.legendToggle.addEventListener("click", () =>
      setLegendOpen(els.legend.classList.contains("collapsed"), true)
    );
    updateLegend();
  }

  function setStatus(msg, isError) {
    els.status.textContent = msg;
    els.status.classList.toggle("error", !!isError);
  }

  // Red iOS-style badge on the Storms button; hidden when count is 0.
  function setStormCount(n) {
    const count = Math.max(0, Number(n) || 0);
    const label = count === 1 ? "1 storm" : count + " storms";
    els.stormsBtn.setAttribute("aria-label", "Storms, " + label);
    if (!els.stormsBadge) return;
    els.stormsBadge.dataset.count = String(count);
    els.stormsBadge.textContent = count > 99 ? "99+" : count ? String(count) : "";
  }

  function ktToMph(kt) {
    return Math.round((Number(kt) || 0) * 1.15078);
  }

  function compass(deg) {
    if (deg == null || deg === "") return "—";
    const dirs = [
      "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
      "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
    ];
    return dirs[Math.round(Number(deg) / 22.5) % 16] || "—";
  }

  function fmtTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return "—";
    return d.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  // A forecast point's valid time = the aid's init cycle (YYYYMMDDHH, UTC) plus
  // its forecast hour (tau).
  function validDate(init, tau) {
    if (!init || tau == null || !/^\d{10}$/.test(String(init))) return null;
    const s = String(init);
    const t = Date.UTC(
      +s.slice(0, 4),
      +s.slice(4, 6) - 1,
      +s.slice(6, 8),
      +s.slice(8, 10)
    );
    const d = new Date(t + Number(tau) * 3600 * 1000);
    return isNaN(d) ? null : d;
  }

  function fmtValid(init, tau) {
    const d = validDate(init, tau);
    if (!d) return null;
    return d.toLocaleString([], {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function link(href, text) {
    return (
      '<a href="' +
      esc(href) +
      '" target="_blank" rel="noopener">' +
      esc(text) +
      "</a>"
    );
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
    initLegend();
    els.stormsBtn.addEventListener("click", openSheet);
    els.stormClose.addEventListener("click", closeSheet);
    els.modelsBtn.addEventListener("click", toggleModels);
    els.coneBtn.addEventListener("click", toggleCone);
    els.outlookBtn.addEventListener("click", toggleOutlook);
    els.arrivalBtn.addEventListener("click", toggleArrival);
    els.windsBtn.addEventListener("click", toggleWinds);
    els.inundationBtn.addEventListener("click", toggleInundation);
    els.refreshBtn.addEventListener("click", () => loadStorms(true));

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") loadStorms(false);
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    setViewportHeightSettled();
    initMap();
    bind();
    loadStorms(false);
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => loadStorms(false), REFRESH_MS);
  });
})();
