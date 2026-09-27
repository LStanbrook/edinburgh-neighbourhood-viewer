const EDINBURGH_CENTER = [55.9533, -3.1883];

const map = L.map("map", {
  center: EDINBURGH_CENTER,
  zoom: 12,
  minZoom: 10,
  maxZoom: 18,
  zoomControl: false,
  // Inertia lets the map keep gliding after mouseup, independent of the
  // cursor — that's what let a tooltip drift out of sync with the pointer.
  // Disabling it keeps panning locked 1:1 to the cursor.
  inertia: false,
});

L.control.zoom({ position: "bottomright" }).addTo(map);

// CARTO's free anonymous basemap tiles now require an API key (they
// watermark the tile image itself rather than returning an HTTP error),
// so we use Esri's free, keyless "Light Gray Canvas" basemap instead —
// visually similar (light, minimal) to the CARTO Positron style this
// replaced. Esri ships the base map and its labels as two separate tile
// layers, so both are added here.
L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
  {
    attribution:
      '&copy; <a href="https://www.esri.com">Esri</a> &mdash; Esri, DeLorme, NAVTEQ',
    maxZoom: 16,
  }
).addTo(map);

L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
  { maxZoom: 16 }
).addTo(map);

// --- Boundary datasets ---
// Each dataset knows its own source file, how to read a feature's display
// name, and which properties are worth showing in the info panel. Adding a
// new boundary set (e.g. postcode sectors) means adding one entry here.

const DATASETS = [
  {
    id: "natural-neighbourhoods",
    label: "Natural Neighbourhoods",
    subtitle: "Natural Neighbourhoods — City of Edinburgh Council",
    url: "data/Natural_neighbourhoods.geojson",
    name: (props) => props.NATURALCOM || "Unnamed area",
    infoFields: (props) => {
      const fields = [];
      if (props.Shapearea) {
        // Shapearea is in square metres (carried through from the source's
        // projected CRS, EPSG:27700, even though the delivered geometry is WGS84).
        const sqKm = props.Shapearea / 1e6;
        const sqMiles = props.Shapearea / 2589988.110336;
        fields.push(["Area", `${sqKm.toFixed(2)} km² • ${sqMiles.toFixed(2)} sq mi`]);
      }
      return fields;
    },
  },
  {
    id: "community-councils",
    label: "Community Councils",
    subtitle: "Community Council Boundaries — City of Edinburgh Council",
    url: "data/Community_councils.geojson",
    name: (props) => props.LABEL || "Unnamed area",
    infoFields: (props) => {
      const fields = [];
      if (props.AREA_sqkm) fields.push(["Area", `${props.AREA_sqkm.toFixed(2)} km²`]);
      if (props.POPULATION) fields.push(["Population", props.POPULATION.toLocaleString()]);
      if (props.Ward_Name) fields.push(["Ward", props.Ward_Name]);
      return fields;
    },
  },
  {
    id: "wards",
    label: "Wards",
    subtitle: "Multi-Member Ward Boundaries — City of Edinburgh Council",
    url: "data/Ward_boundaries.geojson",
    name: (props) => props.Ward_Name || "Unnamed ward",
    infoFields: (props) => {
      const fields = [];
      if (props.Ward_No) fields.push(["Ward No.", props.Ward_No]);
      if (props.Ward_Code) fields.push(["Ward code", props.Ward_Code]);
      return fields;
    },
  },
];

const datasetCache = new Map();
let currentDataset = DATASETS[0];

const infoPanel = document.getElementById("info-panel");
const infoName = document.getElementById("info-name");
const infoDetails = document.getElementById("info-details");
const infoClose = document.getElementById("info-close");
const searchInput = document.getElementById("search-input");
const searchResults = document.getElementById("search-results");
const headerSubtitle = document.getElementById("header-subtitle");
const datasetSwitcher = document.getElementById("dataset-switcher");
const pubsVisibleToggle = document.getElementById("pubs-visible-toggle");
const drawAreaBtn = document.getElementById("draw-area-btn");
const checklistToggleBtn = document.getElementById("checklist-toggle-btn");
const checklistSidebar = document.getElementById("checklist-sidebar");
const checklistClose = document.getElementById("checklist-close");
const checklistSummary = document.getElementById("checklist-summary");
const checklistAreas = document.getElementById("checklist-areas");
const checklistList = document.getElementById("checklist-list");

