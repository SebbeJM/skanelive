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

// GTFS-tider kan gå förbi midnatt (t.ex. "25:30:00" för 01:30 nästa dag),
// så vi räknar om till bara ett sekundtal sedan midnatt istället för att
// använda JS Date-objekt, som inte hanterar det naturligt.
function parseGtfsTimeToSeconds(timeStr) {
  if (!timeStr) return null;
  const parts = timeStr.trim().split(":");
  if (parts.length !== 3) return null;
  const h = parseInt(parts[0], 10), m = parseInt(parts[1], 10), s = parseInt(parts[2], 10);
  if (Number.isNaN(h) || Number.isNaN(m) || Number.isNaN(s)) return null;
  return h * 3600 + m * 60 + s;
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
      longName,
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
  const serviceIdByTripId = new Map();
  const shapeIdByTripId = new Map();
  // Ett exempel-trip_id per shape_id, för att kunna slå upp en
  // representativ hållplatslista senare (se "Se linje"-datan nedan).
  const tripIdByShapeId = new Map();
  const tripsText = await extractFileAsText(bytes, centralDir, "trips.txt");
  forEachCsvRow(tripsText, (cols, idx) => {
    const tripId = (cols[idx("trip_id")] || "").trim();
    const routeId = (cols[idx("route_id")] || "").trim();
    const shapeId = (cols[idx("shape_id")] || "").trim();
    const headsign = (cols[idx("trip_headsign")] || "").trim();
    const serviceId = (cols[idx("service_id")] || "").trim();
    if (tripId && routeId) routeIdByTripId.set(tripId, routeId);
    if (tripId && headsign) headsignByTripId.set(tripId, headsign);
    if (tripId && serviceId) serviceIdByTripId.set(tripId, serviceId);
    if (tripId && shapeId) shapeIdByTripId.set(tripId, shapeId);
    if (routeId && shapeId) {
      if (!shapeIdsByRoute.has(routeId)) shapeIdsByRoute.set(routeId, new Set());
      shapeIdsByRoute.get(routeId).add(shapeId);
      if (!tripIdByShapeId.has(shapeId)) tripIdByShapeId.set(shapeId, tripId);
    }
  });
  console.log(`trips.txt: ${routeIdByTripId.size} resor`);

  // ---- calendar.txt ---- (vilka veckodagar varje "service_id" går)
  // OBS: calendar_dates.txt (undantag för enskilda datum, t.ex. röda
  // dagar) läses INTE — medvetet förenklat, se kommentar vid
  // simuleringen längre ner.
  const serviceDaysById = new Map();
  const calendarText = await extractFileAsText(bytes, centralDir, "calendar.txt");
  if (calendarText) {
    forEachCsvRow(calendarText, (cols, idx) => {
      const serviceId = (cols[idx("service_id")] || "").trim();
      if (!serviceId) return;
      serviceDaysById.set(serviceId, {
        monday: cols[idx("monday")] === "1",
        tuesday: cols[idx("tuesday")] === "1",
        wednesday: cols[idx("wednesday")] === "1",
        thursday: cols[idx("thursday")] === "1",
        friday: cols[idx("friday")] === "1",
        saturday: cols[idx("saturday")] === "1",
        sunday: cols[idx("sunday")] === "1",
        startDate: (cols[idx("start_date")] || "").trim(),
        endDate: (cols[idx("end_date")] || "").trim(),
      });
    });
  }
  console.log(`calendar.txt: ${serviceDaysById.size} scheman`);

  // ---- calendar_dates.txt ---- (undantag för enskilda datum — vissa
  // linjer, det visade sig gälla Öresundståg specifikt, har ALLA
  // veckodagar satta till 0 i calendar.txt och styr istället helt via
  // enskilda datum här. Läser bara in undantag, inte hela filen som
  // en tidtabell för året — se avgränsningen till gårdag/idag/morgondag
  // längre ner.)
  const calendarDatesByService = new Map(); // service_id -> Map<"YYYYMMDD", "1"|"2">
  const calendarDatesText = await extractFileAsText(bytes, centralDir, "calendar_dates.txt");
  if (calendarDatesText) {
    forEachCsvRow(calendarDatesText, (cols, idx) => {
      const serviceId = (cols[idx("service_id")] || "").trim();
      const date = (cols[idx("date")] || "").trim();
      const exceptionType = (cols[idx("exception_type")] || "").trim();
      if (!serviceId || !date) return;
      if (!calendarDatesByService.has(serviceId)) calendarDatesByService.set(serviceId, new Map());
      calendarDatesByService.get(serviceId).set(date, exceptionType);
    });
  }
  console.log(`calendar_dates.txt: undantag för ${calendarDatesByService.size} scheman`);

  // Avgör om ett service_id är giltigt för ett SPECIFIKT datum
  // (YYYYMMDD-sträng) — kombinerar calendar.txt (veckodag + datumspann)
  // med calendar_dates.txt-undantagen ovanpå.
  const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  function isServiceValidOnDate(serviceId, yyyymmdd) {
    const exceptions = calendarDatesByService.get(serviceId);
    if (exceptions && exceptions.has(yyyymmdd)) {
      return exceptions.get(yyyymmdd) === "1";
    }
    const days = serviceDaysById.get(serviceId);
    if (!days) return false;
    if (days.startDate && yyyymmdd < days.startDate) return false;
    if (days.endDate && yyyymmdd > days.endDate) return false;
    const y = parseInt(yyyymmdd.slice(0, 4), 10), mo = parseInt(yyyymmdd.slice(4, 6), 10) - 1, d = parseInt(yyyymmdd.slice(6, 8), 10);
    const weekday = WEEKDAY_NAMES[new Date(Date.UTC(y, mo, d)).getUTCDay()];
    return !!days[weekday];
  }
  // Bara gårdagens, dagens och morgondagens datum behövs — byggjobbet
  // körs ändå dagligen, så vi slipper räkna ut hela årets giltighet.
  function yyyymmddOffset(offsetDays) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + offsetDays);
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  }
  const YESTERDAY_YYYYMMDD = yyyymmddOffset(-1);
  const TODAY_YYYYMMDD = yyyymmddOffset(0);
  const TOMORROW_YYYYMMDD = yyyymmddOffset(1);

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
      shapePointsById.set(shapeId, simplifyPoints(points.map((p) => [p.lat, p.lon]), 2));
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
  // Hela hållplatssekvensen per resa (inte bara sista) — bara för de
  // resor vi faktiskt kan behöva den för ("Se linje"-representanter),
  // avgörs efter att routeShapes byggts. Sparar allt här och plockar
  // bara ut det vi behöver senare, enklare än att förutse i förväg.
  const stopSeqByTripId = new Map();
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

      const arr = parseGtfsTimeToSeconds(cols[idx("arrival_time")]);
      const dep = parseGtfsTimeToSeconds(cols[idx("departure_time")]);
      if (!stopSeqByTripId.has(tripId)) stopSeqByTripId.set(tripId, []);
      stopSeqByTripId.get(tripId).push({ seq: seqNum, stopId, arr, dep });

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
  console.log(`${oresundstagCount} linjer identifierade som Öresundståg (geografiskt, via en dansk hållplats)`);

  // RESERVLÖSNING: om Skånetrafikens data aldrig listar några danska
  // hållplatser alls (bara sina egna svenska), skulle den geografiska
  // igenkänningen ovan ALDRIG kunna slå till. Kolla därför även om
  // själva LINJENAMNET innehåller "öresundståg" — oberoende signal.
  let oresundstagByNameCount = 0;
  for (const [routeId, info] of routesById) {
    if (info.brand === "oresundstag") continue; // redan identifierad ovan
    if (!isRailRouteType(info.routeType)) continue;
    const name = `${info.shortName} ${info.longName || ""}`.toLowerCase();
    if (!name.includes("öresundståg")) continue;
    oresundstagByNameCount++;
    info.brand = "oresundstag";
    if (info.colorSource === "heuristic" || info.colorSource === "auto") {
      info.color = "a3a9ad";
      info.colorSource = "heuristic";
    }
  }
  console.log(`${oresundstagByNameCount} YTTERLIGARE linjer identifierade som Öresundståg (via namnet, reservlösning)`);

  // TREDJE RESERVLÖSNING: samma nominella linjenummer (t.ex. "802") kan
  // ibland vara uppdelat på FLERA olika route_id i källdatan (t.ex. en
  // variant för den svenska biten av resan, en annan för den
  // gränsöverskridande biten) — bara den del som råkar ha en dansk
  // hållplats i just sin egen route_id fångas annars, medan resor som
  // använder en ANNAN route_id för samma linjenummer missas helt. Se
  // till att alla delar av samma linjenummer får samma märkning.
  const oresundstagShortNames = new Set();
  for (const info of routesById.values()) {
    if (info.brand === "oresundstag") oresundstagShortNames.add(info.shortName);
  }
  let oresundstagBySameNameCount = 0;
  for (const info of routesById.values()) {
    if (info.brand === "oresundstag") continue;
    if (!oresundstagShortNames.has(info.shortName)) continue;
    oresundstagBySameNameCount++;
    info.brand = "oresundstag";
    if (info.colorSource === "heuristic" || info.colorSource === "auto") {
      info.color = "a3a9ad";
      info.colorSource = "heuristic";
    }
  }
  console.log(`${oresundstagBySameNameCount} YTTERLIGARE linjer identifierade som Öresundståg (samma linjenummer som en redan identifierad route_id)`);

  // ---- Öresundståg-tidtabell (för simulering, eftersom realtidsdata
  // saknas helt för denna linje — se tidigare research i konversationen)
  // ----
  // FÖRENKLAT MEDVETET: calendar_dates.txt (undantag för enskilda
  // datum, t.ex. röda dagar, inställda turer) läses inte. Simuleringen
  // vet alltså inte om en specifik tur är inställd eller flyttad —
  // bara vad den vanliga veckodagen säger. Detta är en känd, accepterad
  // begränsning för att hålla det hela så enkelt som möjligt.
  const oresundstagSchedule = [];
  // Delad, avdubblad lista med sträckgeometrier — flera resor delar
  // ofta samma fysiska shape_id, så vi sparar varje unik sträcka bara
  // EN gång och låter resorna referera till den, istället för att
  // upprepa punkterna i varje enskild resa (skulle annars bli en
  // jättestor fil).
  const oresundstagShapesById = {};
  for (const [tripId, routeId] of routeIdByTripId) {
    const routeInfo = routesById.get(routeId);
    if (!routeInfo || routeInfo.brand !== "oresundstag") continue;
    const serviceId = serviceIdByTripId.get(tripId);
    if (!serviceId) continue;
    const validYesterday = isServiceValidOnDate(serviceId, YESTERDAY_YYYYMMDD);
    const validToday = isServiceValidOnDate(serviceId, TODAY_YYYYMMDD);
    const validTomorrow = isServiceValidOnDate(serviceId, TOMORROW_YYYYMMDD);
    if (!validYesterday && !validToday && !validTomorrow) continue;
    const rawStops = stopSeqByTripId.get(tripId);
    if (!rawStops || rawStops.length < 2) continue;
    const sorted = [...rawStops].sort((a, b) => a.seq - b.seq);
    const stops = [];
    for (const { stopId, arr, dep } of sorted) {
      const s = stopsById.get(stopId);
      if (!s || !s.name || arr == null || dep == null) continue;
      stops.push({ name: s.name, lat: s.lat, lon: s.lon, arr, dep });
    }
    if (stops.length < 2) continue;
    // Just DEN HÄR resans egen sträckgeometri — inte en gemensam
    // "bästa gissning" för hela linjenumret, eftersom samma
    // linjenummer (t.ex. 804) kan täcka helt olika fysiska rutter
    // (vissa slutar vid Köpenhamn, andra fortsätter till Göteborg).
    const shapeId = shapeIdByTripId.get(tripId);
    const shapePoints = shapeId ? shapePointsById.get(shapeId) : null;
    if (shapeId && shapePoints && shapePoints.length >= 2 && !oresundstagShapesById[shapeId]) {
      oresundstagShapesById[shapeId] = shapePoints;
    }
    oresundstagSchedule.push({
      tripId,
      shapeId: shapePoints ? shapeId : null,
      validYesterday, validToday, validTomorrow,
      stops,
    });
  }
  console.log(`Öresundståg-tidtabell: ${oresundstagSchedule.length} resor med fullständig schemadata (referensdatum: ${TODAY_YYYYMMDD}), ${Object.keys(oresundstagShapesById).length} unika sträckgeometrier`);

  // ============================================================
  // Bygg de tre färdiga artefakterna
  // ============================================================
  const tripLookup = {};
  let oresundstagTripCount = 0;
  for (const [tripId, routeId] of routeIdByTripId) {
    const info = routesById.get(routeId);
    if (!info) continue;
    if (info.brand === "oresundstag") oresundstagTripCount++;
    tripLookup[tripId] = {
      line: info.shortName,
      routeId,
      color: info.color,
      textColor: info.textColor,
      type: info.routeType,
      brand: info.brand,
      destination: headsignByTripId.get(tripId) || "",
    };
  }
  console.log(`DIAGNOS: ${oresundstagTripCount} resor fick brand="oresundstag" i trip_lookup.json (av totalt ${routeIdByTripId.size} resor)`);

