/* Buoys: NOAA NDBC stations as tappable dots, shared by the radar page and
   /tropics. One fetch of /api/buoys (the Worker's parse of NDBC's latest_obs)
   feeds every station; dots are viewport-culled so a zoomed-out map stays
   light, and a tap opens the latest report. Exposes window.Buoys.attach(). */
(function () {
  "use strict";

  const STORE_KEY = "buoys.on";
  const MARKER_MAX = 350;
  const REFRESH_MS = 5 * 60 * 1000;
  const STALE_S = 3 * 3600; // NDBC reports hourly; older than this is likely adrift/offline
  const KIND_LABEL = { buoy: "Buoy", station: "Coastal station", other: "Station" };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  const COMPASS = [
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
  ];
  const has = (v) => typeof v === "number" && isFinite(v);
  const mph = (ms) => Math.round(ms * 2.23694);
  const ft = (m) => (m * 3.28084).toFixed(1);
  const degF = (c) => Math.round(c * 1.8 + 32) + "°F";

  function ago(ts) {
    const mins = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60));
    if (mins < 60) return mins + " min ago";
    const h = Math.floor(mins / 60);
    return h < 48 ? h + " h ago" : Math.floor(h / 24) + " d ago";
  }

  function row(label, value) {
    return '<div class="buoy-row"><span>' + label + "</span><b>" + value + "</b></div>";
  }

  function popupHtml(st) {
    const o = st[5];
    const rows = [];
    if (has(o.wspd)) {
      let w = mph(o.wspd) + " mph";
      if (has(o.wdir)) w = COMPASS[Math.round(o.wdir / 22.5) % 16] + " " + w;
      if (has(o.gst)) w += ", gusts " + mph(o.gst);
      rows.push(row("Wind", esc(w)));
    }
    if (has(o.wvht)) {
      let w = ft(o.wvht) + " ft";
      if (has(o.dpd)) w += " at " + Math.round(o.dpd) + " s";
      rows.push(row("Waves", esc(w)));
    }
    if (has(o.apd) && !has(o.dpd)) rows.push(row("Avg wave period", Math.round(o.apd) + " s"));
    if (has(o.atmp)) rows.push(row("Air", esc(degF(o.atmp))));
    if (has(o.wtmp)) rows.push(row("Water", esc(degF(o.wtmp))));
    if (has(o.dewp)) rows.push(row("Dew point", esc(degF(o.dewp))));
    if (has(o.pres)) {
      let p = (o.pres * 0.02953).toFixed(2) + " inHg (" + Math.round(o.pres) + " hPa)";
      if (has(o.ptdy) && o.ptdy !== 0) {
        p += o.ptdy > 0 ? ", rising" : ", falling";
        p += " " + Math.abs(o.ptdy).toFixed(1) + " hPa/3h";
      } else if (has(o.ptdy)) {
        p += ", steady";
      }
      rows.push(row("Pressure", esc(p)));
    }
    if (has(o.vis)) rows.push(row("Visibility", esc((o.vis * 1.15078).toFixed(1) + " mi")));
    if (has(o.tide)) rows.push(row("Tide", esc(o.tide.toFixed(1) + " ft")));
    return (
      '<div class="buoy-popup"><h3>' + esc(st[3] || "Station " + st[0]) + "</h3>" +
      '<div class="buoy-sub">' + esc(KIND_LABEL[st[4]] || "Station") + " " + esc(st[0]) +
      " · " + esc(ago(o.ts)) + "</div>" +
      rows.join("") +
      '<a class="buoy-link" href="https://www.ndbc.noaa.gov/station_page.php?station=' +
      encodeURIComponent(st[0].toLowerCase()) +
      '" target="_blank" rel="noopener">NDBC station page</a></div>'
    );
  }

  function attach(map, opts) {
    opts = opts || {};
    const onStatus = opts.onStatus || function () {};
    let on = false;
    let stations = null;
    let loading = null;
    let layer = null;
    let timer = null;
    let moveTimer = null;
    let loadedAt = 0;

    try { on = localStorage.getItem(STORE_KEY) === "1"; } catch (_) {}

    function load(force) {
      if (loading) return loading;
      if (!force && stations && Date.now() - loadedAt < REFRESH_MS) return Promise.resolve();
      loading = fetch("/api/buoys")
        .then((r) => { if (!r.ok) throw new Error("buoys " + r.status); return r.json(); })
        .then((d) => { stations = d.stations || []; loadedAt = Date.now(); })
        .finally(() => { loading = null; });
      return loading;
    }

    function render() {
      if (layer) { map.removeLayer(layer); layer = null; }
      if (!on || !stations) return;
      const b = map.getBounds().pad(0.2);
      const c = map.getCenter();
      const vis = [];
      for (const st of stations) {
        if (!b.contains([st[1], st[2]])) continue;
        const dy = st[1] - c.lat;
        const dx = st[2] - c.lng;
        vis.push({ st: st, d: dx * dx + dy * dy });
      }
      vis.sort((a, z) => a.d - z.d);
      layer = L.layerGroup();
      const nowS = Date.now() / 1000;
      vis.slice(0, MARKER_MAX).forEach((v) => {
        const st = v.st;
        const stale = nowS - st[5].ts > STALE_S;
        // Visible dot is not interactive; a larger invisible circle carries
        // the tap so a thumb can hit it (the dot alone would be ~10px).
        L.circleMarker([st[1], st[2]], {
          radius: 5, weight: 2, color: "#fff", opacity: stale ? 0.45 : 0.95,
          fillColor: "#14b8a6", fillOpacity: stale ? 0.4 : 0.95, interactive: false,
        }).addTo(layer);
        L.circleMarker([st[1], st[2]], {
          radius: 18, stroke: false, fillOpacity: 0, fillColor: "#000",
        })
          .bindPopup(() => popupHtml(st), { className: "buoy-pop", maxWidth: 280, autoPanPadding: [16, 80] })
          .addTo(layer);
      });
      layer.addTo(map);
    }

    function show() {
      onStatus("Loading buoys…");
      load(false).then(() => {
        if (!on) return;
        render();
        onStatus("Buoys shown. Tap a dot for conditions.");
      }).catch(() => {
        if (on) onStatus("Buoy data is unavailable right now.", true);
      });
      clearInterval(timer);
      timer = setInterval(() => {
        load(true).then(render).catch(() => {});
      }, REFRESH_MS);
    }

    map.on("moveend", () => {
      if (!on) return;
      clearTimeout(moveTimer);
      moveTimer = setTimeout(render, 120);
    });

    if (on) show();

    return {
      isEnabled: () => on,
      setEnabled(v) {
        on = !!v;
        try { localStorage.setItem(STORE_KEY, on ? "1" : "0"); } catch (_) {}
        if (on) {
          show();
        } else {
          clearInterval(timer);
          render();
          onStatus("Buoys hidden.");
        }
      },
    };
  }

  window.Buoys = { attach: attach };
})();
