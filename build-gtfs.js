// build-gtfs.js
//
// Hämtar Skånetrafikens statiska GTFS-zip från Trafiklab, packar upp och
// bearbetar den (samma logik som tidigare kördes i webbläsaren/workern),
// och sparar tre färdiga, LÄTTA JSON-filer i data/-mappen:
//   - data/trip_lookup.json    (trip_id -> linje/färg/destination)
//   - data/rail_lines.json     (tåglinjer med färg + spårgeometri)
//   - data/train_stations.json (riktiga tågstationer)
//
// index.html hämtar sedan bara dessa tre färdiga filer direkt från samma
// GitHub Pages-sida — ingen tung CSV/ZIP-bearbetning i webbläsaren längre.
//
// Körs av GitHub Actions enligt schemat i .github/workflows/build-gtfs.yml
// (en gång per natt, helt gratis — ingen CPU-tidsgräns som Cloudflare
// Workers gratisplan har).
//
// Kräver miljövariabeln TRAFIKLAB_STATIC_KEY (sätts som en GitHub Actions
// secret, se instruktionerna i workflow-filen).

const fs = require("fs");
const path = require("path");

const TRAFIKLAB_STATIC_KEY = process.env.TRAFIKLAB_STATIC_KEY;
if (!TRAFIKLAB_STATIC_KEY) {
  console.error("Miljövariabeln TRAFIKLAB_STATIC_KEY saknas — avbryter.");
  process.exit(1);
}
const STATIC_GTFS_URL = `https://opendata.samtrafiken.se/gtfs/skane/skane.zip?key=${TRAFIKLAB_STATIC_KEY}`;

// Egna manuella linjefärger — redigera denna lista själv om du vill
// override:a en specifik linjes färg. Nyckeln är linjenumret
// (route_short_name), värdet en hex-färg UTAN #.
const MANUAL_ROUTE_COLORS = {
};

const OUTPUT_DIR = path.join(__dirname, "data");

// ============================================================
// ZIP-läsare (beroendefri — samma testade kod som i worker.js)
// ============================================================
function readUInt32LE(view, offset) { return view.getUint32(offset, true); }
function readUInt16LE(view, offset) { return view.getUint16(offset, true); }

function findEndOfCentralDirectory(bytes) {
  const EOCD_SIG = 0x06054b50;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const maxCommentLen = 65535;
  const searchStart = Math.max(0, bytes.length - 22 - maxCommentLen);
  for (let i = bytes.length - 22; i >= searchStart; i--) {
    if (readUInt32LE(view, i) === EOCD_SIG) return i;
  }
  throw new Error("Hittade ingen ZIP-slutpost (EOCD) — trasig eller ej en ZIP-fil");
}

function readCentralDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(bytes);
  const totalEntries = readUInt16LE(view, eocdOffset + 10);
  const centralDirOffset = readUInt32LE(view, eocdOffset + 16);

  const entries = new Map();
  let offset = centralDirOffset;
  const CENTRAL_SIG = 0x02014b50;

  for (let i = 0; i < totalEntries; i++) {
    const sig = readUInt32LE(view, offset);
    if (sig !== CENTRAL_SIG) {
      throw new Error(`Fel signatur i central katalog vid post ${i} (offset ${offset})`);
    }
    const method = readUInt16LE(view, offset + 10);
    const compressedSize = readUInt32LE(view, offset + 20);
    const uncompressedSize = readUInt32LE(view, offset + 24);
    const nameLen = readUInt16LE(view, offset + 28);
    const extraLen = readUInt16LE(view, offset + 30);
    const commentLen = readUInt16LE(view, offset + 32);
    const localHeaderOffset = readUInt32LE(view, offset + 42);

    const nameBytes = bytes.slice(offset + 46, offset + 46 + nameLen);
    const name = new TextDecoder("utf-8").decode(nameBytes);

    entries.set(name, { method, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function extractEntry(bytes, entry) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const LOCAL_SIG = 0x04034b50;
  const sig = readUInt32LE(view, entry.localHeaderOffset);
  if (sig !== LOCAL_SIG) {
    throw new Error(`Fel signatur i lokalt filhuvud vid offset ${entry.localHeaderOffset}`);
  }
  const nameLen = readUInt16LE(view, entry.localHeaderOffset + 26);
  const extraLen = readUInt16LE(view, entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;
  const compressedData = bytes.slice(dataStart, dataStart + entry.compressedSize);

  if (entry.method === 0) return compressedData; // okomprimerad ("stored")
  if (entry.method === 8) {
    const ds = new DecompressionStream("deflate-raw");
    const stream = new Blob([compressedData]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }
  throw new Error(`Okänd komprimeringsmetod: ${entry.method}`);
}

async function extractFileAsText(bytes, centralDir, filename) {
  const entry = centralDir.get(filename);
  if (!entry) return null;
  const data = await extractEntry(bytes, entry);
  return new TextDecoder("utf-8").decode(data);
}

// ============================================================
// GTFS-bearbetningslogik (samma som tidigare, oförändrad)
// ============================================================
function isRailRouteType(routeType) {
  const n = parseInt(routeType, 10);
  if (Number.isNaN(n)) return false;
  return n === 2 || (n >= 100 && n < 200);
}

function classifyColorForRoute(shortName, longName, routeType) {
  const name = `${shortName} ${longName || ""}`.toLowerCase();
  if (name.includes("öresundståg")) return "a3a9ad";
  if (isRailRouteType(routeType)) return "645fa2";
  if (name.includes("pågatåg")) return "645fa2";
  const trimmed = (shortName || "").trim();
  if (/^\d+$/.test(trimmed)) {
    if (trimmed.length <= 2) return "2e7d32";
    if (trimmed.length === 3) return "f9a825";
  }
  if (/^skåneexpressen/i.test(trimmed)) return "f9a825";
  return null;
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x) => Math.round(255 * x).toString(16).padStart(2, "0");
  return `${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

function fallbackColorForRoute(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return hslToHex(hash % 360, 65, 45);
}

function simplifyPoints(points, toleranceMeters) {
  if (points.length < 3) return points;
  function perpendicularDistanceMeters(p, a, b) {
    const latRef = (a[0] + b[0]) / 2;
    const cosLat = Math.cos((latRef * Math.PI) / 180);
    const mPerDegLat = 111320;
    const ax = a[1] * cosLat * mPerDegLat, ay = a[0] * mPerDegLat;
    const bx = b[1] * cosLat * mPerDegLat, by = b[0] * mPerDegLat;
    const px = p[1] * cosLat * mPerDegLat, py = p[0] * mPerDegLat;
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - ax, py - ay);
    const t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    const projX = ax + Math.max(0, Math.min(1, t)) * dx;
    const projY = ay + Math.max(0, Math.min(1, t)) * dy;
    return Math.hypot(px - projX, py - projY);
  }
  function simplifySegment(pts, tol) {
    if (pts.length < 3) return pts;
    let maxDist = 0, maxIdx = 0;
    const a = pts[0], b = pts[pts.length - 1];
    for (let i = 1; i < pts.length - 1; i++) {
      const d = perpendicularDistanceMeters(pts[i], a, b);
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
    if (maxDist > tol) {
      const left = simplifySegment(pts.slice(0, maxIdx + 1), tol);
      const right = simplifySegment(pts.slice(maxIdx), tol);
      return left.slice(0, -1).concat(right);
    }
    return [a, b];
  }
  return simplifySegment(points, toleranceMeters);
}

function forEachCsvRow(text, callback) {
  const lines = text.split("\n");
  if (lines.length === 0) return;
  const header = lines[0].replace(/^\uFEFF/, "").split(",").map((h) => h.trim());
  const indexOf = (col) => header.indexOf(col);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const cols = line.split(",");
    callback(cols, indexOf);
  }
}

// ============================================================
// Huvudfunktionen
// ============================================================
async function buildGtfsArtifacts() {
  console.log("Hämtar GTFS-zip från Trafiklab...");
  const res = await fetch(STATIC_GTFS_URL);
  if (!res.ok) throw new Error(`Kunde inte hämta GTFS-zip: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  console.log(`Hämtade ${(bytes.length / 1024 / 1024).toFixed(1)} MB.`);
  const centralDir = readCentralDirectory(bytes);

  // ---- routes.txt ----
  const routesById = new Map();
  const routesText = await extractFileAsText(bytes, centralDir, "routes.txt");
  forEachCsvRow(routesText, (cols, idx) => {
    const id = (cols[idx("route_id")] || "").trim();
    if (!id) return;
    const shortName = (cols[idx("route_short_name")] || "").trim();
    const longName = (cols[idx("route_long_name")] || "").trim();
    const routeType = (cols[idx("route_type")] || "").trim();
    const officialColor = (cols[idx("route_color")] || "").trim();
    const manualColor = MANUAL_ROUTE_COLORS[shortName];
    const heuristicColor = classifyColorForRoute(shortName, longName, routeType);
    routesById.set(id, {
      color: manualColor || officialColor || heuristicColor || fallbackColorForRoute(id),
      textColor: (cols[idx("route_text_color")] || "").trim(),
      shortName,
      routeType,
      brand: isRailRouteType(routeType) ? "pagatag" : null,
      colorSource: manualColor ? "manual" : officialColor ? "official" : heuristicColor ? "heuristic" : "auto",
    });
  });
  console.log(`routes.txt: ${routesById.size} linjer`);

  // ---- trips.txt ----
  const routeIdByTripId = new Map();
  const headsignByTripId = new Map();
  const shapeIdsByRoute = new Map();
  const tripsText = await extractFileAsText(bytes, centralDir, "trips.txt");
  forEachCsvRow(tripsText, (cols, idx) => {
    const tripId = (cols[idx("trip_id")] || "").trim();
    const routeId = (cols[idx("route_id")] || "").trim();
    const shapeId = (cols[idx("shape_id")] || "").trim();
    const headsign = (cols[idx("trip_headsign")] || "").trim();
    if (tripId && routeId) routeIdByTripId.set(tripId, routeId);
    if (tripId && headsign) headsignByTripId.set(tripId, headsign);
    if (routeId && shapeId) {
      if (!shapeIdsByRoute.has(routeId)) shapeIdsByRoute.set(routeId, new Set());
      shapeIdsByRoute.get(routeId).add(shapeId);
    }
  });
  console.log(`trips.txt: ${routeIdByTripId.size} resor`);

  // ---- shapes.txt ----
  const shapePointsById = new Map();
  const shapesText = await extractFileAsText(bytes, centralDir, "shapes.txt");
  if (shapesText) {
    const raw = new Map();
    forEachCsvRow(shapesText, (cols, idx) => {
      const shapeId = (cols[idx("shape_id")] || "").trim();
      const lat = parseFloat(cols[idx("shape_pt_lat")]);
      const lon = parseFloat(cols[idx("shape_pt_lon")]);
      const seq = parseInt(cols[idx("shape_pt_sequence")], 10);
      if (!shapeId || Number.isNaN(lat) || Number.isNaN(lon)) return;
      if (!raw.has(shapeId)) raw.set(shapeId, []);
      raw.get(shapeId).push({ seq: Number.isNaN(seq) ? 0 : seq, lat, lon });
    });
    for (const [shapeId, points] of raw) {
      points.sort((a, b) => a.seq - b.seq);
      shapePointsById.set(shapeId, simplifyPoints(points.map((p) => [p.lat, p.lon]), 8));
    }
  }
  console.log(`shapes.txt: ${shapePointsById.size} körvägar (förenklade)`);

  // ---- stops.txt ----
  const stopsById = new Map();
  const stopsText = await extractFileAsText(bytes, centralDir, "stops.txt");
  forEachCsvRow(stopsText, (cols, idx) => {
    const stopId = (cols[idx("stop_id")] || "").trim();
    const lat = parseFloat(cols[idx("stop_lat")]);
    const lon = parseFloat(cols[idx("stop_lon")]);
    if (!stopId || Number.isNaN(lat) || Number.isNaN(lon)) return;
    stopsById.set(stopId, { lat, lon, name: (cols[idx("stop_name")] || "").trim() });
  });
  console.log(`stops.txt: ${stopsById.size} hållplatser`);

  // ---- stop_times.txt ----
  const railTripIds = new Set();
  for (const [tripId, rId] of routeIdByTripId) {
    const info = routesById.get(rId);
    if (info && isRailRouteType(info.routeType)) railTripIds.add(tripId);
  }
  const railStopIds = new Set();
  const stopIdsByRoute = new Map();
  const lastStopByTripId = new Map();
  const stopTimesText = await extractFileAsText(bytes, centralDir, "stop_times.txt");
  if (stopTimesText) {
    forEachCsvRow(stopTimesText, (cols, idx) => {
      const tripId = (cols[idx("trip_id")] || "").trim();
      const stopId = (cols[idx("stop_id")] || "").trim();
      if (!tripId || !stopId) return;
      const seq = parseInt(cols[idx("stop_sequence")], 10);
      const seqNum = Number.isNaN(seq) ? 0 : seq;
      const existing = lastStopByTripId.get(tripId);
      if (!existing || seqNum > existing.seq) lastStopByTripId.set(tripId, { seq: seqNum, stopId });

      if (!railTripIds.has(tripId)) return;
      railStopIds.add(stopId);
      const routeId = routeIdByTripId.get(tripId);
      if (!routeId) return;
      if (!stopIdsByRoute.has(routeId)) stopIdsByRoute.set(routeId, new Set());
      stopIdsByRoute.get(routeId).add(stopId);
    });
  }
  console.log(`stop_times.txt: ${lastStopByTripId.size} resor bearbetade, ${railStopIds.size} tågstationer hittade`);

  for (const [tripId, last] of lastStopByTripId) {
    if (headsignByTripId.has(tripId)) continue;
    const s = stopsById.get(last.stopId);
    if (s && s.name) headsignByTripId.set(tripId, s.name);
  }

  const DENMARK_LON_THRESHOLD = 12.6;
  let oresundstagCount = 0;
  for (const [routeId, stopIds] of stopIdsByRoute) {
    let isOresundstag = false;
    for (const stopId of stopIds) {
      const s = stopsById.get(stopId);
      if (s && s.lon < DENMARK_LON_THRESHOLD) { isOresundstag = true; break; }
    }
    if (!isOresundstag) continue;
    oresundstagCount++;
    const info = routesById.get(routeId);
    if (!info) continue;
    info.brand = "oresundstag";
    if (info.colorSource === "heuristic" || info.colorSource === "auto") {
      info.color = "a3a9ad";
      info.colorSource = "heuristic";
    }
  }
  console.log(`${oresundstagCount} linjer identifierade som Öresundståg`);

  // ============================================================
  // Bygg de tre färdiga artefakterna
  // ============================================================
  const tripLookup = {};
  for (const [tripId, routeId] of routeIdByTripId) {
    const info = routesById.get(routeId);
    if (!info) continue;
    tripLookup[tripId] = {
      line: info.shortName,
      color: info.color,
      textColor: info.textColor,
      type: info.routeType,
      brand: info.brand,
      destination: headsignByTripId.get(tripId) || "",
    };
  }

  const railLines = [];
  for (const [routeId, routeInfo] of routesById) {
    if (!isRailRouteType(routeInfo.routeType)) continue;
    if (routeInfo.brand === "oresundstag") continue;
    const shapeIds = shapeIdsByRoute.get(routeId);
    if (!shapeIds) continue;
    for (const shapeId of shapeIds) {
      const points = shapePointsById.get(shapeId);
      if (!points || points.length < 4) continue;
      railLines.push({ color: routeInfo.color, points });
    }
  }

  const trainStations = [];
  for (const stopId of railStopIds) {
    const s = stopsById.get(stopId);
    if (!s || !s.name) continue;
    trainStations.push({ name: s.name, lat: s.lat, lon: s.lon });
  }

  const builtAt = new Date().toISOString();
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, "trip_lookup.json"), JSON.stringify({ builtAt, trips: tripLookup }));
  fs.writeFileSync(path.join(OUTPUT_DIR, "rail_lines.json"), JSON.stringify({ builtAt, lines: railLines }));
  fs.writeFileSync(path.join(OUTPUT_DIR, "train_stations.json"), JSON.stringify({ builtAt, stations: trainStations }));

  return { tripCount: Object.keys(tripLookup).length, railLineCount: railLines.length, stationCount: trainStations.length };
}

buildGtfsArtifacts()
  .then((result) => {
    console.log("\nKlart!", result);
  })
  .catch((err) => {
    console.error("\nFEL vid byggning av GTFS-data:", err);
    process.exit(1);
  });