// Avstånd (meter) från en punkt till NÄRMASTE punkt på en sträcka —
// används ENDAST för diagnostik denna gång (ingen automatisk
// filtrering), för att identifiera exakt vilken specifik sträcka som
// inte passerar Kastrup som en riktig mellanhållplats.
function minDistanceToPointMeters(points, target) {
  const [tLat, tLon] = target;
  const latRef = tLat;
  const cosLat = Math.cos((latRef * Math.PI) / 180);
  const mPerDegLat = 111320;
  const tx = tLon * cosLat * mPerDegLat, ty = tLat * mPerDegLat;
  let min = Infinity;
  for (const [lat, lon] of points) {
    const x = lon * cosLat * mPerDegLat, y = lat * mPerDegLat;
    const d = Math.hypot(x - tx, y - ty);
    if (d < min) min = d;
  }
  return min;
}

  const railLines = [];
  // Kastrups riktiga koordinater, bara för diagnostiken nedan. Söker på
  // flera möjliga namnvarianter eftersom GTFS-datan kanske inte
  // använder exakt "Kastrup" (t.ex. danska "Lufthavnen"/"Airport").
  let kastrupCoords = null;
  const kastrupNameHints = ["kastrup", "lufthavn", "airport", "cph"];
  for (const s of stopsById.values()) {
    if (!s.name) continue;
    const lower = s.name.toLowerCase();
    if (kastrupNameHints.some((hint) => lower.includes(hint))) {
      kastrupCoords = [s.lat, s.lon];
      console.log(`Kastrup-koordinater (diagnostik): hittade "${s.name}" -> ${s.lat}, ${s.lon}`);
      break;
    }
  }
  if (!kastrupCoords) {
    console.log("Kastrup-koordinater (diagnostik): HITTADES INTE ens med bredare sökning.");
    console.log("Alla danska hållplatsnamn (lon < 12.65) i datan, för felsökning:");
    for (const s of stopsById.values()) {
      if (s.name && s.lon < 12.65) console.log(`  - "${s.name}" (${s.lat}, ${s.lon})`);
    }
  }
  for (const [routeId, routeInfo] of routesById) {
    if (!isRailRouteType(routeInfo.routeType)) continue;
    const shapeIds = shapeIdsByRoute.get(routeId);
    if (!shapeIds) continue;
    for (const shapeId of shapeIds) {
      const points = shapePointsById.get(shapeId);
      if (!points || points.length < 4) continue;
      // Riktig data visade ett tydligt gap: äkta sträckor genom Kastrup
      // ligger under 230m bort, medan allt annat (spikraka genvägar,
      // eller helt andra långdistans-varianter som ändå inte är
      // relevanta på en Skåne-fokuserad karta) ligger 7000m+ bort.
      // 1000m är därför en trygg, datadriven gräns — inte en gissning.
      if (routeInfo.brand === "oresundstag") {
        if (!kastrupCoords) continue;
        const dist = minDistanceToPointMeters(points, kastrupCoords);
        if (dist > 1000) continue;
      }
      railLines.push({ color: routeInfo.color, points });
    }
  }

  const trainStations = [];
  for (const stopId of railStopIds) {
    const s = stopsById.get(stopId);
    if (!s || !s.name) continue;
    trainStations.push({ name: s.name, lat: s.lat, lon: s.lon });
  }

  // Alla hållplatser (mestadels bussar) — allt utom de vi redan räknat
  // som tågstationer ovan, så vi inte får dubbletter. Bara namn+position,
  // ingen extra data, för att hålla filen så liten som möjligt trots
  // de över 10 000 hållplatserna.
  const busStops = [];
  for (const [stopId, s] of stopsById) {
    if (!s.name) continue;
    if (railStopIds.has(stopId)) continue;
    busStops.push({ name: s.name, lat: s.lat, lon: s.lon });
  }

  // Ruttdata per linje (för "Se linje"-knappen när man följer en resa) —
  // EN representativ sträcka (den med flest punkter, dvs mest detaljerad)
  // per linje, plus hela hållplatslistan i ordning för just den sträckan.
  // Bygger på samma stop_times-genomgång som gjordes för tåg tidigare,
  // fast nu för ALLA linjer (bussar också).
  const routeShapes = {};
  for (const [routeId, routeInfo] of routesById) {
    const shapeIds = shapeIdsByRoute.get(routeId);
    if (!shapeIds || shapeIds.size === 0) continue;
    let bestShapeId = null, bestPoints = null;
    // För Öresundståg specifikt: samma kvalitetskontroll som
    // rail_lines.json använder (måste passera nära Kastrup) — annars
    // kunde en av de bristfälliga/raka sträckorna råka bli "bäst" här
    // bara för att den har flest punkter, trots att den inte alls
    // följer den riktiga rutten. Bland de sträckor som klarar kollen
    // väljs sedan den mest detaljerade.
    const isOresundstag = routeInfo.brand === "oresundstag";
    let bestIsGood = false;
    for (const shapeId of shapeIds) {
      const points = shapePointsById.get(shapeId);
      if (!points) continue;
      const isGood = !isOresundstag || (kastrupCoords && minDistanceToPointMeters(points, kastrupCoords) <= 1500);
      if (!bestPoints || (isGood && !bestIsGood) || (isGood === bestIsGood && points.length > bestPoints.length)) {
        bestShapeId = shapeId;
        bestPoints = points;
        bestIsGood = isGood;
      }
    }
    if (!bestPoints || bestPoints.length < 2) continue;

    // Hållplatslistan för samma representativa resa som sträckan kom
    // ifrån (via tripIdByShapeId), i rätt ordning.
    const repTripId = tripIdByShapeId.get(bestShapeId);
    const rawStops = repTripId ? stopSeqByTripId.get(repTripId) : null;
    const stops = [];
    if (rawStops) {
      const sorted = [...rawStops].sort((a, b) => a.seq - b.seq);
      for (const { stopId } of sorted) {
        const s = stopsById.get(stopId);
        if (s && s.name) stops.push({ name: s.name, lat: s.lat, lon: s.lon });
      }
    }

    // Nycklar på det UNIKA route_id, inte det visade linjenumret —
    // annars kunde helt orelaterade linjer på andra sidan Skåne som
    // råkar dela samma visade nummer (t.ex. "5") blandas ihop med
    // varandra. Varje route_id representerar en helt egen, riktig linje.
    routeShapes[routeId] = {
      color: routeInfo.color,
      points: bestPoints,
      stops,
    };
  }

  const builtAt = new Date().toISOString();
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, "trip_lookup.json"), JSON.stringify({ builtAt, trips: tripLookup }));
  fs.writeFileSync(path.join(OUTPUT_DIR, "rail_lines.json"), JSON.stringify({ builtAt, lines: railLines }));
  fs.writeFileSync(path.join(OUTPUT_DIR, "train_stations.json"), JSON.stringify({ builtAt, stations: trainStations }));
  fs.writeFileSync(path.join(OUTPUT_DIR, "bus_stops.json"), JSON.stringify({ builtAt, stops: busStops }));
  fs.writeFileSync(path.join(OUTPUT_DIR, "route_shapes.json"), JSON.stringify({ builtAt, routes: routeShapes }));
  fs.writeFileSync(path.join(OUTPUT_DIR, "oresundstag_schedule.json"), JSON.stringify({ builtAt, trips: oresundstagSchedule, shapes: oresundstagShapesById }));

  return {
    tripCount: Object.keys(tripLookup).length,
    railLineCount: railLines.length,
    stationCount: trainStations.length,
    busStopCount: busStops.length,
    routeShapeCount: Object.keys(routeShapes).length,
    oresundstagScheduleCount: oresundstagSchedule.length,
  };
}

buildGtfsArtifacts()
  .then((result) => {
    console.log("\nKlart!", result);
  })
  .catch((err) => {
    console.error("\nFEL vid byggning av GTFS-data:", err);
    process.exit(1);
  });