let geojsonLayer = null;
let selectedLayer = null;
let openTooltipLayer = null;
let lastMouseEvent = null;
let allFeatures = [];
let currentSelectionType = null; // "boundary" | "pub" | null

// --- Pubs & bars ---

let pubsData = null;
let pubMarkersById = new Map();
let markerClusterGroup = null;
let pubsVisible = true;
let checklistState = {}; // pub id -> { visited, rating, price, notes }
let selectedAreas = []; // { key, label, geometry, layer? }
let drawnAreaCounter = 0;
const drawnItems = new L.FeatureGroup().addTo(map);
let activeDrawHandler = null;

const baseStyle = {
  color: "#2f6f4f",
  weight: 1.5,
  fillColor: "#6fae8c",
  fillOpacity: 0.15,
};

const hoverStyle = {
  color: "#2f6f4f",
  weight: 2,
  fillColor: "#2f6f4f",
  fillOpacity: 0.3,
};

const selectedStyle = {
  color: "#1f2421",
  weight: 2.5,
  fillColor: "#f2a541",
  fillOpacity: 0.4,
};

function featureName(feature) {
  return currentDataset.name(feature.properties);
}

function boundaryAreaKey(feature) {
  return `boundary:${currentDataset.id}:${featureName(feature)}`;
}

function showInfoPanel(feature) {
  currentSelectionType = "boundary";
  infoName.textContent = featureName(feature);

  infoDetails.innerHTML = "";
  const fields = currentDataset.infoFields(feature.properties);
  fields.forEach(([label, value]) => {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    infoDetails.append(dt, dd);
  });

  const areaKey = boundaryAreaKey(feature);
  const inSelection = selectedAreas.some((a) => a.key === areaKey);
  const addAreaBtn = document.createElement("button");
  addAreaBtn.type = "button";
  addAreaBtn.className = "pub-add-area-btn" + (inSelection ? " active" : "");
  addAreaBtn.textContent = inSelection ? "Remove from pub checklist" : "Add to pub checklist";
  addAreaBtn.addEventListener("click", () => {
    toggleBoundaryArea(areaKey, featureName(feature), feature.geometry);
    showInfoPanel(feature);
  });
  infoDetails.appendChild(addAreaBtn);

  infoPanel.classList.remove("hidden");
}

function hideInfoPanel() {
  infoPanel.classList.add("hidden");
}

function resetSelection() {
  if (selectedLayer) {
    geojsonLayer.resetStyle(selectedLayer);
    selectedLayer = null;
  }
}

function selectLayer(layer, { fly = false } = {}) {
  resetSelection();
  selectedLayer = layer;
  layer.setStyle(selectedStyle);
  layer.bringToFront();
  showInfoPanel(layer.feature);
  if (fly) {
    map.flyToBounds(layer.getBounds(), { padding: [60, 60], maxZoom: 15, duration: 0.6 });
  }
}

function closeAllTooltipsExcept(exceptLayer) {
  geojsonLayer.eachLayer((l) => {
    if (l !== exceptLayer && l.isTooltipOpen()) {
      l.closeTooltip();
      if (l !== selectedLayer) geojsonLayer.resetStyle(l);
    }
  });
}

