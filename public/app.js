/* ----------------------------------------------------------------------------
   Bendar.app — front-end logic.

   - Leaflet map with an OpenStreetMap base layer.
   - Radar overlays, chosen in the gear-icon settings sheet:
       * NOAA MRMS CONUS mosaics (the default) and any individual NEXRAD /
         TDWR radar site, both proxied and re-tiled by our Worker (see
         src/index.js) and cached on-device by frame time.
       * Iowa Environmental Mesonet (IEM) NEXRAD tiles, kept as a selectable
         product and as the off-CONUS fallback for the MRMS mosaics.
   - Active weather alerts + nearest-station conditions via the NWS API,
     proxied through this Worker at /api/nws/* (see src/index.js).
---------------------------------------------------------------------------- */

(function () {
  "use strict";

  // IEM tile cache root. Layer names are product-specific (see RADAR_PRODUCTS).
  // All are EPSG:3857 / web-mercator {z}/{x}/{y} PNGs. See mesonet…/ogc/.
  const IEM_TILE_ROOT =
    "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/";

  // Selectable radar products. The MRMS-backed ones (mrmsLayer set) share the
  // Worker-proxied, cached tile pipeline below; "base" (IEM NEXRAD) has its
  // own time-enabled WMS for the loop. `loop` gates whether Loop 2h is
  // available at all; its shape (true vs {wmsUrl,wmsLayer}) tells startLoop
  // which frame-building path to use.
  const RADAR_PRODUCTS = {
    base: {
      id: "base",
      label: "Base Reflectivity (NEXRAD)",
      layer: "nexrad-n0q-900913",
      attribution:
        'Radar: <a href="https://mesonet.agron.iastate.edu/">Iowa Env. Mesonet</a> / NWS NEXRAD',
      // Time-enabled NEXRAD N0Q WMS (IEM "time machine") for the last-2h loop.
      loop: {
        wmsUrl: "https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi",
        wmsLayer: "nexrad-n0q-wmst",
      },
    },
    mrms: {
      id: "mrms",
      label: "Base Reflectivity (MRMS)",
      // mrmsLayer is the path segment the Worker's /api/mrms/{layer}/* routes
      // expect (see src/index.js MRMS_LAYERS) — it re-tiles NCEP's MRMS WMS
      // and bakes the frame time into the URL so live tiles and loop tiles
      // share cache keys.
      mrmsLayer: "base",
      attribution:
        'Radar: <a href="https://www.nssl.noaa.gov/projects/mrms/">NOAA MRMS</a> via NCEP',
      loop: true,
    },
    composite: {
      id: "composite",
      label: "Composite Reflectivity",
      mrmsLayer: "composite",
      attribution:
        'Radar: <a href="https://www.nssl.noaa.gov/projects/mrms/">NOAA MRMS</a> via NCEP',
      loop: true,
    },
    ptype: {
      id: "ptype",
      label: "Precipitation Type",
      mrmsLayer: "ptype",
      attribution:
        'Precip type: <a href="https://www.nssl.noaa.gov/projects/mrms/">NOAA MRMS</a> via NCEP',
      loop: true,
    },
    eet: {
      id: "eet",
      label: "Echo Tops",
      mrmsLayer: "eet",
      attribution:
        'Echo tops: <a href="https://www.nssl.noaa.gov/projects/mrms/">NOAA MRMS</a> via NCEP',
      loop: true,
    },
    // Hidden — not rendered in settings, never assigned directly by the user.
    // MRMS is CONUS-only; these are the off-CONUS fallback source for the
    // composite/ptype/eet products above (see MRMS_FALLBACK), preserving the
    // OCONUS coverage those products had before they were MRMS-backed.
    compositeIem: {
      id: "compositeIem",
      label: "Composite Reflectivity",
      // MRMS Hybrid-Scan Reflectivity (SeamlessHSR) — multi-tilt composite.
      layer: "q2-hsr-900913",
      attribution:
        'Radar: <a href="https://mesonet.agron.iastate.edu/">Iowa Env. Mesonet</a> / NOAA MRMS',
      loop: null,
    },
    ptypeIem: {
      id: "ptypeIem",
      label: "Precipitation Type",
      // HRRR 0-hour reflectivity colored by precip type (rain/snow/mix/ice).
      layer: "hrrr::REFP-F0000-0",
      attribution:
        'Precip type: <a href="https://mesonet.agron.iastate.edu/">Iowa Env. Mesonet</a> / NOAA HRRR',
      loop: null,
    },
    eetIem: {
      id: "eetIem",
      label: "Echo Tops",
      layer: "nexrad-eet-900913",
      attribution:
        'Echo tops: <a href="https://mesonet.agron.iastate.edu/">Iowa Env. Mesonet</a> / NWS NEXRAD',
      loop: null,
    },
  };
  const DEFAULT_PRODUCT = "mrms";

  // GOES East infrared composite from IEM. This is *satellite* cloud imagery
  // (NOT part of the NEXRAD radar product) — infrared shows cloud cover day and
  // night. Same {z}/{x}/{y} tile scheme as the radar layer.
  const CLOUD_TILE_URL =
    "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/goes-ir-4km-900913/{z}/{x}/{y}.png";

  // GOES GLM lightning (via our Worker — see /api/glm/* in src/index.js).
  // Flash extent density: how many flashes hit each ~10 km cell in the last
  // 5 minutes, republished every minute. It's *total* lightning (in-cloud as
  // well as cloud-to-ground) seen optically from orbit, so it's an overlay on
  // top of the radar rather than a radar product of its own.
  const GLM_PRODUCT = "fed";
  const GLM_TILE_URL = "/api/glm/{layer}/{z}/{x}/{y}.png?t={t}";
  const GLM_FRAMES_URL = "/api/glm/" + GLM_PRODUCT + "/frames";
  // GLM's grid is ~10 km, so RealEarth's pyramid stops here; Leaflet upscales
  // the z7 tile past this rather than showing nothing.
  const GLM_MAX_NATIVE_ZOOM = 7;
  // New frame every minute. Cheap to follow: one frames fetch plus a redraw of
  // ~20 tiles that are 1-4 KB each.
  const GLM_REFRESH_MS = 60 * 1000;
  // How the lightning overlay is drawn on top of the radar. The problem all
  // three answer: RealEarth's native flash-extent-density ramp is blue→green→
  // red, near enough to the reflectivity ramp underneath to be confusable.
  //   "firefly" — redrawn as points of *light*: a hot near-white core with a
  //               warm halo, sized by how much lightning is in the cell and
  //               blended additively. Flat paint (even a loud orange) gets
  //               lost over the yellows and reds of heavy reflectivity, which
  //               is exactly where the lightning is; light can't be, because
  //               screen blending only ever brightens what's beneath it.
  //   "amber"   — the raster flattened to one electric colour, screen-blended.
  //   "native"  — untouched, exactly as NOAA/SSEC publish it.
  const GLM_STYLE = "firefly";
  // "firefly" geometry. The tile is sampled on a GLM_DOT_CELLS × GLM_DOT_CELLS
  // grid — 32 across a 256px z7 tile is about one dot per ~10 km GLM cell, so
  // a dot stands for a real data cell rather than an arbitrary screen texture.
  // Radii are fractions of the cell, so the whole thing scales with the map.
  const GLM_DOT_CELLS = 32;
  const GLM_DOT_MIN_R = 0.1; // faintest cell that still gets a spark
  const GLM_DOT_MAX_R = 0.34; // hottest cell's core (the halo runs wider)
  // …but never bigger than this on screen. Without a ceiling the sparks keep
  // growing with the map and by ~z12 they merge into one wash. Past the cap
  // they hold size and just spread out, which is the honest picture: GLM's
  // grid really is ~10 km no matter how far you zoom in.
  const GLM_DOT_CAP_PX = 7;
  // How far the glow reaches past the core. This is what makes it read as a
  // light source rather than a filled circle.
  const GLM_GLOW_MULT = 2.6;
  const GLM_CORE_COLOR = "rgba(255, 253, 235, 0.98)"; // hot centre
  const GLM_GLOW_COLOR = "255, 196, 92"; // warm falloff (rgb triplet)
  // Must stay in step with the .glm-tiles filter in styles.css — the on-screen
  // layer uses that one, the shared image uses this one.
  const GLM_CANVAS_FILTER =
    "brightness(0) invert(83%) sepia(72%) saturate(1200%) hue-rotate(358deg) brightness(105%)";
  const GLM_ATTRIBUTION =
    'Lightning: <a href="https://www.nesdis.noaa.gov/our-satellites/currently-flying/goes-east-west/geostationary-lightning-mapper-glm">NOAA GOES GLM</a> via <a href="https://realearth.ssec.wisc.edu/">SSEC RealEarth</a>';

  // MRMS (via our Worker). The tile template carries {layer} (which MRMS
  // product — see RADAR_PRODUCTS' mrmsLayer) and {t} (the frame time both the
  // live layer and the loop pin to — identical URLs => Cache Storage hits).
  const MRMS_TILE_URL = "/api/mrms/{layer}/{z}/{x}/{y}.png?t={t}";
  // v2: v1 could hold entries with an unparseable ?t= that the old eviction
  // predicate never removed (see evictTileCache). Renaming starts them clean.
  const MRMS_CACHE_NAME = "mrms-tiles-v2";

  // Single radar sites (also via our Worker). Same timestamped-tile contract as
  // MRMS, but the URL carries which radar as well as which product.
  const SITE_TILE_URL = "/api/site/{site}/{product}/{z}/{x}/{y}.png?t={t}";
  const SITES_URL = "/radar-sites.json";
  const SITE_LEGEND_URL = (product) => "/api/legend/" + product + ".png";
  // Shape gate for a persisted site selection ("site:kmob:sr_bref"). This runs
  // before the site table has loaded, so it only proves the string is *safe* —
  // that the site really exists is checked once the table arrives.
  const SITE_PRODUCT_ID_RE = /^site:([kpt][a-z0-9]{3}):([a-z0-9_]{4,7})$/;
  // Products each radar type carries (see MRMS/SITE_PRODUCTS in src/index.js).
  // type: 0 = WSR-88D (NEXRAD), 1 = TDWR.
  const SITE_PRODUCTS = {
    sr_bref: {
      label: "Base Reflectivity",
      desc: "Super-res precipitation intensity",
      type: 0,
    },
    sr_bvel: {
      label: "Base Velocity",
      desc: "Radial motion — reveals rotation",
      type: 0,
    },
    bdhc: {
      label: "Hydrometeor Type",
      desc: "Dual-pol rain / snow / hail classification",
      type: 0,
    },
    bdsa: {
      label: "Storm Total Precip",
      desc: "Dual-pol accumulation (totals, not motion)",
      type: 0,
    },
    boha: {
      label: "1-Hour Accumulation",
      desc: "Surface rainfall, past hour (totals, not motion)",
      type: 0,
    },
    bref1: { label: "Base Reflectivity", desc: "TDWR precipitation intensity", type: 1 },
    brefl: { label: "Long-Range Reflectivity", desc: "TDWR wide-area view", type: 1 },
    bvel: { label: "Base Velocity", desc: "TDWR radial motion", type: 1 },
  };
  // Opened first when a site is picked. bref1 only spans ~1°, so TDWR defaults
  // to the long-range product.
  const SITE_DEFAULT_PRODUCT = { 0: "sr_bref", 1: "brefl" };
  // Usable range, for the coverage ring and the out-of-range hint. TDWR is a
  // terminal-area radar; its long-range product reaches further than the rest.
  const SITE_RANGE_KM = { 0: 230, 1: 90 };
  const SITE_RANGE_KM_BY_PRODUCT = { brefl: 180 };
  // Markers rendered while picking: viewport-culled, then capped. Keeps the
  // zoomed-out map readable and bounds the work per pan.
  const SITE_MARKER_MAX = 80;
  // All 4 MRMS layers (conus_bref_qcd, conus_cref_qcd, conus_pcpn_typ,
  // conus_neet_v18) cover the lower 48 only. Outside this box (Alaska, Hawaii,
  // Puerto Rico, …) an MRMS-backed product silently falls back to the
  // corresponding IEM product it replaced, which had OCONUS coverage.
  // Generous bounds — a false "inside" just shows empty MRMS, fine over ocean.
  const CONUS_BOUNDS = { south: 22, west: -127, north: 51, east: -65 };
  // MRMS-backed product id -> off-CONUS fallback product id.
  const MRMS_FALLBACK = {
    mrms: "base",
    composite: "compositeIem",
    ptype: "ptypeIem",
    eet: "eetIem",
  };

  const DEFAULT_VIEW = { lat: 39.5, lon: -98.35, zoom: 4 }; // continental US
  const LOCATED_ZOOM = 9;
  const REFRESH_MS = 5 * 60 * 1000; // auto-refresh radar every 5 minutes
  // Returning to the app (tab/window regains focus) refreshes immediately
  // only if it's been at least this long since the last refresh — a quick
  // glance away and back shouldn't force a re-fetch.
  const STALE_REFRESH_MS = 2 * 60 * 1000;
  const STORE_KEY = "radar.lastLocation";
  const PRODUCT_STORE_KEY = "radar.product";
  const SHARE_URL = "https://bendar.app";
  const SHARE_TEXT = "Live weather radar — " + SHARE_URL;

  // Radar loop: 2 hours of frames at the composites' native 5-minute spacing
  // (24 frames), advanced roughly twice a second. IEM composites lag real time
  // by a few minutes, so we end the loop one step back from "now" to avoid
  // requesting a blank frame.
  const LOOP_HOURS = 2;
  const LOOP_STEP_MIN = 5;
  const LOOP_FRAME_COUNT = (LOOP_HOURS * 60) / LOOP_STEP_MIN; // 24
  const LOOP_LAG_MIN = 5;
  // Frames don't all have to load before the loop plays. They arrive in dyadic
  // "waves": every 8th frame first — a coarse, wide-spaced loop you can watch
  // almost immediately — then every 4th, 2nd, and finally all 24, each wave
  // doubling the temporal resolution down to the native 5-minute spacing. So
  // you see motion after ~3 frames instead of waiting on all 24.
  const LOOP_STRIDES = [8, 4, 2, 1];
  // ms of playback per 5 minutes of real time. Each frame holds for this times
  // its spacing (stride), so the loop advances at a constant real-time rate no
  // matter how coarse the current wave is — the picture refines without the
  // animation speeding up or slowing down. At full 5-min resolution: 200 ms.
  const LOOP_PLAY_MS = 200;
  const LOOP_END_DWELL_MS = 1200; // linger on the newest frame before looping
  const LOOP_SAFETY_MS = 25000; // play the coarse wave even if a frame stalls
  // Keep cached tiles a little past the loop window, then evict.
  const MRMS_CACHE_WINDOW_MS = (LOOP_HOURS * 60 + 20) * 60 * 1000;
  // …and cap the total, because the time window alone doesn't bound size. With
  // 201 radar sites x 8 products, sweeping through a few sites would otherwise
  // pile up hundreds of MB inside the 2h window — enough for iOS Safari to
  // evict our whole bucket. One full loop is ~288 tiles at ~30 KB, so 800
  // entries (~23 MB) holds the active loop plus live browsing.
  const TILE_CACHE_MAX_ENTRIES = 800;
  // Trim below the cap so a sweep isn't re-triggered by the very next tile.
  const TILE_CACHE_TRIM_TO = 600;
  // Advisory backstop: if the whole origin is using more than this (or most of
  // its quota), trim harder. navigator.storage.estimate() is approximate and
  // covers more than our cache, so it only ever tightens, never relaxes.
  const TILE_CACHE_MAX_BYTES = 60 * 1024 * 1024;

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
    lightningBtn: document.getElementById("lightningBtn"),
    loopBtn: document.getElementById("loopBtn"),
    shareBtn: document.getElementById("shareBtn"),
    settingsBtn: document.getElementById("settingsBtn"),
    settingsSheet: document.getElementById("settingsSheet"),
    settingsClose: document.getElementById("settingsClose"),
    radarProductOptions: document.getElementById("radarProductOptions"),
    siteProductOptions: document.getElementById("siteProductOptions"),
    sitePickBtn: document.getElementById("sitePickBtn"),
    sitePickDesc: document.getElementById("sitePickDesc"),
    sitePickBar: document.getElementById("sitePickBar"),
    sitePickMsg: document.getElementById("sitePickMsg"),
    sitePickAction: document.getElementById("sitePickAction"),
    sitePickCancel: document.getElementById("sitePickCancel"),
    legendRow: document.getElementById("legendRow"),
    legendImg: document.getElementById("legendImg"),
    installBtn: document.getElementById("installBtn"),
    installSheet: document.getElementById("installSheet"),
    installClose: document.getElementById("installClose"),
    infoBtn: document.getElementById("infoBtn"),
    infoSheet: document.getElementById("infoSheet"),
    infoClose: document.getElementById("infoClose"),
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
  let lightningLayer; // GOES GLM lightning overlay (optional)
  let lightningTimer; // 1-minute frame follower, only while the overlay is on
  let meMarker;
  let refreshTimer;
  let lastRefreshAt = 0; // Date.now() of the last actual radar refresh

  // Single-site radar state. Declared before radarProductId because
  // loadProductId() resolves a stored "site:…" id through siteProduct(), which
  // reads siteData/siteProductCache — if they were still in their temporal dead
  // zone the throw would be swallowed and a saved site would silently reset.
  let siteData = null; // { site: [lat, lon, name, type] } once loaded
  let siteLoading = null; // in-flight fetch, so concurrent callers share one
  const siteProductCache = new Map(); // composite id -> synthesized product
  let sitePicking = false; // true while the map is in "tap a radar" mode
  let siteMarkerLayer = null; // L.layerGroup of pickable markers
  let selectedSiteMarker = null; // persistent marker for the chosen radar
  let siteRangeRing = null; // its coverage circle
  let siteMarkerTimer = null; // debounce for re-rendering markers on pan
  // Composite id of a site whose frame list came back empty (radar offline).
  // Drives a temporary fallback to the mosaic without touching the user's
  // saved choice, so the site returns on its own when the radar does.
  let siteOutage = null;
  let siteRangeHintFor = null; // dedupes the out-of-range prompt

  let radarProductId = loadProductId(); // RADAR_PRODUCTS key or "site:…" id
  let displayedProductId = null; // product the live radarLayer is built for

  // Radar-loop state.
  let loopOn = false;
  let loopPlaying = false;
  let loopReady = false; // true once the first (coarse) wave is ready to play
  let loopTimer;
  let loopSafety; // fallback timer so a stalled frame can't hang the first wave
  let loopLayers = []; // one WMS tile layer per frame, parallel to loopFrames
  let loopFrames = []; // array of Date objects, oldest -> newest
  let loopIndex = 0;
  // Progressive (dyadic) preload state.
  let loopWaves = []; // arrays of frame indices, coarsest -> finest
  let frameWave = []; // frame index -> which wave it belongs to
  let loopWaveAdded = []; // wave -> have its layers been added to the map yet?
  let loopWavePromoted = []; // wave -> has it been folded into the animation?
  let loopLoadedSet = new Set(); // frame indices whose tiles have finished
  let loopActive = []; // sorted frame indices currently in the animation
  let loopStride = LOOP_STRIDES[0]; // spacing (in frames) of the active set

  // Canonical frame times, one list per tile-source key (Date[], oldest ->
  // newest), memoized with a short TTL. Both the live view and the loop snap
  // to these so their tile URLs — and therefore their cache entries — line up
  // exactly. Keyed per source because every product updates on its own
  // schedule; MRMS keys are bare ("base"), site keys carry an underscore
  // ("kmob_sr_bref"), so the two can never collide.
  const framesByKey = new Map(); // key -> { frames: Date[], at: ms }
  const MRMS_FRAMES_TTL_MS = 60 * 1000;

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

    radarLayer = buildRadarLayer().addTo(map);
    displayedProductId = effectiveProductId();
    lastRefreshAt = Date.now();
    if (tileSource(currentProduct())) primeLive();
    syncProductUI();
    syncLoopAvailability();

    // Re-evaluate the CONUS fallback (or the site range hint) whenever the view
    // settles somewhere new, and re-cull the pickable radar markers.
    map.on("moveend", () => {
      onRadarViewChanged();
      if (sitePicking) {
        clearTimeout(siteMarkerTimer);
        siteMarkerTimer = setTimeout(renderSiteMarkers, 150);
      }
    });

    // A restored single-site selection needs the site table before its marker,
    // ring and real name can be resolved. Only fetched when one is in play.
    if (siteProduct(radarProductId)) {
      loadSiteData().then(verifyStoredSite).catch(() => {
        /* leave the tiles running; only the name/ring are missing */
      });
    }

    if (saved) {
      setMeMarker(saved.lat, saved.lon);
      loadWeather(saved.lat, saved.lon);
    }

    setStatus(
      siteProduct(radarProductId) ? statusForCurrentProduct() : "Radar loaded."
    );
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

  // --- Radar products ------------------------------------------------------

  // Resolve a product id to its config. Ids are either a RADAR_PRODUCTS key
  // ("mrms") or a single-site composite ("site:kmob:sr_bref"). `strict` returns
  // null for an unknown id instead of falling back to the default.
  function productById(id, strict) {
    const p = RADAR_PRODUCTS[id] || siteProduct(id);
    if (p) return p;
    return strict ? null : RADAR_PRODUCTS[DEFAULT_PRODUCT];
  }

  // The product the user picked (persisted). Distinct from the *effective*
  // product below, which may differ when a product auto-falls-back.
  function selectedProduct() {
    return productById(radarProductId);
  }

  // The product actually shown. All the layer/loop/refresh code reads this, so
  // both fallbacks (off-CONUS mosaic, offline site) flow through everywhere by
  // changing this one function.
  function currentProduct() {
    return productById(effectiveProductId());
  }

  function effectiveProductId() {
    // A site whose radar isn't reporting shows the mosaic instead — an offline
    // radar renders identically to clear skies, so this one is a correctness
    // fix, not a preference. radarProductId is left alone, so the site comes
    // back by itself once the radar does.
    if (siteOutage && siteOutage === radarProductId) return DEFAULT_PRODUCT;
    const p = RADAR_PRODUCTS[radarProductId];
    // Site products miss this lookup, so they never off-CONUS-fallback —
    // correct, since a single radar is inherently regional (and Alaska,
    // Hawaii and Puerto Rico sites are first-class here).
    if (p && p.mrmsLayer && map) {
      const c = map.getCenter();
      if (!inConus(c.lat, c.lng)) return MRMS_FALLBACK[radarProductId] || radarProductId;
    }
    return radarProductId;
  }

  // Build (and memoize) the product config for a "site:{site}:{product}" id.
  // currentProduct() runs on every moveend, every opacity tick and 20+ times
  // inside buildLoopLayers, so this must not allocate on the hot path.
  function siteProduct(id) {
    if (typeof id !== "string") return null;
    const cached = siteProductCache.get(id);
    if (cached) return cached;
    const m = SITE_PRODUCT_ID_RE.exec(id);
    if (!m) return null;
    const site = m[1];
    const product = m[2];
    const meta = SITE_PRODUCTS[product];
    if (!meta) return null;

    // The site table may not have loaded yet; fall back to the bare id so the
    // label is still sensible, and let syncSiteLabels() fill it in later.
    const row = siteData && siteData[site];
    const name = row ? row[2] : site.toUpperCase();
    const built = {
      id: id,
      label: name + " (" + site.toUpperCase() + ") — " + meta.label,
      site: { site: site, product: product, name: name, type: row ? row[3] : meta.type },
      attribution:
        'Radar: <a href="https://www.weather.gov/">NWS ' +
        esc(site.toUpperCase()) +
        "</a> via NCEP",
      loop: true,
    };
    siteProductCache.set(id, built);
    return built;
  }

  // Everything that uses the timestamped, Cache-Storage-backed tile pipeline
  // resolves through here, so MRMS mosaics and single sites share one code
  // path. Returns null for the plain IEM tile-cache products.
  function tileSource(p) {
    if (p.mrmsLayer) {
      return {
        key: p.mrmsLayer,
        url: MRMS_TILE_URL,
        vars: { layer: p.mrmsLayer },
        frames: "/api/mrms/" + p.mrmsLayer + "/frames",
      };
    }
    if (p.site) {
      return {
        key: p.site.site + "_" + p.site.product,
        url: SITE_TILE_URL,
        vars: { site: p.site.site, product: p.site.product },
        frames: "/api/site/" + p.site.site + "/" + p.site.product + "/frames",
      };
    }
    return null;
  }

  function inConus(lat, lon) {
    return (
      lat >= CONUS_BOUNDS.south &&
      lat <= CONUS_BOUNDS.north &&
      lon >= CONUS_BOUNDS.west &&
      lon <= CONUS_BOUNDS.east
    );
  }

  // Whether we're currently substituting the off-CONUS fallback for the
  // selected MRMS-backed product.
  function mrmsFellBack() {
    const p = RADAR_PRODUCTS[radarProductId];
    return !!(p && p.mrmsLayer) && effectiveProductId() !== radarProductId;
  }

  // Whether the selected radar site is offline and we're showing the mosaic.
  function siteFellBack() {
    return !!siteOutage && siteOutage === radarProductId;
  }

  // Map settled somewhere new: if that flipped the effective product (crossed
  // the CONUS edge under an MRMS product), swap the live layer to match. The
  // loop manages its own layers, so skip while it's running.
  function onRadarViewChanged() {
    if (loopOn) return;
    // A site's effective id doesn't change as you pan, so this has to come
    // before the early return below or the range check would never run.
    if (currentProduct().site) {
      syncSiteRangeHint();
      return;
    }
    if (effectiveProductId() === displayedProductId) return;
    rebuildLiveLayer();
  }

  function rebuildLiveLayer() {
    const next = buildRadarLayer();
    if (radarLayer) map.removeLayer(radarLayer);
    radarLayer = next.addTo(map);
    displayedProductId = effectiveProductId();
    if (tileSource(currentProduct())) primeLive();
    syncLoopAvailability();
    syncSiteMarker();
    syncLegend();
    setStatus(statusForCurrentProduct());
  }

  // One place for "what are we actually showing", since several call sites need
  // to explain a substitution when one is in effect. `phrase` shapes the normal
  // case ("Showing X." / "X loaded." / "Showing live X.").
  function statusForCurrentProduct(phrase) {
    const shown = currentProduct().label;
    if (siteFellBack()) {
      const picked = siteProduct(radarProductId);
      const who = picked
        ? picked.site.name + " (" + picked.site.site.toUpperCase() + ")"
        : "That radar";
      return who + " isn't reporting — showing " + shown + ".";
    }
    if (mrmsFellBack()) return "Outside MRMS coverage — showing " + shown + ".";
    if (phrase === "loaded") return shown + " loaded.";
    if (phrase === "live") return "Showing live " + shown + ".";
    return "Showing " + shown + ".";
  }

  function radarTileUrl(product, bustCache) {
    const p = product || currentProduct();
    let url = IEM_TILE_ROOT + p.layer + "/{z}/{x}/{y}.png";
    if (bustCache) url += "?_=" + Date.now();
    return url;
  }

  function buildRadarLayer() {
    const p = currentProduct();
    const src = tileSource(p);
    if (src) {
      // Pin to the newest canonical frame. Before the frame list has loaded
      // there's no canonical time to use, so send an empty t= — the Worker
      // treats that as "latest" rather than rendering a blank frame for a
      // clock estimate that never matches. primeLive() pins the exact time as
      // soon as the list arrives.
      const frame = liveFrame(src.key);
      return cachedTileLayer(
        src.url,
        Object.assign({}, src.vars, {
          t: frame ? isoUTC(frame) : "",
          opacity: sliderToOpacity(els.opacity.value),
          attribution: p.attribution,
          zIndex: 5,
          maxZoom: 15,
          crossOrigin: "anonymous",
        })
      );
    }
    return L.tileLayer(radarTileUrl(p, false), {
      opacity: sliderToOpacity(els.opacity.value),
      attribution: p.attribution,
      zIndex: 5,
      maxZoom: 15,
      crossOrigin: "anonymous",
    });
  }

  // --- MRMS: timestamped tiles + on-device cache ---------------------------

  // A Leaflet tile layer that reads/writes the Cache Storage API. A tile the
  // live view already fetched is reused instantly by the loop (and survives a
  // reload) instead of hitting the network again. Where Cache Storage isn't
  // usable (e.g. private mode) it degrades to normal tile loading. Built lazily
  // so it never touches L before Leaflet has loaded.
  let CachedTileLayerClass = null;
  function cachedTileLayer(url, opts) {
    if (!CachedTileLayerClass) {
      CachedTileLayerClass = L.TileLayer.extend({
        createTile(coords, done) {
          const tile = document.createElement("img");
          tile.setAttribute("role", "presentation");
          tile.alt = "";
          if (this.options.crossOrigin) tile.crossOrigin = this.options.crossOrigin;
          const src = this.getTileUrl(coords);
          loadCachedTile(src).then((objectUrl) => {
            if (objectUrl) {
              tile.onload = () => {
                URL.revokeObjectURL(objectUrl);
                done(null, tile);
              };
              tile.onerror = () => {
                URL.revokeObjectURL(objectUrl);
                done(new Error("tile error"), tile);
              };
              tile.src = objectUrl;
            } else {
              tile.onload = () => done(null, tile);
              tile.onerror = () => done(new Error("tile error"), tile);
              tile.src = src;
            }
          });
          return tile;
        },
      });
    }
    return new CachedTileLayerClass(url, opts);
  }

  // Object URL for `url`, served from Cache Storage when present and
  // fetched+stored when not. Resolves null if caching isn't usable, so the
  // caller falls back to a plain <img src>.
  async function loadCachedTile(url) {
    if (!("caches" in window)) return null;
    try {
      const cache = await caches.open(MRMS_CACHE_NAME);
      let resp = await cache.match(url);
      if (!resp) {
        resp = await fetch(url, { cache: "default" });
        if (resp && resp.ok) await cache.put(url, resp.clone());
      }
      if (!resp || !resp.ok) return null;
      return URL.createObjectURL(await resp.blob());
    } catch (_) {
      return null;
    }
  }

  // The frame time baked into a cached tile URL, or NaN if it has none.
  function cachedTileFrameMs(url) {
    try {
      const t = new URL(url).searchParams.get("t");
      return t ? Date.parse(t) : NaN;
    } catch (_) {
      return NaN;
    }
  }

  // Keep the tile cache bounded: first drop frames older than the loop window,
  // then — because the window alone doesn't bound *size* — cap the entry count.
  // Overflow is shed from the products the user isn't looking at, oldest frame
  // first, so the active product's loop (the whole point of caching) survives.
  async function evictTileCache() {
    if (!("caches" in window)) return;
    try {
      const cache = await caches.open(MRMS_CACHE_NAME);
      const cutoff = Date.now() - MRMS_CACHE_WINDOW_MS;
      const reqs = await cache.keys();

      // Pass 1: age out. An entry with no parseable ?t= can't be reasoned
      // about, so drop it too rather than let it linger forever.
      const live = [];
      const aged = [];
      for (const req of reqs) {
        const ms = cachedTileFrameMs(req.url);
        if (!Number.isFinite(ms) || ms < cutoff) aged.push(req);
        else live.push({ req: req, ms: ms });
      }
      await Promise.all(aged.map((req) => cache.delete(req)));

      // Pass 2: cap the total.
      if (live.length <= TILE_CACHE_MAX_ENTRIES) return;
      let trimTo = TILE_CACHE_TRIM_TO;
      if (await storageUnderPressure()) trimTo = Math.floor(trimTo / 2);

      const src = tileSource(currentProduct());
      const activePrefix = src ? tileUrlPrefix(src) : null;
      live.sort((a, b) => {
        // Non-active products go first…
        const aActive = activePrefix && a.req.url.indexOf(activePrefix) !== -1;
        const bActive = activePrefix && b.req.url.indexOf(activePrefix) !== -1;
        if (aActive !== bActive) return aActive ? 1 : -1;
        // …then oldest frame first within each group.
        return a.ms - b.ms;
      });
      const doomed = live.slice(0, live.length - trimTo);
      await Promise.all(doomed.map((e) => cache.delete(e.req)));
    } catch (_) {
      /* ignore — caching is best-effort */
    }
  }

  // The path prefix every tile of one product shares, used to tell the active
  // product's cache entries from the rest.
  function tileUrlPrefix(src) {
    return src.vars.site
      ? "/api/site/" + src.vars.site + "/" + src.vars.product + "/"
      : "/api/mrms/" + src.vars.layer + "/";
  }

  // Advisory: is the origin's storage close to full? Only ever tightens the
  // trim target — estimate() is approximate and covers more than our cache.
  async function storageUnderPressure() {
    try {
      if (!navigator.storage || !navigator.storage.estimate) return false;
      const est = await navigator.storage.estimate();
      if (!est || !est.usage) return false;
      if (est.usage > TILE_CACHE_MAX_BYTES) return true;
      return !!est.quota && est.usage / est.quota > 0.6;
    } catch (_) {
      return false;
    }
  }

  // Fetch + memoize one tile source's canonical frame list
  // (Date[], oldest -> newest).
  // `maxAgeMs` overrides how stale a memoized list may be. The lightning
  // overlay polls on the same 60s beat as the default TTL, so on the default
  // it would coin-flip between a real fetch and the cached list and sit a
  // frame behind; it passes 0 to always re-ask.
  async function ensureFrames(src, maxAgeMs = MRMS_FRAMES_TTL_MS) {
    const entry = framesByKey.get(src.key);
    if (entry && entry.frames.length && Date.now() - entry.at < maxAgeMs) {
      return entry.frames;
    }
    try {
      const resp = await fetch(src.frames, { cache: "no-store" });
      const data = await resp.json();
      const frames = (data.frames || [])
        .map((s) => new Date(s))
        .filter((d) => !isNaN(d.getTime()))
        .sort((a, b) => a - b);
      if (frames.length) {
        framesByKey.set(src.key, { frames: frames, at: Date.now() });
      }
    } catch (_) {
      /* keep any previous list */
    }
    return (framesByKey.get(src.key) || {}).frames || [];
  }

  // Nearest canonical frame to a target time for one source; null before that
  // source's list has loaded.
  function snapFrame(key, targetMs) {
    const frames = (framesByKey.get(key) || {}).frames || [];
    if (!frames.length) return null;
    let best = frames[0];
    let bestDist = Infinity;
    for (const f of frames) {
      const d = Math.abs(f.getTime() - targetMs);
      if (d < bestDist) {
        bestDist = d;
        best = f;
      }
    }
    return best;
  }

  // The frame the live view should show: newest canonical frame at/under the
  // lag horizon. Null until the list loads — callers send an empty t= rather
  // than guessing a time the server has no frame for.
  function liveFrame(key) {
    return snapFrame(key, Date.now() - LOOP_LAG_MIN * 60 * 1000);
  }

  // Load the frame list, then repoint the live layer at the exact canonical
  // frame (so its tiles match the loop's) and sweep the cache.
  async function primeLive() {
    const p = currentProduct();
    const src = tileSource(p);
    if (!src) return;
    const frames = await ensureFrames(src);

    // No frames for a site means the radar isn't reporting. Fall back to the
    // mosaic (see effectiveProductId) rather than showing an empty map that
    // looks exactly like clear skies.
    if (p.site && !frames.length) {
      if (siteOutage !== radarProductId) {
        siteOutage = radarProductId;
        rebuildLiveLayer();
      }
      return;
    }
    if (p.site && frames.length && siteOutage === radarProductId) {
      siteOutage = null; // radar came back
      rebuildLiveLayer();
      return;
    }

    if (currentProduct().id === p.id && radarLayer && !loopOn) {
      // redraw() (not setUrl) — the URL *template* is unchanged, only options.t
      // is, and Leaflet's setUrl skips the redraw when the template matches.
      const frame = liveFrame(src.key);
      radarLayer.options.t = frame ? isoUTC(frame) : "";
      radarLayer.redraw();
    }
    evictTileCache();
  }

  // --- Single radar sites --------------------------------------------------

  // Fetch the site table once and memoize it (also de-dupes concurrent calls).
  // ~7 KB of {site: [lat, lon, name, type]}, only fetched when the user
  // actually reaches for a site — a cold start on a mosaic never touches it.
  function loadSiteData() {
    if (siteData) return Promise.resolve(siteData);
    if (!siteLoading) {
      siteLoading = fetch(SITES_URL)
        .then((res) => {
          if (!res.ok) throw new Error("radar-sites " + res.status);
          return res.json();
        })
        .then((data) => {
          siteData = data;
          // Labels built before the table arrived used the bare site id.
          siteProductCache.clear();
          return data;
        })
        .catch((err) => {
          siteLoading = null; // allow a retry on the next attempt
          throw err;
        });
    }
    return siteLoading;
  }

  // Great-circle distance in km.
  function distanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLon = (lon2 - lon1) * rad;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // Closest radar to a point. `type` restricts to WSR-88D (0) or TDWR (1).
  // A linear scan of ~200 entries is microseconds; no spatial index needed.
  function nearestSite(lat, lon, type) {
    if (!siteData) return null;
    let bestId = null;
    let bestKm = Infinity;
    for (const id in siteData) {
      const row = siteData[id];
      if (type != null && row[3] !== type) continue;
      const km = distanceKm(lat, lon, row[0], row[1]);
      if (km < bestKm) {
        bestKm = km;
        bestId = id;
      }
    }
    return bestId ? { id: bestId, km: bestKm } : null;
  }

  // Usable range of the selected radar, for the coverage ring and range hint.
  function siteRangeKm(site) {
    return SITE_RANGE_KM_BY_PRODUCT[site.product] || SITE_RANGE_KM[site.type] || 230;
  }

  function siteProductIdFor(site, product) {
    return "site:" + site + ":" + product;
  }

  // Products this radar type carries, in display order.
  function productsForSiteType(type) {
    return Object.keys(SITE_PRODUCTS).filter((k) => SITE_PRODUCTS[k].type === type);
  }

  // Once the table is available, make sure a restored selection names a real
  // radar; drop back to the mosaic if it doesn't (decommissioned site, or a
  // hand-edited localStorage value that passed the shape gate).
  function verifyStoredSite() {
    const p = siteProduct(radarProductId);
    if (!p) return;
    if (siteData && !siteData[p.site.site]) {
      setRadarProduct(DEFAULT_PRODUCT);
      setStatus("That radar site is no longer available — showing the mosaic.", true);
      return;
    }
    // Rebuild the label/type now that the real name is known.
    rebuildLiveLayer();
    syncSiteProductUI();
  }

  // Render the product list for the selected radar. Unlike the mosaic list in
  // index.html this has to be dynamic — which products exist depends on whether
  // the radar is a WSR-88D or a TDWR.
  function syncSiteProductUI() {
    const group = els.siteProductOptions;
    if (!group) return;
    const p = siteProduct(radarProductId);
    if (!p) {
      group.classList.add("hidden");
      group.innerHTML = "";
      if (els.sitePickDesc) {
        els.sitePickDesc.textContent = "Tap one NEXRAD or TDWR radar on the map";
      }
      return;
    }

    const site = p.site;
    if (els.sitePickDesc) {
      els.sitePickDesc.textContent =
        site.name + " (" + site.site.toUpperCase() + ") · tap to change";
    }

    group.innerHTML = "";
    productsForSiteType(site.type).forEach((key) => {
      const meta = SITE_PRODUCTS[key];
      const id = siteProductIdFor(site.site, key);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "settings-option";
      btn.setAttribute("role", "radio");
      btn.setAttribute("data-product", id);
      btn.setAttribute("aria-checked", id === radarProductId ? "true" : "false");

      const text = document.createElement("span");
      text.className = "settings-option-text";
      const title = document.createElement("span");
      title.className = "settings-option-title";
      title.textContent = meta.label;
      const desc = document.createElement("span");
      desc.className = "settings-option-desc";
      desc.textContent = meta.desc;
      text.appendChild(title);
      text.appendChild(desc);

      const check = document.createElement("span");
      check.className = "settings-check";
      check.setAttribute("aria-hidden", "true");
      check.textContent = "✓";

      btn.appendChild(text);
      btn.appendChild(check);
      group.appendChild(btn);
    });
    group.classList.remove("hidden");
  }

  // The persistent marker + coverage ring for the selected radar. The ring is
  // the thing that makes "why is it blank over there" obvious before you have
  // to ask, and it anchors the (radial) velocity products to their origin.
  function syncSiteMarker() {
    const p = siteProduct(radarProductId);
    const row = p && siteData && siteData[p.site.site];
    if (!p || !row || !map) {
      if (selectedSiteMarker) {
        map.removeLayer(selectedSiteMarker);
        selectedSiteMarker = null;
      }
      if (siteRangeRing) {
        map.removeLayer(siteRangeRing);
        siteRangeRing = null;
      }
      return;
    }

    const latlng = [row[0], row[1]];
    const radius = siteRangeKm({ product: p.site.product, type: row[3] }) * 1000;
    if (!selectedSiteMarker) {
      selectedSiteMarker = L.marker(latlng, {
        icon: siteIcon(row[3], true),
        keyboard: false,
        interactive: false,
        zIndexOffset: 400,
      }).addTo(map);
    } else {
      selectedSiteMarker.setLatLng(latlng);
      selectedSiteMarker.setIcon(siteIcon(row[3], true));
    }
    if (!siteRangeRing) {
      siteRangeRing = L.circle(latlng, {
        radius: radius,
        interactive: false,
        fill: false,
        color: "#3b82f6",
        weight: 1,
        opacity: 0.35,
        dashArray: "4 6",
      }).addTo(map);
    } else {
      siteRangeRing.setLatLng(latlng);
      siteRangeRing.setRadius(radius);
    }
  }

  // Four shared divIcons — Leaflet calls createIcon() per marker, so reusing
  // instances keeps 200 markers from meaning 200 allocations.
  const siteIcons = {};
  function siteIcon(type, selected) {
    const key = (type === 1 ? "tdwr" : "wsr") + (selected ? "-sel" : "");
    if (!siteIcons[key]) {
      siteIcons[key] = L.divIcon({
        className: "",
        html:
          '<div class="site-marker' +
          (type === 1 ? " tdwr" : "") +
          (selected ? " selected" : "") +
          '"></div>',
        iconSize: [12, 12],
        iconAnchor: [6, 6],
      });
    }
    return siteIcons[key];
  }

  function enterSitePicking() {
    closeSettingsSheet();
    loadSiteData()
      .then(() => {
        sitePicking = true;
        siteRangeHintFor = null;
        renderSiteMarkers();
        showSitePickBar("Tap a radar site on the map", null);
        setStatus("Choose a radar site.");
      })
      .catch(() => setStatus("Couldn't load the radar site list.", true));
  }

  function exitSitePicking() {
    sitePicking = false;
    clearTimeout(siteMarkerTimer);
    if (siteMarkerLayer) {
      map.removeLayer(siteMarkerLayer);
      siteMarkerLayer = null;
    }
    hideSitePickBar();
  }

  // Markers for the radars in view. Culled to the viewport and capped, so a
  // zoomed-out map stays readable and each pan does a bounded amount of work.
  function renderSiteMarkers() {
    if (!sitePicking || !siteData || !map) return;
    if (siteMarkerLayer) map.removeLayer(siteMarkerLayer);
    siteMarkerLayer = L.layerGroup();

    const bounds = map.getBounds().pad(0.25);
    const c = map.getCenter();
    const visible = [];
    for (const id in siteData) {
      const row = siteData[id];
      if (!bounds.contains([row[0], row[1]])) continue;
      visible.push({ id: id, row: row, km: distanceKm(c.lat, c.lng, row[0], row[1]) });
    }
    visible.sort((a, b) => a.km - b.km);

    const selected = siteProduct(radarProductId);
    visible.slice(0, SITE_MARKER_MAX).forEach((s) => {
      const isSel = selected && selected.site.site === s.id;
      const marker = L.marker([s.row[0], s.row[1]], {
        icon: siteIcon(s.row[3], isSel),
        keyboard: false,
        title: s.row[2] + " (" + s.id.toUpperCase() + ")",
      });
      marker.on("click", () => onSiteMarkerTap(s.id));
      siteMarkerLayer.addLayer(marker);
    });
    siteMarkerLayer.addTo(map);
  }

  function onSiteMarkerTap(siteId) {
    const row = siteData && siteData[siteId];
    if (!row) return;
    exitSitePicking();

    // Keep the product the user was already looking at when the new radar also
    // has it — someone comparing velocity across adjacent radars shouldn't get
    // bounced back to reflectivity.
    const prev = siteProduct(radarProductId);
    const available = productsForSiteType(row[3]);
    const product =
      prev && available.indexOf(prev.site.product) !== -1
        ? prev.site.product
        : SITE_DEFAULT_PRODUCT[row[3]];
    setRadarProduct(siteProductIdFor(siteId, product));
  }

  // Panning outside the radar's range leaves the map blank (the tiles are
  // valid, just empty). Say so and offer the nearest radar — but never switch
  // automatically: the user picked *this* radar, and swapping under them would
  // invalidate the loop and rewrite their saved choice.
  function syncSiteRangeHint() {
    if (sitePicking) return;
    const p = siteProduct(radarProductId);
    if (!p || !siteData || !map || siteFellBack()) {
      if (siteRangeHintFor) {
        siteRangeHintFor = null;
        hideSitePickBar();
      }
      return;
    }
    const row = siteData[p.site.site];
    if (!row) return;

    const c = map.getCenter();
    const km = distanceKm(c.lat, c.lng, row[0], row[1]);
    if (km <= siteRangeKm({ product: p.site.product, type: row[3] })) {
      if (siteRangeHintFor) {
        siteRangeHintFor = null;
        hideSitePickBar();
      }
      return;
    }

    const near = nearestSite(c.lat, c.lng, null);
    if (!near || near.id === p.site.site) return;
    if (siteRangeHintFor === near.id) return; // already prompting for this one
    siteRangeHintFor = near.id;

    const nearRow = siteData[near.id];
    showSitePickBar(
      "You're outside " + p.site.name + " (" + p.site.site.toUpperCase() + ") radar range.",
      // Name the destination — a bare "Switch" doesn't say switch to what.
      { label: "Use " + nearRow[2], site: near.id }
    );
  }

  function showSitePickBar(message, action) {
    if (!els.sitePickBar) return;
    els.sitePickMsg.textContent = message;
    if (action) {
      els.sitePickAction.textContent = action.label;
      els.sitePickAction.setAttribute("data-site", action.site);
      els.sitePickAction.classList.remove("hidden");
    } else {
      els.sitePickAction.classList.add("hidden");
      els.sitePickAction.removeAttribute("data-site");
    }
    els.sitePickBar.classList.remove("hidden");
  }

  function hideSitePickBar() {
    if (els.sitePickBar) els.sitePickBar.classList.add("hidden");
  }

  // The colour scale for the current single-site product. Mosaics don't get one.
  function syncLegend() {
    if (!els.legendRow || !els.legendImg) return;
    const p = currentProduct();
    if (!p.site) {
      els.legendRow.classList.add("hidden");
      return;
    }
    const src = SITE_LEGEND_URL(p.site.product);
    // Only touch .src when it actually changes — otherwise the <img> re-decodes
    // and flickers on every product switch.
    if (els.legendImg.getAttribute("data-src") !== src) {
      els.legendImg.setAttribute("data-src", src);
      els.legendImg.src = src;
    }
    els.legendRow.classList.remove("hidden");
  }

  function loadProductId() {
    try {
      const id = localStorage.getItem(PRODUCT_STORE_KEY);
      if (id && RADAR_PRODUCTS[id]) return id;
      // A stored single-site id is only shape-checked here — the site table
      // hasn't loaded yet. That's enough to guarantee the value is *safe* (it
      // can only ever yield a 4-char workspace and an allowlisted product);
      // whether the radar actually exists is checked in verifyStoredSite().
      if (id && siteProduct(id)) return id;
    } catch (_) {
      /* private mode / storage disabled — ignore */
    }
    return DEFAULT_PRODUCT;
  }

  function saveProductId(id) {
    try {
      localStorage.setItem(PRODUCT_STORE_KEY, id);
    } catch (_) {
      /* ignore */
    }
  }

  function syncProductUI() {
    const id = radarProductId; // reflect the user's choice, not the fallback
    [els.radarProductOptions, els.siteProductOptions].forEach((group) => {
      if (!group) return;
      group.querySelectorAll("[data-product]").forEach((btn) => {
        const on = btn.getAttribute("data-product") === id;
        btn.setAttribute("aria-checked", on ? "true" : "false");
      });
    });
  }

  // Loop 2h needs a time-enabled source (MRMS or IEM's time-enabled WMS); every
  // visible product has one, but an off-CONUS MRMS fallback may not (see the
  // hidden …Iem product entries in RADAR_PRODUCTS).
  function syncLoopAvailability() {
    const canLoop = !!currentProduct().loop;
    els.loopBtn.disabled = !canLoop;
    els.loopBtn.setAttribute("aria-disabled", canLoop ? "false" : "true");
    els.loopBtn.title = canLoop
      ? "Animate the last 2 hours"
      : "Loop isn't available for the current radar view";
  }

  function setRadarProduct(id) {
    if (!productById(id, true) || id === radarProductId) {
      closeSettingsSheet();
      return;
    }
    // A new choice clears any outage fallback from the previous one.
    siteOutage = null;
    siteRangeHintFor = null;

    // Tear down an active loop without restoring the old live layer — we rebuild
    // the live layer for the new product below.
    if (loopOn) {
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
    }

    radarProductId = id;
    saveProductId(id);
    syncProductUI();
    syncLoopAvailability();

    const p = currentProduct();
    const next = buildRadarLayer();
    if (radarLayer) map.removeLayer(radarLayer);
    radarLayer = next.addTo(map);
    displayedProductId = effectiveProductId();
    if (tileSource(p)) primeLive();
    syncSiteMarker();
    syncSiteProductUI();
    syncLegend();
    syncSiteRangeHint();
    closeSettingsSheet();
    // p is the effective product, so if the user picked something that fell
    // back, name what's actually on screen rather than what they tapped.
    setStatus(statusForCurrentProduct("loaded"));
  }

  function openSettingsSheet() {
    closeSheet();
    closeInstallSheet();
    closeInfoSheet();
    els.settingsSheet.classList.remove("hidden");
    els.settingsSheet.setAttribute("aria-hidden", "false");
    els.settingsBtn.setAttribute("aria-expanded", "true");
  }

  function closeSettingsSheet() {
    els.settingsSheet.classList.add("hidden");
    els.settingsSheet.setAttribute("aria-hidden", "true");
    els.settingsBtn.setAttribute("aria-expanded", "false");
  }

  function toggleSettingsSheet() {
    if (els.settingsSheet.classList.contains("hidden")) openSettingsSheet();
    else closeSettingsSheet();
  }

  // --- Radar refresh -------------------------------------------------------

  // Re-request the radar tiles by bumping a cache-busting param so we pull the
  // latest frame. Leaflet keeps the old tiles visible until the new ones load,
  // so there's no flash.
  function refreshRadar(userInitiated) {
    if (!radarLayer || loopOn) return; // the loop drives its own frames
    lastRefreshAt = Date.now();
    const p = currentProduct();
    const src = tileSource(p);
    if (src) {
      // Re-resolve the newest canonical frame and repoint the layer at it.
      // Same URL scheme the loop uses, so what we fetch now is a loop cache
      // hit later. (No cache-buster — a given frame's tiles are immutable.)
      ensureFrames(src).then(() => {
        if (loopOn || currentProduct().id !== p.id) return;
        // redraw() (not setUrl) — only options.t changes; see primeLive.
        const frame = liveFrame(src.key);
        radarLayer.options.t = frame ? isoUTC(frame) : "";
        radarLayer.redraw();
        evictTileCache();
      });
    } else {
      radarLayer.setUrl(radarTileUrl(p, true));
    }
    if (userInitiated) {
      els.refreshBtn.classList.add("spin");
      setStatus(p.label + " updated " + timeNow() + ".");
      setTimeout(() => els.refreshBtn.classList.remove("spin"), 800);
    }
  }

  function scheduleRefresh() {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => refreshRadar(false), REFRESH_MS);
  }

  // Catch up immediately if the app regained focus/visibility after sitting
  // stale for a while (see the visibilitychange/focus listeners in bind()).
  function refreshIfStale() {
    if (document.visibilityState !== "visible") return;
    // Background tabs get their timers throttled, so the lightning overlay can
    // be several frames behind on return. It's independent of the loop, hence
    // ahead of that early return.
    if (lightningLayer) refreshLightning();
    if (loopOn) return; // the loop drives its own frames
    if (Date.now() - lastRefreshAt >= STALE_REFRESH_MS) refreshRadar(false);
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
  // It's keyed by 3-digit ZIP prefix (~900 sectional-center centroids, ~18 KB)
  // rather than all ~34k ZIPs (~0.9 MB) — plenty precise to recenter the map,
  // and a fraction of the payload on cellular. See tools note in README.
  function loadZipData() {
    if (zipData) return Promise.resolve(zipData);
    if (!zipLoading) {
      zipLoading = fetch("/zip3.json")
        .then((res) => {
          if (!res.ok) throw new Error("zip3 " + res.status);
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
      // Look up by 3-digit prefix — the table's centroid for that ZIP area.
      const hit = data[zip.slice(0, 3)];
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
    closeSettingsSheet();
    closeInstallSheet();
    closeInfoSheet();
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

  // --- Lightning (GOES GLM) layer ------------------------------------------

  // Flash extent density from the GOES lightning mapper, drawn *above* the
  // radar so it isn't buried under a reflectivity wash (it marks which part of
  // a storm is electrified, which is only useful next to the storm itself).
  // Tiles are timestamped like the MRMS ones, but this
  // layer deliberately skips the Cache Storage pipeline — there's no lightning
  // loop to replay, and a frame a minute would churn the tile budget that the
  // radar loop depends on. Immutable URLs mean the ordinary HTTP cache still
  // does the work.
  function toggleLightning() {
    if (lightningLayer) {
      stopLightning();
      setStatus("Lightning off.");
      return;
    }
    const build = GLM_STYLE === "firefly" ? glmDotTileLayer : L.tileLayer;
    lightningLayer = build(GLM_TILE_URL, {
      layer: GLM_PRODUCT,
      t: "", // pinned to the newest frame by refreshLightning() below
      // Sparks are small and additive, so they can sit at full strength; the
      // raster styles have to stay light enough to read the radar underneath.
      opacity: GLM_STYLE === "firefly" ? 1 : 0.6,
      attribution: GLM_ATTRIBUTION,
      zIndex: 6, // above the radar (zIndex 5)
      maxZoom: 15,
      maxNativeZoom: GLM_MAX_NATIVE_ZOOM,
      crossOrigin: "anonymous",
      // Both non-native styles blend as light against the map, which is a
      // property of the layer rather than of its pixels — so it has to be set
      // in CSS for the screen and repeated for the share canvas. "firefly"
      // needs nothing else (its colour is baked into the canvas tiles the
      // compositor already draws); "amber" additionally needs its recolour
      // replayed, since a CSS filter is invisible to the canvas.
      className:
        GLM_STYLE === "amber"
          ? "glm-blend glm-tiles"
          : GLM_STYLE === "firefly"
            ? "glm-blend"
            : "",
      canvasFilter: GLM_STYLE === "amber" ? GLM_CANVAS_FILTER : null,
      canvasBlend: GLM_STYLE === "native" ? null : "screen",
    }).addTo(map);
    setToggle(els.lightningBtn, true);

    const c = map.getCenter();
    setStatus(
      inConus(c.lat, c.lng)
        ? "Lightning (GOES GLM) on."
        : "Lightning on — GLM coverage is the lower 48 only."
    );

    // Dot geometry is computed per tile from the size it's drawn at, so a zoom
    // that Leaflet would serve by rescaling the existing canvases has to
    // re-render them instead — otherwise the dots stretch past their cap.
    if (GLM_STYLE === "firefly") map.on("zoomend", redrawLightning);

    refreshLightning();
    clearInterval(lightningTimer);
    lightningTimer = setInterval(refreshLightning, GLM_REFRESH_MS);
  }

  function stopLightning() {
    clearInterval(lightningTimer);
    lightningTimer = null;
    map.off("zoomend", redrawLightning);
    if (lightningLayer) map.removeLayer(lightningLayer);
    lightningLayer = null;
    setToggle(els.lightningBtn, false);
  }

  function redrawLightning() {
    if (lightningLayer) lightningLayer.redraw();
  }

  // Repoint the overlay at the newest published frame. Same trick as the radar
  // refresh: only options.t changes, so redraw() beats setUrl().
  async function refreshLightning() {
    if (!lightningLayer) return;
    const frames = await ensureFrames(glmSource(), 0);
    if (!lightningLayer) return; // toggled off while we were waiting
    const newest = frames.length ? frames[frames.length - 1] : null;
    const t = newest ? isoUTC(newest) : "";
    if (lightningLayer.options.t === t) return; // no new frame yet
    lightningLayer.options.t = t;
    lightningLayer.redraw();
  }

  // Shaped like tileSource()'s result so it can share ensureFrames() and the
  // framesByKey memo. Its own key, since GLM updates on its own schedule.
  function glmSource() {
    return { key: "glm_" + GLM_PRODUCT, frames: GLM_FRAMES_URL };
  }

  // --- "firefly": re-render the FED raster as graduated points of light ----

  // A TileLayer whose tiles are <canvas>, not <img>: it loads RealEarth's tile
  // and redraws it as one spark per data cell, sized by how much lightning is
  // in that cell. Doing it here rather than in CSS is what buys the
  // size-varies-with-intensity part — a filter or mask can only apply a fixed
  // transform to every pixel. It also means the result is baked into the
  // element the share compositor already draws, so screen and shared image
  // can't diverge.
  let GlmDotLayerClass = null;
  function glmDotTileLayer(url, opts) {
    if (!GlmDotLayerClass) {
      GlmDotLayerClass = L.TileLayer.extend({
        createTile(coords, done) {
          const tile = document.createElement("canvas");
          // Draw at the size the tile is actually displayed at — past
          // maxNativeZoom that's the upscaled size — so dots stay crisp
          // instead of being a blown-up 256px bitmap.
          const size = this.getTileSize();
          tile.width = size.x;
          tile.height = size.y;
          const img = new Image();
          img.crossOrigin = "anonymous";
          img.onload = () => {
            try {
              drawGlmDots(tile, img);
            } catch (_) {
              /* leave the tile blank rather than failing the layer */
            }
            done(null, tile);
          };
          // A missing frame is normal (RealEarth serves a transparent
          // placeholder); an empty canvas is the right answer, not an error.
          img.onerror = () => done(null, tile);
          img.src = this.getTileUrl(coords);
          return tile;
        },
      });
    }
    return new GlmDotLayerClass(url, opts);
  }

  function drawGlmDots(tile, img) {
    const S = tile.width;
    if (!S) return;
    // Read the source at its own resolution; sampling is done in cell space so
    // the tile's display size doesn't change which cells we find.
    const src = document.createElement("canvas");
    src.width = img.naturalWidth || 256;
    src.height = img.naturalHeight || 256;
    const sctx = src.getContext("2d");
    sctx.drawImage(img, 0, 0);
    const px = sctx.getImageData(0, 0, src.width, src.height).data;

    const ctx = tile.getContext("2d");
    // Sparks add to each other, so overlapping halos build into a glowing
    // field the way real light would, instead of flat discs overpainting.
    ctx.globalCompositeOperation = "lighter";
    const cell = S / GLM_DOT_CELLS; // dot pitch, tile px
    const sCell = src.width / GLM_DOT_CELLS; // same cell, source px
    // Size ramp for this zoom: the hottest dot fills its cell until that would
    // exceed the screen cap, and the rest of the scale is kept proportional to
    // it so intensity stays readable at every zoom.
    const hotR = Math.min(cell * GLM_DOT_MAX_R, GLM_DOT_CAP_PX);
    const minFrac = GLM_DOT_MIN_R / GLM_DOT_MAX_R;

    for (let row = 0; row < GLM_DOT_CELLS; row++) {
      for (let col = 0; col < GLM_DOT_CELLS; col++) {
        const t = cellIntensity(
          px,
          src.width,
          Math.floor(col * sCell),
          Math.floor(row * sCell),
          Math.max(1, Math.floor(sCell))
        );
        if (t <= 0) continue;
        const core = hotR * (minFrac + t * (1 - minFrac));
        const glow = core * GLM_GLOW_MULT;
        const cx = (col + 0.5) * cell;
        const cy = (row + 0.5) * cell;
        // Core → warm halo → nothing. The halo's alpha also tracks intensity,
        // so a weak cell is a faint pinprick and a hot one genuinely burns.
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, glow);
        grad.addColorStop(0, GLM_CORE_COLOR);
        grad.addColorStop(
          Math.min(0.9, core / glow),
          "rgba(" + GLM_GLOW_COLOR + ", " + (0.34 + 0.4 * t).toFixed(3) + ")"
        );
        grad.addColorStop(1, "rgba(" + GLM_GLOW_COLOR + ", 0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, glow, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Mean flash density over one cell, 0-1. RealEarth encodes the value as a
  // colour on a blue→green→yellow→red ramp, so the hue is the reading: 240° is
  // the bottom of the scale, 0° the top. Transparent pixels are no-data and
  // don't dilute the average — a cell only half covered by a storm should read
  // as strong as the half that's lit.
  function cellIntensity(px, w, x0, y0, span) {
    let sum = 0;
    let n = 0;
    for (let y = y0; y < y0 + span; y++) {
      for (let x = x0; x < x0 + span; x++) {
        const i = (y * w + x) * 4;
        if (px[i + 3] < 8) continue;
        const r = px[i];
        const g = px[i + 1];
        const b = px[i + 2];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const d = max - min;
        let t;
        if (d < 12) {
          // Washed-out/near-grey pixel: no usable hue, call it mid-scale.
          t = 0.5;
        } else {
          let h;
          if (max === r) h = ((g - b) / d) % 6;
          else if (max === g) h = (b - r) / d + 2;
          else h = (r - g) / d + 4;
          h *= 60;
          if (h < 0) h += 360;
          // Past the blue end the ramp wraps into magenta — that's the top.
          t = h > 260 ? 1 : (240 - h) / 240;
        }
        sum += Math.max(0, Math.min(1, t));
        n++;
      }
    }
    return n ? sum / n : 0;
  }

  // --- Radar loop (last 4 hours) -------------------------------------------

  function toggleLoop() {
    if (!currentProduct().loop) {
      setStatus("Loop isn't available for the current radar view.");
      return;
    }
    loopOn ? stopLoop() : startLoop();
  }

  function startLoop() {
    const p = currentProduct();
    if (!p.loop) {
      setStatus("Loop isn't available for the current radar view.");
      return;
    }

    loopOn = true;
    loopReady = false;
    loopLoadedSet = new Set();
    loopActive = [];
    loopStride = LOOP_STRIDES[0];
    setToggle(els.loopBtn, true);
    els.loopBar.classList.remove("hidden");
    // Controls stay inert until the first coarse wave is ready.
    els.playBtn.disabled = true;
    els.loopScrub.disabled = true;

    // Live radar and the loop show the same product, so hide the live layer
    // while the loop drives the display.
    if (radarLayer) map.removeLayer(radarLayer);
    setStatus("Loading radar loop… 0%");

    // MRMS and single sites build their frames from the canonical list, so it
    // must load first; IEM derives frames from the clock and can build now.
    const src = tileSource(p);
    if (src) {
      ensureFrames(src).then(() => {
        if (loopOn) buildLoopLayers(p);
      });
    } else {
      buildLoopLayers(p);
    }
  }

  // Build one tile layer per frame and start the first (coarse) wave. Called
  // synchronously for IEM; after the frame list resolves otherwise.
  function buildLoopLayers(p) {
    const loopCfg = p.loop;
    buildLoopFrames();
    if (!loopFrames.length) {
      setStatus("Radar loop unavailable right now.");
      stopLoop();
      return;
    }
    loopIndex = loopFrames.length - 1; // start on the most recent frame

    const op = sliderToOpacity(els.opacity.value);
    const total = loopFrames.length;
    const attr = p.attribution;

    // Work out the dyadic waves and each frame's wave, so we can load the
    // coarse frames first and reveal a watchable loop before the rest arrive.
    loopWaves = computeLoopWaves(total);
    loopWaveAdded = loopWaves.map(() => false);
    loopWavePromoted = loopWaves.map(() => false);
    frameWave = new Array(total);
    loopWaves.forEach((wave, w) => wave.forEach((i) => (frameWave[i] = w)));

    // Anti-strobe strategy: rather than swapping the TIME param on a single
    // layer (which re-fetches its tiles every frame and flashes blank while
    // they load), build one tile layer per frame. They're all hidden
    // (opacity 0) except the newest, so animating is just flipping opacity
    // between already-loaded layers and a frame never disappears mid-loop.
    // Layers are added to the map wave-by-wave (see addWave/promoteWave), not
    // all at once, so the browser spends its first connections on the coarse
    // frames and the loop can start before the finer waves finish.
    //
    // MRMS and single-site frames come from our cached tile layer (so a frame
    // the live view already fetched loads instantly from Cache Storage); IEM
    // frames come from the time-enabled WMS.
    const src = tileSource(p);
    loopLayers = loopFrames.map((frame, i) => {
      const shared = {
        // Show the newest frame right away; keep the rest hidden until shown.
        opacity: i === loopIndex ? op : 0,
        zIndex: 5,
        maxZoom: 15,
        crossOrigin: "anonymous", // keep loop frames canvas-exportable (Share)
        updateWhenIdle: true, // don't refetch every frame while panning
        keepBuffer: 0, // many layers — keep each one's memory footprint small
        // One attribution entry is plenty (Leaflet de-dupes identical text).
        attribution: i === 0 ? attr : undefined,
      };
      const layer = src
        ? cachedTileLayer(
            src.url,
            Object.assign({}, src.vars, { t: isoUTC(frame) }, shared)
          )
        : L.tileLayer.wms(
            loopCfg.wmsUrl,
            Object.assign(
              {
                layers: loopCfg.wmsLayer,
                format: "image/png",
                transparent: true,
                time: isoUTC(frame),
              },
              shared
            )
          );
      layer.once("load", () => onFrameLoaded(i));
      return layer;
    });

    // Kick off the coarsest wave; each wave adds the next, finer one as it lands.
    addWave(0);

    els.loopScrub.max = String(total - 1);
    els.loopScrub.value = String(loopIndex);
    updateLoopLabel();

    // Safety net: if a coarse frame's tiles never finish (server hiccup), play
    // with whatever's loaded so far rather than hanging.
    clearTimeout(loopSafety);
    loopSafety = setTimeout(onPreloadTimeout, LOOP_SAFETY_MS);
  }

  // Split the frames into dyadic refinement waves: at each stride, take frames
  // newest-first, skipping any a coarser wave already claimed. Coarsest first,
  // so waves[0] is every 8th frame and the last wave fills in the rest.
  function computeLoopWaves(n) {
    const waves = [];
    const seen = new Set();
    for (const stride of LOOP_STRIDES) {
      const wave = [];
      for (let i = n - 1; i >= 0; i -= stride) {
        if (!seen.has(i)) {
          seen.add(i);
          wave.push(i);
        }
      }
      if (wave.length) waves.push(wave);
    }
    return waves;
  }

  // Add a wave's layers to the map — which is what actually starts their tile
  // requests. No-op for an already-added or out-of-range wave.
  function addWave(w) {
    if (w >= loopWaves.length || loopWaveAdded[w]) return;
    loopWaveAdded[w] = true;
    loopWaves[w].forEach((i) => loopLayers[i].addTo(map));
  }

  // A wave has fully loaded: fold its frames into the animating set (which
  // doubles the loop's temporal resolution) and start loading the next one.
  function promoteWave(w) {
    if (loopWavePromoted[w] || !loopOn) return;
    loopWavePromoted[w] = true;
    const merged = new Set(loopActive);
    loopWaves[w].forEach((i) => merged.add(i));
    loopActive = Array.from(merged).sort((a, b) => a - b);
    loopStride = LOOP_STRIDES[w]; // frames now sit this many apart
    addWave(w + 1);
    if (w === 0) markLoopReady();
    // The last wave landing means the full loop is cached — ~300 entries added
    // in one burst, by far the biggest allocator, so sweep now.
    if (w === loopWaves.length - 1) evictTileCache();
  }

  function onFrameLoaded(i) {
    if (!loopOn) return; // loop was stopped mid-preload
    loopLoadedSet.add(i);
    if (!loopReady) {
      const first = loopWaves[0];
      const have = first.filter((k) => loopLoadedSet.has(k)).length;
      const pct = Math.round((have / first.length) * 100);
      setStatus("Loading radar loop… " + pct + "%");
    }
    const w = frameWave[i];
    if (
      w != null &&
      !loopWavePromoted[w] &&
      loopWaves[w].every((k) => loopLoadedSet.has(k))
    ) {
      promoteWave(w);
    }
  }

  // The coarse wave stalled — play whatever coarse frames have loaded so far
  // and let the finer waves keep filling in behind the running animation.
  function onPreloadTimeout() {
    if (loopReady || !loopOn) return;
    const loaded = loopWaves[0].filter((i) => loopLoadedSet.has(i));
    const set = new Set(loaded.length ? loaded : [loopFrames.length - 1]);
    loopActive = Array.from(set).sort((a, b) => a - b);
    loopStride = LOOP_STRIDES[0];
    loopWavePromoted[0] = true;
    addWave(1);
    markLoopReady();
  }

  // First wave is ready (or timed out) — enable the controls and start playing.
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
    loopWaves = [];
    frameWave = [];
    loopWaveAdded = [];
    loopWavePromoted = [];
    loopLoadedSet = new Set();
    loopActive = [];

    // Restore the live radar, re-checking the CONUS fallback in case the view
    // moved across the boundary while the loop ran.
    if (effectiveProductId() !== displayedProductId) {
      rebuildLiveLayer();
    } else if (radarLayer) {
      radarLayer.addTo(map);
      refreshRadar(false);
      setStatus(statusForCurrentProduct("live"));
    }
    syncLegend();
  }

  // Build 24 frame timestamps at 5-minute spacing (the native composite
  // cadence), ending one lag-step back from now (snapped down to the 5-minute
  // grid the composites are built on).
  function buildLoopFrames() {
    const p = currentProduct();
    const src = tileSource(p);
    if (src) {
      buildCanonicalLoopFrames(src.key);
      return;
    }
    const now = Date.now();
    const step = LOOP_STEP_MIN * 60 * 1000;
    let latest = Math.floor((now - LOOP_LAG_MIN * 60 * 1000) / step) * step;
    loopFrames = [];
    for (let i = LOOP_FRAME_COUNT - 1; i >= 0; i--) {
      loopFrames.push(new Date(latest - i * step));
    }
  }

  // Loop frames for a canonical (MRMS or single-site) source: 24 slots at
  // 5-minute spacing across the last 2h, each snapped to the nearest real frame
  // for this source and deduped. The newest slot snaps to the very frame the
  // live view is showing, so tapping Loop reuses the tiles already in Cache
  // Storage instead of re-downloading. A site's ~6-minute volume scans mean
  // several slots collapse onto one frame — the dedupe handles that, leaving
  // ~20 frames rather than 24.
  function buildCanonicalLoopFrames(key) {
    const step = LOOP_STEP_MIN * 60 * 1000;
    const target = Date.now() - LOOP_LAG_MIN * 60 * 1000;
    const newest = (snapFrame(key, target) || new Date(target)).getTime();
    const frames = [];
    const seen = new Set();
    for (let i = LOOP_FRAME_COUNT - 1; i >= 0; i--) {
      const snapped = snapFrame(key, newest - i * step);
      if (!snapped) continue;
      const at = snapped.getTime();
      if (seen.has(at)) continue; // collapse slots that snap to one frame
      seen.add(at);
      frames.push(snapped);
    }
    frames.sort((a, b) => a - b);
    loopFrames = frames;
  }

  // Reveal frame i by flipping opacity — the layers are already loaded, so
  // this is instant and never blanks the map. i is snapped to the nearest
  // frame currently in the animating set, since the coarse waves leave gaps.
  function showLoopFrame(i) {
    const target = nearestActive(i);
    if (target == null) return;
    const prev = loopIndex;
    loopIndex = target;
    const op = sliderToOpacity(els.opacity.value);
    if (loopLayers[prev] && prev !== loopIndex) loopLayers[prev].setOpacity(0);
    if (loopLayers[loopIndex]) loopLayers[loopIndex].setOpacity(op);
    els.loopScrub.value = String(loopIndex);
    updateLoopLabel();
  }

  // Nearest frame index that's actually in the current animating set (so
  // scrubbing to a not-yet-loaded slot lands on the closest loaded frame).
  function nearestActive(i) {
    if (!loopActive.length) return null;
    let best = loopActive[0];
    let bestDist = Infinity;
    for (const a of loopActive) {
      const dist = Math.abs(a - i);
      if (dist < bestDist) {
        bestDist = dist;
        best = a;
      }
    }
    return best;
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
      // Step within the active set, which grows as finer waves land — so the
      // loop naturally densifies mid-play without ever hitting a blank frame.
      const pos = loopActive.indexOf(loopIndex);
      let nextPos = pos + 1;
      if (nextPos >= loopActive.length) nextPos = 0;
      showLoopFrame(loopActive[nextPos]);
      // Hold each frame in proportion to the real time it spans, so the loop
      // runs at a steady real-time rate regardless of the active resolution.
      const frameMs = LOOP_PLAY_MS * loopStride;
      const onNewest = loopIndex === loopFrames.length - 1;
      loopTimer = setTimeout(
        tick,
        onNewest ? Math.max(LOOP_END_DWELL_MS, frameMs) : frameMs
      );
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
    closeSheet();
    closeSettingsSheet();
    closeInfoSheet();
    els.installSheet.classList.remove("hidden");
    els.installSheet.setAttribute("aria-hidden", "false");
  }

  function closeInstallSheet() {
    els.installSheet.classList.add("hidden");
    els.installSheet.setAttribute("aria-hidden", "true");
  }

  // --- About / info sheet (tap the Bendar.app logo) ------------------------

  function toggleInfoSheet() {
    if (els.infoSheet.classList.contains("hidden")) openInfoSheet();
    else closeInfoSheet();
  }

  function openInfoSheet() {
    closeSheet();
    closeSettingsSheet();
    closeInstallSheet();
    els.infoSheet.classList.remove("hidden");
    els.infoSheet.setAttribute("aria-hidden", "false");
    els.infoBtn.setAttribute("aria-expanded", "true");
  }

  function closeInfoSheet() {
    els.infoSheet.classList.add("hidden");
    els.infoSheet.setAttribute("aria-hidden", "true");
    els.infoBtn.setAttribute("aria-expanded", "false");
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
    // basemap → clouds (zIndex 4) → radar (zIndex 5) → lightning (zIndex 6).
    drawTileLayer(ctx, basemapLayer, zoom, origin);
    if (cloudLayer) drawTileLayer(ctx, cloudLayer, zoom, origin);
    if (loopOn && loopLayers[loopIndex]) {
      drawTileLayer(ctx, loopLayers[loopIndex], zoom, origin);
    } else if (radarLayer && map.hasLayer(radarLayer)) {
      drawTileLayer(ctx, radarLayer, zoom, origin);
    }
    if (lightningLayer) drawTileLayer(ctx, lightningLayer, zoom, origin);

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

    // A layer with maxNativeZoom (the GLM overlay) keeps serving its deepest
    // real tiles past that zoom and lets the map scale them up, so its tile
    // coords aren't the map's zoom. Draw at whatever zoom the layer is
    // actually rendering, scaled to match. For every other layer _tileZoom is
    // the map zoom and this collapses to size = 256.
    const tz = layer._tileZoom == null ? zoom : layer._tileZoom;
    const size = T * Math.pow(2, zoom - tz);
    ctx.globalAlpha = op;
    // Match whatever CSS is doing to this layer on screen (the lightning
    // overlay is recoloured and screen-blended). Browsers without ctx.filter
    // just export the layer's own colours — a duller share, not a broken one.
    if (layer.options.canvasFilter && "filter" in ctx) {
      ctx.filter = layer.options.canvasFilter;
    }
    if (layer.options.canvasBlend) {
      ctx.globalCompositeOperation = layer.options.canvasBlend;
    }
    for (const key in tiles) {
      const tile = tiles[key];
      if (!tile.current || !tile.loaded || !tile.el) continue;
      if (!tile.coords || tile.coords.z !== tz) continue;
      const el = tile.el;
      // Skip broken/undecoded images — drawImage would throw on them.
      if (el.tagName === "IMG" && !el.naturalWidth) continue;
      const x = tile.coords.x * size - origin.x;
      const y = tile.coords.y * size - origin.y;
      try {
        ctx.drawImage(el, x, y, size, size);
      } catch (_) {
        /* one bad tile shouldn't sink the whole capture */
      }
    }
    ctx.globalAlpha = 1;
    if ("filter" in ctx) ctx.filter = "none";
    ctx.globalCompositeOperation = "source-over";
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
    const font = "-apple-system, system-ui, Helvetica, Arial, sans-serif";
    const x = 12;

    // Credit every source that's actually in the frame. With the lightning
    // overlay on, that's one line too many for a 390px phone, so it breaks in
    // two and the bar grows — nobody's attribution gets clipped off the edge.
    ctx.font = "400 10px " + font;
    const credits = ["Radar: NWS NEXRAD / IEM"];
    if (lightningLayer) credits.push("Lightning: GOES GLM / SSEC RealEarth");
    credits.push("© OpenStreetMap, © CARTO");
    const sep = "  ·  ";
    const creditLines = [];
    for (const part of credits) {
      const last = creditLines.length - 1;
      const merged = last < 0 ? part : creditLines[last] + sep + part;
      if (last >= 0 && ctx.measureText(merged).width <= size.x - x * 2) {
        creditLines[last] = merged;
      } else {
        creditLines.push(part);
      }
    }

    const barH = 52 + (creditLines.length - 1) * 13;
    const top = size.y - barH;
    const grad = ctx.createLinearGradient(0, top - 14, 0, size.y);
    grad.addColorStop(0, "rgba(11, 18, 32, 0)");
    grad.addColorStop(1, "rgba(11, 18, 32, 0.9)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, top - 14, size.x, barH + 14);

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

    // Row 2 (and 3, with lightning on): source attribution.
    ctx.fillStyle = "rgba(219, 232, 255, 0.5)";
    ctx.font = "400 10px " + font;
    creditLines.forEach((line, i) => {
      ctx.fillText(line, x, top + 42 + i * 13);
    });
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
    els.lightningBtn.addEventListener("click", toggleLightning);
    els.loopBtn.addEventListener("click", toggleLoop);
    els.shareBtn.addEventListener("click", shareView);
    els.settingsBtn.addEventListener("click", toggleSettingsSheet);
    els.settingsClose.addEventListener("click", closeSettingsSheet);
    // Same delegation for the static mosaic list and the dynamic site list.
    const onProductClick = (e) => {
      const btn = e.target.closest("[data-product]");
      if (!btn) return;
      setRadarProduct(btn.getAttribute("data-product"));
    };
    els.radarProductOptions.addEventListener("click", onProductClick);
    if (els.siteProductOptions) {
      els.siteProductOptions.addEventListener("click", onProductClick);
    }
    if (els.sitePickBtn) els.sitePickBtn.addEventListener("click", enterSitePicking);
    if (els.sitePickCancel) {
      els.sitePickCancel.addEventListener("click", () => {
        exitSitePicking();
        siteRangeHintFor = null;
        setStatus(statusForCurrentProduct());
      });
    }
    if (els.sitePickAction) {
      els.sitePickAction.addEventListener("click", () => {
        const site = els.sitePickAction.getAttribute("data-site");
        if (site) onSiteMarkerTap(site);
      });
    }
    if (els.legendImg) {
      els.legendImg.addEventListener("error", () => {
        if (els.legendRow) els.legendRow.classList.add("hidden");
      });
    }
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && sitePicking) {
        exitSitePicking();
        setStatus(statusForCurrentProduct());
      }
    });
    els.zipForm.addEventListener("submit", (e) => {
      e.preventDefault();
      goToZip();
    });
    els.locPinBtn.addEventListener("click", expandLocationControls);
    els.playBtn.addEventListener("click", togglePlay);
    els.loopScrub.addEventListener("input", onScrub);
    els.installBtn.addEventListener("click", onInstall);
    els.installClose.addEventListener("click", closeInstallSheet);
    els.infoBtn.addEventListener("click", toggleInfoSheet);
    els.infoClose.addEventListener("click", closeInfoSheet);

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

    // Refresh radar when returning to the app (iOS suspends background tabs,
    // and setInterval itself gets throttled/paused while backgrounded, so
    // scheduleRefresh's timer can't be relied on to have kept up). Only if
    // it's actually gone stale — a quick glance away and back shouldn't force
    // a re-fetch — and never while the loop is the active view (it drives its
    // own frames). refreshRadar doesn't clear anything already cached, so the
    // previous frame's tiles simply stay available until they age out.
    document.addEventListener("visibilitychange", refreshIfStale);
    window.addEventListener("focus", refreshIfStale);

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
