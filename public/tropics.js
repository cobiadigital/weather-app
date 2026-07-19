/* ----------------------------------------------------------------------------
   Tropics — tropical-cyclone model tracks & the NHC official forecast.

   - Leaflet map (same CARTO dark basemap as the radar page).
   - Current storm positions + intensity from the NHC CurrentStorms feed,
     proxied by this Worker at /api/nhc/current (Atlantic + East Pacific).
   - "Spaghetti" model tracks + the official (OFCL) forecast decoded from the
     NHC ATCF a-deck at /api/nhc/adeck?id=<stormId> (see src/index.js).

   Vanilla JS, IIFE-wrapped, no dependencies — matches app.js conventions.
---------------------------------------------------------------------------- */

(function () {
  "use strict";

  // Centered on the tropical Atlantic; bounds are refit once storms load.
  const DEFAULT_VIEW = { lat: 22, lon: -72, zoom: 4 };
  const REFRESH_MS = 10 * 60 * 1000; // advisories update a few times a day

  const els = {
    status: document.getElementById("status"),
    stormsBtn: document.getElementById("stormsBtn"),
    stormsBtnText: document.getElementById("stormsBtnText"),
    modelsBtn: document.getElementById("modelsBtn"),
    refreshBtn: document.getElementById("refreshBtn"),
    stormSheet: document.getElementById("stormSheet"),
    stormList: document.getElementById("stormList"),
    stormClose: document.getElementById("stormClose"),
    legend: document.getElementById("legend"),
  };

  let map;
  let stormsLayer; // current-position markers
  let tracksLayer; // all model + official forecast lines
  let ptsLayer; // official forecast points (labeled dots)
  let showModels = true; // spaghetti visible by default
  let refreshTimer;
  let storms = []; // last-loaded storm list

  // --- Map setup -----------------------------------------------------------

  function initMap() {
    map = L.map("map", {
      zoomControl: false,
      attributionControl: true,
      maxZoom: 12,
      minZoom: 2,
    }).setView([DEFAULT_VIEW.lat, DEFAULT_VIEW.lon], DEFAULT_VIEW.zoom);

    L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a> · Data: <a href="https://www.nhc.noaa.gov/">NOAA NHC</a>',
        subdomains: "abcd",
        maxZoom: 19,
      }
    ).addTo(map);

    stormsLayer = L.layerGroup().addTo(map);
    tracksLayer = L.layerGroup().addTo(map);
    ptsLayer = L.layerGroup().addTo(map);

    setTimeout(() => map.invalidateSize(), 0);
    window.addEventListener("orientationchange", () => {
      setTimeout(() => map && map.invalidateSize(), 250);
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

    stormsLayer.clearLayers();
    tracksLayer.clearLayers();
    ptsLayer.clearLayers();

    if (!storms.length) {
      renderEmpty();
      map.setView([DEFAULT_VIEW.lat, DEFAULT_VIEW.lon], DEFAULT_VIEW.zoom);
      setStatus("No active tropical cyclones.");
      els.stormsBtnText.textContent = "Storms";
      return;
    }

    const bounds = L.latLngBounds([]);
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
    els.stormsBtnText.textContent =
      storms.length + " storm" + (storms.length > 1 ? "s" : "");
    setStatus(
      "Showing " + storms.length + " active storm" + (storms.length > 1 ? "s" : "") + "."
    );

    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [60, 60], maxZoom: 6 });
    }

    // Fetch model tracks for each storm in parallel; each extends the bounds.
    await Promise.all(storms.map((s) => loadTracks(s, bounds)));
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 6 });
    }
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
    if (!fc || !fc.features || !fc.features.length) return;

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

      // Official forecast: drop labeled, category-colored dots at each point.
      if (p.official && coords) {
        coords.forEach(([lon, lat], i) => {
          const tau = p.taus ? p.taus[i] : null;
          const vmax = p.vmax ? p.vmax[i] : null;
          if (i === 0) return; // point 0 is the current position (already marked)
          const cat = catInfo(vmax, null);
          L.circleMarker([lat, lon], {
            radius: 4,
            color: "#0b1220",
            weight: 1,
            fillColor: cat.color,
            fillOpacity: 1,
          })
            .bindTooltip(forecastLabel(storm.name, tau, vmax), { direction: "top" })
            .addTo(ptsLayer);
        });
      }
    });

    applyModelVisibility();
  }

  function forecastLabel(name, tau, vmax) {
    const parts = [esc(name || "Forecast")];
    if (tau != null) {
      parts.push(tau === 0 ? "now" : "+" + tau + "h");
    }
    if (vmax != null) parts.push(ktToMph(vmax) + " mph");
    return parts.join(" · ");
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
      "East Pacific right now.<br /><br />See the National Hurricane Center's " +
      '<a href="https://www.nhc.noaa.gov/gtwo.php" target="_blank" rel="noopener">' +
      "Tropical Weather Outlook</a> for anything under watch.</p>";
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
    els.refreshBtn.addEventListener("click", () => loadStorms(true));

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