function onEachFeature(feature, layer) {
  allFeatures.push({ feature, layer });

  layer.bindTooltip(featureName(feature), {
    className: "neighbourhood-tooltip",
    sticky: true,
  });

  layer.on({
    mouseover: () => {
      // At most one tooltip should ever be open. Two adjacent polygons
      // sharing a border can make the browser's hit-test flicker rapidly
      // between them during a drag (dozens of times a second right at the
      // shared edge), faster than Leaflet's own tooltip open/close DOM
      // lifecycle keeps up with — tracking just one "currently open" layer
      // isn't reliable there, so sweep every layer's tooltip closed instead.
      closeAllTooltipsExcept(layer);
      openTooltipLayer = layer;
      if (layer !== selectedLayer) layer.setStyle(hoverStyle);
    },
    mouseout: () => {
      if (openTooltipLayer === layer) openTooltipLayer = null;
      if (layer !== selectedLayer) geojsonLayer.resetStyle(layer);
    },
    mousedown: (e) => {
      // Chromium focuses the SVG path on mousedown even with no explicit
      // tabindex, and Leaflet's own tooltip wiring re-opens the tooltip on
      // focus (for keyboard a11y) — anchored at the polygon's centroid
      // instead of the cursor, which is the visible "drops lower" jump.
      // preventDefault() on the native event stops that focus without
      // affecting drag/click (Leaflet hands us the native event as
      // e.originalEvent, not e itself).
      L.DomEvent.preventDefault(e.originalEvent);
    },
    click: () => {
      // The info panel already names the area, so keep just one source of
      // truth on selection rather than a hover tooltip sitting on top of it.
      layer.closeTooltip();
      if (openTooltipLayer === layer) openTooltipLayer = null;
      selectLayer(layer);
    },
  });
}

map.on("mousemove", (e) => {
  lastMouseEvent = e.originalEvent;
});

// Belt-and-braces: rather than chase every specific event that can leave a
// tooltip open for a polygon the cursor isn't actually over any more (fast
// drags, scroll/button zoom, a search's flyTo, even rapid hit-test flicker
// right at a shared border between two polygons — all observed causes),
// run a small always-on consistency check instead. Cheap for ~150 layers,
// and guarantees any stray tooltip gets caught within a fraction of a
// second regardless of what caused it.
setInterval(() => {
  if (!geojsonLayer) return;
  const elUnderCursor = lastMouseEvent
    ? document.elementFromPoint(lastMouseEvent.clientX, lastMouseEvent.clientY)
    : null;
  geojsonLayer.eachLayer((l) => {
    if (l.isTooltipOpen() && l._path !== elUnderCursor) {
      l.closeTooltip();
      if (l !== selectedLayer) geojsonLayer.resetStyle(l);
      if (openTooltipLayer === l) openTooltipLayer = null;
    }
  });
}, 150);

function loadDataset(dataset) {
  currentDataset = dataset;
  headerSubtitle.textContent = dataset.subtitle;

  hideInfoPanel();
  currentSelectionType = null;
  selectedLayer = null;
  openTooltipLayer = null;
  allFeatures = [];
  searchInput.value = "";
  searchResults.classList.remove("visible");

  if (geojsonLayer) {
    map.removeLayer(geojsonLayer);
    geojsonLayer = null;
  }

  renderTabs();

  const cached = datasetCache.get(dataset.id);
  const ready = cached ? Promise.resolve(cached) : fetch(dataset.url).then((res) => res.json());

  ready
    .then((data) => {
      datasetCache.set(dataset.id, data);
      if (currentDataset !== dataset) return; // a newer switch happened while this was loading

      geojsonLayer = L.geoJSON(data, {
        style: baseStyle,
        onEachFeature,
      }).addTo(map);

      map.fitBounds(geojsonLayer.getBounds(), { padding: [20, 20] });
    })
    .catch((err) => {
      console.error(`Failed to load ${dataset.label} data:`, err);
    });
}

function renderTabs() {
  datasetSwitcher.innerHTML = "";
  DATASETS.forEach((dataset) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dataset-tab" + (dataset === currentDataset ? " active" : "");
    btn.textContent = dataset.label;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", dataset === currentDataset ? "true" : "false");
    btn.addEventListener("click", () => {
      if (dataset !== currentDataset) loadDataset(dataset);
    });
    datasetSwitcher.appendChild(btn);
  });
}

loadDataset(currentDataset);

