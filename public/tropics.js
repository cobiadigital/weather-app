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
    shareBtn: document.getElementById("shareBtn"),
    stormSheet: document.getElementById("stormSheet"),
    stormList: document.getElementById("stormList"),
    stormClose: document.getElementById("stormClose"),
    legend: document.getElementById("legend"),
  };

  const SHARE_URL = "https://bendar.app/tropics";
  const SHARE_TEXT = "Tropical outlook and model tracks — " + SHARE_URL;

  let map;
  let basemapLayer; // kept so Share can copy its tiles onto a canvas
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

  // --- Map setup -----------------------------------------------------------

  function initMap() {
    map = L.map("map", {
      zoomControl: false,
      attributionControl: true,
      maxZoom: 12,
      minZoom: 2,
    }).setView([DEFAULT_VIEW.lat, DEFAULT_VIEW.lon], DEFAULT_VIEW.zoom);

    // Via the Worker (/api/basemap/*), which attaches the CARTO key — see app.js.
    basemapLayer = L.tileLayer("/api/basemap/dark/{z}/{x}/{y}{r}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a> · Data: <a href="https://www.nhc.noaa.gov/">NOAA NHC</a>',
      maxZoom: 19,
      crossOrigin: "anonymous", // keep the basemap canvas-exportable (Share)
    }).addTo(map);

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

    setTimeout(() => map.invalidateSize(), 0);
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

    const bounds = L.latLngBounds([]);

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
        if (bounds.isValid()) map.fitBounds(bounds, { padding: [50, 50], maxZoom: 6 });
        else map.setView([DEFAULT_VIEW.lat, DEFAULT_VIEW.lon], DEFAULT_VIEW.zoom);
        hasFramedView = true;
      }
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
    });

    renderStormList();
    setStormCount(storms.length);
    setStatus(
      "Showing " + storms.length + " active storm" + (storms.length > 1 ? "s" : "") + "."
    );

    // Frame once on first successful load. Refresh / auto-refresh / tab-focus
    // reloads keep whatever pan/zoom the user has.
    const shouldFrame = !hasFramedView;
    if (shouldFrame && bounds.isValid()) {
      map.fitBounds(bounds, { padding: [60, 60], maxZoom: 6 });
    }

    // Model tracks + official GIS overlays in parallel; each may extend bounds.
    await Promise.all([
      Promise.all(storms.map((s) => loadTracks(s, bounds))),
      loadGis(bounds),
      loadDisturbances(bounds),
    ]);
    if (shouldFrame && bounds.isValid()) {
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 6 });
    }
    if (shouldFrame) hasFramedView = true;
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
      const color = OUTLOOK_COLORS[String(p.risk7day).toLowerCase()] || OUTLOOK_COLORS.low;
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

  async function loadTracks(storm, bounds) {
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
    addTrackFeatures(fc, bounds);
  }

  // Draw one a-deck FeatureCollection (storm or invest) into the track layers.
  function addTrackFeatures(fc, bounds) {
    if (!fc || !fc.features || !fc.features.length) return;

    // Synoptic cycle the aids were initialized on (YYYYMMDDHH, UTC); combined
    // with each point's forecast hour (tau) to label points with a valid time.
    const init = (fc.properties && fc.properties.init) || null;

    fc.features.forEach((feat) => {
      const p = feat.properties || {};
      const style = p.official
        ? { color: "#ffffff", weight: 4, opacity: 0.95 }
        : p.consensus
        ? { color: "#66ccff", weight: 2.5, opacity: 0.85, dashArray: "5 4" }
        : { color: "#9fb3c8", weight: 1.5, opacity: showModels ? 0.5 : 0 };

      const line = L.geoJSON(feat, {
        style: style,
        onEachFeature: (f, layer) => {
          layer.bindTooltip(p.label || p.tech || "model", { sticky: true });
        },
      });
      // Tag model lines so the "Models" toggle can hide just those.
      if (!p.official && !p.consensus) line._isModel = true;
      line.addTo(tracksLayer);

      const coords = feat.geometry && feat.geometry.coordinates;
      if (coords) coords.forEach(([lon, lat]) => bounds.extend([lat, lon]));

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
      if (!p.consensus) marker.bindPopup(pointPopup(p.label, init, tau, vmax));
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
      if (layer._isModel) layer.setStyle({ opacity: showModels ? 0.5 : 0 });
    });
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
  }

  function bringInteractiveLayersFront() {
    // Re-adding overlays can stack above markers; keep interaction targets on top.
    if (!map) return;
    if (map.hasLayer(tracksLayer)) tracksLayer.bringToFront();
    if (map.hasLayer(ptsLayer)) ptsLayer.bringToFront();
    if (map.hasLayer(stormsLayer)) stormsLayer.bringToFront();
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

  function exportImageUrl(layerIds, bounds, size) {
    // MapServer caps image size; keep export cheap on retina phones.
    const w = Math.max(64, Math.min(Math.round(size.x), 1280));
    const h = Math.max(64, Math.min(Math.round(size.y), 1280));
    const bbox = [
      bounds.getWest(),
      bounds.getSouth(),
      bounds.getEast(),
      bounds.getNorth(),
    ].join(",");
    const params = new URLSearchParams({
      bbox: bbox,
      bboxSR: "4326",
      imageSR: "4326",
      size: w + "," + h,
      dpi: "96",
      format: "png32",
      transparent: "true",
      layers: "show:" + layerIds.join(","),
      f: "image",
    });
    return NHC_MAPSERVER + "/export?" + params.toString();
  }

  function setExportOverlay(slot, url, bounds, opts) {
    let overlay = slot.get();
    if (!url) {
      if (overlay) {
        map.removeLayer(overlay);
        slot.set(null);
      }
      return;
    }
    if (!overlay) {
      overlay = L.imageOverlay(url, bounds, {
        opacity: opts.opacity,
        interactive: false,
        zIndex: opts.zIndex,
        className: opts.className || "",
      }).addTo(map);
      slot.set(overlay);
    } else {
      overlay.setUrl(url);
      overlay.setBounds(bounds);
      if (!map.hasLayer(overlay)) overlay.addTo(map);
    }
  }

  function refreshHazardOverlay() {
    if (!map) return;
    const bounds = map.getBounds();
    const size = map.getSize();

    // Arrival alone so we can invert black contours without wrecking wind colors.
    const arrivalUrl = showArrival
      ? exportImageUrl(NHC_EXPORT_ARRIVAL, bounds, size)
      : null;
    setExportOverlay(
      {
        get: () => arrivalOverlay,
        set: (v) => {
          arrivalOverlay = v;
        },
      },
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
      {
        get: () => colorHazardOverlay,
        set: (v) => {
          colorHazardOverlay = v;
        },
      },
      colorUrl,
      bounds,
      { opacity: 0.82, zIndex: 350 }
    );

    bringInteractiveLayersFront();
  }

  function setGroupOnMap(group, on) {
    if (!map || !group) return;
    if (on) {
      if (!map.hasLayer(group)) group.addTo(map);
    } else if (map.hasLayer(group)) {
      map.removeLayer(group);
    }
  }

  // --- Share current view as an image --------------------------------------

  // Same approach as the radar page: paint the visible map onto a canvas and
  // hand the PNG to the native share sheet (Web Share API Level 2), falling
  // back to a download. As on the radar page, put the URL in `text` and leave
  // `url` unset: iOS treats `url` as a link-only share and drops the image.
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

    const file = new File([blob], "bendar-tropics.png", { type: "image/png" });
    const data = { files: [file], title: "Bendar.app tropics", text: SHARE_TEXT };
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share(data);
        setStatus("Shared.");
      } else {
        downloadBlob(blob, "bendar-tropics.png");
        setStatus("Tropics image saved.");
      }
    } catch (err) {
      // Dismissing the share sheet throws AbortError. Not an error.
      if (err && err.name === "AbortError") {
        setStatus("Share canceled.");
      } else {
        downloadBlob(blob, "bendar-tropics.png");
        setStatus("Tropics image saved.");
      }
    } finally {
      els.shareBtn.disabled = false;
    }
  }

  // Paint the visible map: basemap tiles, then the vector layers (outlook areas,
  // cone, tracks, markers) by rasterizing Leaflet's SVG renderer, then the
  // MapServer hazard images, then a caption. Overlay images are re-fetched with
  // CORS for the capture only, so the on-screen overlays stay untouched and a
  // CORS failure just leaves that overlay out of the share.
  async function captureView() {
    const size = map.getSize();
    const zoom = map.getZoom();
    const origin = map.getPixelBounds().min;
    const mapRect = map.getContainer().getBoundingClientRect();

    const scale = Math.min(2, window.devicePixelRatio || 1);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(size.x * scale);
    canvas.height = Math.round(size.y * scale);
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    ctx.fillStyle = "#0b1220";
    ctx.fillRect(0, 0, size.x, size.y);

    drawTiles(ctx, basemapLayer, zoom, origin);

    // Fetch the hazard images in parallel with the SVG decode.
    const overlays = [
      { layer: colorHazardOverlay, filter: "none", alpha: 0.82 },
      { layer: arrivalOverlay, filter: "invert(1)", alpha: 0.95 },
    ].filter((o) => o.layer && map.hasLayer(o.layer));
    const [vectors, images] = await Promise.all([
      rasterizeVectors(),
      Promise.all(overlays.map((o) => fetchOverlayBitmap(o.layer))),
    ]);

    if (vectors) ctx.drawImage(vectors.img, vectors.x - mapRect.left, vectors.y - mapRect.top, vectors.w, vectors.h);
    overlays.forEach((o, i) => {
      const bmp = images[i];
      if (!bmp) return;
      const el = o.layer.getElement();
      const r = el.getBoundingClientRect();
      ctx.globalAlpha = o.alpha;
      if ("filter" in ctx) ctx.filter = o.filter;
      ctx.drawImage(bmp, r.left - mapRect.left, r.top - mapRect.top, r.width, r.height);
      ctx.globalAlpha = 1;
      if ("filter" in ctx) ctx.filter = "none";
    });

    drawCaption(ctx, size);

    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))),
        "image/png"
      );
    });
  }

  function drawTiles(ctx, layer, zoom, origin) {
    const tiles = layer && layer._tiles;
    if (!tiles) return;
    const tz = layer._tileZoom == null ? zoom : layer._tileZoom;
    const size = 256 * Math.pow(2, zoom - tz);
    for (const key in tiles) {
      const tile = tiles[key];
      if (!tile.current || !tile.loaded || !tile.el || !tile.coords) continue;
      if (tile.coords.z !== tz) continue;
      if (tile.el.tagName === "IMG" && !tile.el.naturalWidth) continue;
      try {
        ctx.drawImage(tile.el, tile.coords.x * size - origin.x, tile.coords.y * size - origin.y, size, size);
      } catch (_) {
        /* one bad tile shouldn't sink the capture */
      }
    }
  }

  // Leaflet draws every vector layer into one <svg> in the overlay pane, sized
  // a bit larger than the viewport. Serialize it and decode it as an image.
  // Resolves to null when there's nothing drawn or the browser can't decode it.
  async function rasterizeVectors() {
    const svg = map.getPane("overlayPane").querySelector("svg");
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const clone = svg.cloneNode(true);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", rect.width);
    clone.setAttribute("height", rect.height);
    clone.style.transform = "none";
    const url =
      "data:image/svg+xml;charset=utf-8," +
      encodeURIComponent(new XMLSerializer().serializeToString(clone));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { img, x: rect.left, y: rect.top, w: rect.width, h: rect.height };
    } catch (_) {
      return null;
    }
  }

  async function fetchOverlayBitmap(overlay) {
    try {
      const res = await fetch(overlay._url, { mode: "cors" });
      if (!res.ok) return null;
      return await createImageBitmap(await res.blob());
    } catch (_) {
      return null;
    }
  }

  function drawCaption(ctx, size) {
    const font = "-apple-system, system-ui, Helvetica, Arial, sans-serif";
    const x = 12;
    const barH = 52;
    const top = size.y - barH;
    const grad = ctx.createLinearGradient(0, top - 14, 0, size.y);
    grad.addColorStop(0, "rgba(11, 18, 32, 0)");
    grad.addColorStop(1, "rgba(11, 18, 32, 0.9)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, top - 14, size.x, barH + 14);

    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.fillStyle = "#dbe8ff";
    ctx.font = "600 15px " + font;
    ctx.fillText("Bendar.app", x, top + 22);
    const brandW = ctx.measureText("Bendar.app").width;
    ctx.fillStyle = "rgba(219, 232, 255, 0.8)";
    ctx.font = "400 13px " + font;
    const when = new Date().toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    ctx.fillText("  ·  Tropics · " + when, x + brandW, top + 22);

    ctx.fillStyle = "rgba(219, 232, 255, 0.5)";
    ctx.font = "400 10px " + font;
    ctx.fillText("Data: NOAA National Hurricane Center  ·  © OpenStreetMap, © CARTO", x, top + 42);
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
    els.stormsBtn.addEventListener("click", openSheet);
    els.stormClose.addEventListener("click", closeSheet);
    els.modelsBtn.addEventListener("click", toggleModels);
    els.coneBtn.addEventListener("click", toggleCone);
    els.outlookBtn.addEventListener("click", toggleOutlook);
    els.arrivalBtn.addEventListener("click", toggleArrival);
    els.windsBtn.addEventListener("click", toggleWinds);
    els.inundationBtn.addEventListener("click", toggleInundation);
    els.refreshBtn.addEventListener("click", () => loadStorms(true));
    els.shareBtn.addEventListener("click", shareView);

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") loadStorms(false);
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    initMap();
    bind();
    loadStorms(false);
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => loadStorms(false), REFRESH_MS);
  });
})();