infoClose.addEventListener("click", () => {
  hideInfoPanel();
  if (currentSelectionType === "boundary") resetSelection();
  currentSelectionType = null;
});

// --- Search ---

function renderSearchResults(matches) {
  searchResults.innerHTML = "";
  if (matches.length === 0) {
    searchResults.classList.remove("visible");
    return;
  }
  matches.slice(0, 8).forEach(({ feature, layer }) => {
    const item = document.createElement("div");
    item.className = "search-result";
    item.textContent = featureName(feature);
    item.addEventListener("click", () => {
      selectLayer(layer, { fly: true });
      searchInput.value = featureName(feature);
      searchResults.classList.remove("visible");
    });
    searchResults.appendChild(item);
  });
  searchResults.classList.add("visible");
}

searchInput.addEventListener("input", () => {
  const query = searchInput.value.trim().toLowerCase();
  if (!query) {
    searchResults.classList.remove("visible");
    return;
  }
  const matches = allFeatures.filter(({ feature }) =>
    featureName(feature).toLowerCase().includes(query)
  );
  renderSearchResults(matches);
});

document.addEventListener("click", (e) => {
  if (!e.target.closest("#search-box")) {
    searchResults.classList.remove("visible");
  }
});

// --- Pubs & bars data + checklist backend ---

function fetchChecklist() {
  return fetch("/api/checklist")
    .then((res) => res.json())
    .then((data) => {
      checklistState = data;
    });
}

function patchPub(id, patch) {
  return fetch(`/api/checklist/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  })
    .then((res) => res.json())
    .then((entry) => {
      if (Object.keys(entry).length === 0) delete checklistState[id];
      else checklistState[id] = entry;
      return entry;
    });
}

function pubEntry(id) {
  return checklistState[id] || {};
}

function pubIcon(id) {
  const visited = pubEntry(id).visited;
  return L.divIcon({
    className: "",
    html: `<span class="pub-marker-icon${visited ? " visited" : ""}"></span>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

function refreshMarkerIcon(id) {
  const marker = pubMarkersById.get(id);
  if (marker) marker.setIcon(pubIcon(id));
}

function setPubsVisible(visible) {
  pubsVisible = visible;
  if (!markerClusterGroup) return;
  if (visible) markerClusterGroup.addTo(map);
  else map.removeLayer(markerClusterGroup);
}

function loadPubs() {
  return fetch("data/Pubs.geojson")
    .then((res) => res.json())
    .then((data) => {
      pubsData = data;
      markerClusterGroup = L.markerClusterGroup({ maxClusterRadius: 45 });
      data.features.forEach((feature) => {
        const [lng, lat] = feature.geometry.coordinates;
        const id = feature.properties.id;
        const marker = L.marker([lat, lng], { icon: pubIcon(id) });
        marker.on("click", () => selectPub(feature));
        pubMarkersById.set(id, marker);
        markerClusterGroup.addLayer(marker);
      });
      if (pubsVisible) markerClusterGroup.addTo(map);
    })
    .catch((err) => {
      console.error("Failed to load pubs data:", err);
    });
}

function focusPub(id) {
  if (!pubsData) return;
  const feature = pubsData.features.find((f) => f.properties.id === id);
  const marker = pubMarkersById.get(id);
  if (!feature || !marker) return;
  if (!pubsVisible) {
    pubsVisibleToggle.checked = true;
    setPubsVisible(true);
  }
  markerClusterGroup.zoomToShowLayer(marker, () => selectPub(feature));
}

// --- Pub detail panel (shares #info-panel with the boundary info panel) ---

function selectPub(feature) {
  currentSelectionType = "pub";
  const id = feature.properties.id;
  const props = feature.properties;
  const entry = pubEntry(id);

  infoName.textContent = props.name;
  infoDetails.innerHTML = "";

  if (props.address || props.postcode) {
    const addr = document.createElement("p");
    addr.className = "pub-field-row";
    addr.textContent = [props.address, props.postcode].filter(Boolean).join(", ");
    infoDetails.appendChild(addr);
  }

  if (props.website) {
    const link = document.createElement("a");
    link.href = props.website;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.className = "pub-detail-link";
    link.textContent = "Website ↗";
    infoDetails.appendChild(link);
  }

  const visitedRow = document.createElement("label");
  visitedRow.className = "pub-visited-row";
  const visitedCheckbox = document.createElement("input");
  visitedCheckbox.type = "checkbox";
  visitedCheckbox.checked = !!entry.visited;
  visitedCheckbox.addEventListener("change", () => {
    patchPub(id, { visited: visitedCheckbox.checked }).then(() => {
      refreshMarkerIcon(id);
      renderChecklist();
    });
  });
  visitedRow.append(visitedCheckbox, document.createTextNode(" Visited"));
  infoDetails.appendChild(visitedRow);

  const priceRow = document.createElement("div");
  priceRow.className = "pub-field-row";
  const priceLabelEl = document.createElement("span");
  priceLabelEl.textContent = "Price:";
  const priceOptions = document.createElement("div");
  priceOptions.className = "pub-price-options";
  ["£", "££", "£££", "££££"].forEach((tier) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pub-price-btn" + (entry.price === tier ? " active" : "");
    btn.textContent = tier;
    btn.addEventListener("click", () => {
      const nextPrice = entry.price === tier ? null : tier;
      patchPub(id, { price: nextPrice }).then((updated) => {
        entry.price = updated.price || null;
        Array.from(priceOptions.children).forEach((b) =>
          b.classList.toggle("active", b.textContent === entry.price)
        );
        renderChecklist();
      });
    });
    priceOptions.appendChild(btn);
  });
  priceRow.append(priceLabelEl, priceOptions);
  infoDetails.appendChild(priceRow);

  const ratingRow = document.createElement("div");
  ratingRow.className = "pub-field-row";
  const ratingLabelEl = document.createElement("span");
  ratingLabelEl.textContent = "Your rating:";
  const starsWrap = document.createElement("div");
  starsWrap.className = "pub-stars";
  for (let i = 1; i <= 5; i++) {
    const starBtn = document.createElement("button");
    starBtn.type = "button";
    starBtn.className = "pub-star-btn" + (entry.rating >= i ? " filled" : "");
    starBtn.textContent = "★";
    starBtn.addEventListener("click", () => {
      const nextRating = entry.rating === i ? null : i;
      patchPub(id, { rating: nextRating }).then((updated) => {
        entry.rating = updated.rating || null;
        Array.from(starsWrap.children).forEach((b, idx) =>
          b.classList.toggle("filled", entry.rating >= idx + 1)
        );
        renderChecklist();
      });
    });
    starsWrap.appendChild(starBtn);
  }
  ratingRow.append(ratingLabelEl, starsWrap);
  infoDetails.appendChild(ratingRow);

  infoPanel.classList.remove("hidden");
}

pubsVisibleToggle.addEventListener("change", () => setPubsVisible(pubsVisibleToggle.checked));

// --- Area selection: existing boundaries + freehand drawn shapes ---

function toggleBoundaryArea(key, label, geometry) {
  const idx = selectedAreas.findIndex((a) => a.key === key);
  if (idx >= 0) selectedAreas.splice(idx, 1);
  else selectedAreas.push({ key, label, geometry });
  renderChecklist();
}

drawAreaBtn.addEventListener("click", () => {
  if (activeDrawHandler) {
    activeDrawHandler.disable();
    activeDrawHandler = null;
    drawAreaBtn.classList.remove("active");
    return;
  }
  activeDrawHandler = new L.Draw.Polygon(map, {
    shapeOptions: { color: "#f2a541", weight: 2, fillOpacity: 0.2 },
  });
  activeDrawHandler.enable();
  drawAreaBtn.classList.add("active");
});

map.on(L.Draw.Event.CREATED, (e) => {
  const layer = e.layer;
  drawnItems.addLayer(layer);
  drawnAreaCounter += 1;
  const geojson = layer.toGeoJSON();
  selectedAreas.push({
    key: `drawn:${drawnAreaCounter}`,
    label: `Drawn area ${drawnAreaCounter}`,
    geometry: geojson.geometry,
    layer,
  });
  activeDrawHandler = null;
  drawAreaBtn.classList.remove("active");
  renderChecklist();
  openChecklist();
});

map.on(L.Draw.Event.DRAWSTOP, () => {
  activeDrawHandler = null;
  drawAreaBtn.classList.remove("active");
});

// --- Checklist sidebar ---

function pubsInSelection() {
  if (!pubsData) return [];
  if (selectedAreas.length === 0) return pubsData.features;
  return pubsData.features.filter((feature) => {
    const pt = turf.point(feature.geometry.coordinates);
    return selectedAreas.some((area) => {
      try {
        return turf.booleanPointInPolygon(pt, area.geometry);
      } catch (err) {
        return false;
      }
    });
  });
}

function buildChecklistRow(feature) {
  const id = feature.properties.id;
  const entry = pubEntry(id);
  const row = document.createElement("div");
  row.className = "checklist-row";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = !!entry.visited;
  checkbox.addEventListener("click", (e) => e.stopPropagation());
  checkbox.addEventListener("change", () => {
    patchPub(id, { visited: checkbox.checked }).then(() => {
      refreshMarkerIcon(id);
      renderChecklist();
    });
  });

  const name = document.createElement("span");
  name.className = "checklist-row-name";
  name.textContent = feature.properties.name;

  const badges = document.createElement("span");
  badges.className = "checklist-row-badges";
  if (entry.price) badges.append(entry.price);
  if (entry.rating) {
    const starSpan = document.createElement("span");
    starSpan.textContent = "★".repeat(entry.rating);
    badges.appendChild(starSpan);
  }

  row.append(checkbox, name, badges);
  row.addEventListener("click", () => focusPub(id));
  return row;
}

function renderChecklist() {
  const pubs = pubsInSelection();
  const visitedCount = pubs.filter((f) => pubEntry(f.properties.id).visited).length;
  checklistSummary.textContent =
    selectedAreas.length === 0
      ? `All pubs & bars — ${visitedCount} / ${pubs.length} visited`
      : `${visitedCount} / ${pubs.length} visited in selected area${selectedAreas.length > 1 ? "s" : ""}`;

  checklistAreas.innerHTML = "";
  selectedAreas.forEach((area) => {
    const chip = document.createElement("span");
    chip.className = "area-chip";
    const label = document.createElement("span");
    label.textContent = area.label;
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => {
      selectedAreas = selectedAreas.filter((a) => a.key !== area.key);
      if (area.layer) drawnItems.removeLayer(area.layer);
      renderChecklist();
    });
    chip.append(label, removeBtn);
    checklistAreas.appendChild(chip);
  });
  if (selectedAreas.length > 0) {
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "clear-areas-btn";
    clearBtn.textContent = "Clear all areas";
    clearBtn.addEventListener("click", () => {
      selectedAreas.forEach((a) => {
        if (a.layer) drawnItems.removeLayer(a.layer);
      });
      selectedAreas = [];
      renderChecklist();
    });
    checklistAreas.appendChild(clearBtn);
  }

  checklistList.innerHTML = "";
  pubs
    .slice()
    .sort((a, b) => a.properties.name.localeCompare(b.properties.name))
    .forEach((feature) => {
      checklistList.appendChild(buildChecklistRow(feature));
    });
}

function openChecklist() {
  checklistSidebar.classList.remove("hidden");
  checklistToggleBtn.classList.add("active");
  renderChecklist();
}

function closeChecklist() {
  checklistSidebar.classList.add("hidden");
  checklistToggleBtn.classList.remove("active");
}

checklistToggleBtn.addEventListener("click", () => {
  if (checklistSidebar.classList.contains("hidden")) openChecklist();
  else closeChecklist();
});

checklistClose.addEventListener("click", closeChecklist);

fetchChecklist().then(loadPubs);
