/**
 * Hành lang sông Waterbus — dùng cho cứu hộ / về bến XP (không đi thẳng cắt đất).
 */
import { distanceMeters, routeLength } from './geo-distance.js';

export const WATERBUS_CORRIDOR_CODES = [
  'ST-BD', 'ST-TT', 'ST-BA', 'ST-TD2', 'ST-TD', 'ST-HBC', 'ST-LD',
];

function toPoint(p) {
  const lat = Number(p?.lat);
  const lng = Number(p?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

export function bearingDegrees(a, b) {
  const p1 = toPoint(a);
  const p2 = toPoint(b);
  if (!p1 || !p2) return 0;
  const lat1 = (p1.lat * Math.PI) / 180;
  const lat2 = (p2.lat * Math.PI) / 180;
  const dLng = ((p2.lng - p1.lng) * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function pointAtDistance(points, targetMeters) {
  const path = (points || []).map(toPoint).filter(Boolean);
  if (path.length < 1) return { lat: 0, lng: 0, heading: 0 };
  if (path.length === 1) return { ...path[0], heading: 0 };
  let travelled = 0;
  const target = Math.max(0, Number(targetMeters) || 0);
  for (let i = 1; i < path.length; i += 1) {
    const start = path[i - 1];
    const end = path[i];
    const segment = distanceMeters(start, end);
    if (travelled + segment >= target) {
      const ratio = segment === 0 ? 0 : (target - travelled) / segment;
      return {
        lat: start.lat + (end.lat - start.lat) * ratio,
        lng: start.lng + (end.lng - start.lng) * ratio,
        heading: bearingDegrees(start, end),
      };
    }
    travelled += segment;
  }
  const previous = path.at(-2) || path[0];
  const last = path.at(-1);
  return { lat: last.lat, lng: last.lng, heading: bearingDegrees(previous, last) };
}

/** Polyline hành lang từ danh sách bến theo thứ tự Waterbus. */
export function corridorFromStations(stations = []) {
  const byCode = new Map();
  for (const s of stations || []) {
    const code = String(s?.stationCode || '').toUpperCase();
    const p = toPoint(s);
    if (!code || !p) continue;
    byCode.set(code, p);
  }
  return WATERBUS_CORRIDOR_CODES
    .map((code) => byCode.get(code))
    .filter(Boolean);
}

/**
 * Ưu tiên: OSM Saigon Waterbus (vạch sông) → Neon gần corridor → nối bến.
 */
export function resolveRiverBasePath({ stations = [], routes = [], osmCorridor = [] } = {}) {
  const osm = smoothCorridorSpikes((osmCorridor || []).map(toPoint).filter(Boolean));
  if (osm.length >= 2) return osm;

  const corridor = corridorFromStations(stations);
  let best = null;
  let bestScore = -1;
  for (const route of routes || []) {
    const coords = (route.coordinates || []).map(toPoint).filter(Boolean);
    if (coords.length < 2) continue;
    const len = routeLength(coords);
    if (!(len > 200) || len > 80_000) continue;
    // Điểm giữa corridor phải gần path.
    let nearHits = 0;
    for (const c of corridor) {
      const proj = projectOnPath(coords, c);
      if (proj && proj.distMeters <= 350) nearHits += 1;
    }
    const score = nearHits * 1e6 + len;
    if (score > bestScore) {
      bestScore = score;
      best = coords;
    }
  }
  if (best && bestScore >= 1e6) return smoothCorridorSpikes(best);
  if (corridor.length >= 2) return corridor;
  return best ? smoothCorridorSpikes(best) : [];
}

/** Bỏ đỉnh đâm vào cầu tàu (góc V / quay đầu) trên corridor. */
export function smoothCorridorSpikes(path, { minTurnDeg = 70, minDetourM = 12 } = {}) {
  let pts = (path || []).map(toPoint).filter(Boolean);
  if (pts.length < 3) return pts;
  for (let pass = 0; pass < 12; pass += 1) {
    const keep = pts.map(() => true);
    let removed = 0;
    for (let i = 1; i < pts.length - 1; i += 1) {
      const turn = turnDegrees(pts[i - 1], pts[i], pts[i + 1]);
      const via = distanceMeters(pts[i - 1], pts[i]) + distanceMeters(pts[i], pts[i + 1]);
      const chord = Math.max(1, distanceMeters(pts[i - 1], pts[i + 1]));
      if (turn >= minTurnDeg && via > chord * 1.12 && via - chord >= minDetourM) {
        keep[i] = false;
        removed += 1;
      }
    }
    if (!removed) break;
    pts = pts.filter((_, i) => keep[i]);
  }
  return pts;
}

function turnDegrees(a, b, c) {
  const b1 = bearingDegrees(a, b);
  const b2 = bearingDegrees(b, c);
  const d = Math.abs(b1 - b2) % 360;
  return Math.min(d, 360 - d);
}

/** Chiếu điểm lên polyline → vị trí gần nhất + alongMeters. */
export function projectOnPath(path, point) {
  const pts = (path || []).map(toPoint).filter(Boolean);
  const p = toPoint(point);
  if (!p || pts.length < 1) return null;
  if (pts.length === 1) {
    return {
      lat: pts[0].lat,
      lng: pts[0].lng,
      alongMeters: 0,
      distMeters: distanceMeters(p, pts[0]),
      segIndex: 0,
    };
  }

  let best = null;
  let travelled = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    const segLen = distanceMeters(a, b);
    let t = 0;
    if (segLen > 0.01) {
      // Projection trên đoạn AB (approx equirectangular).
      const ax = a.lng;
      const ay = a.lat;
      const bx = b.lng;
      const by = b.lat;
      const px = p.lng;
      const py = p.lat;
      const abx = bx - ax;
      const aby = by - ay;
      const apx = px - ax;
      const apy = py - ay;
      t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / (abx * abx + aby * aby)));
    }
    const lat = a.lat + (b.lat - a.lat) * t;
    const lng = a.lng + (b.lng - a.lng) * t;
    const distMeters = distanceMeters(p, { lat, lng });
    const alongMeters = travelled + segLen * t;
    if (!best || distMeters < best.distMeters) {
      best = { lat, lng, alongMeters, distMeters, segIndex: i - 1, t };
    }
    travelled += segLen;
  }
  return best;
}

function densifySegment(a, b, stepMeters = 40) {
  const out = [];
  const dist = distanceMeters(a, b);
  if (!(dist > stepMeters)) return out;
  const n = Math.min(40, Math.floor(dist / stepMeters));
  for (let i = 1; i < n; i += 1) {
    const t = i / n;
    out.push({
      lat: a.lat + (b.lat - a.lat) * t,
      lng: a.lng + (b.lng - a.lng) * t,
    });
  }
  return out;
}

/** Lấy đoạn path từ alongA → alongB (xuôi hoặc ngược). */
export function slicePathByAlong(path, alongA, alongB, stepMeters = 45) {
  const pts = (path || []).map(toPoint).filter(Boolean);
  if (pts.length < 2) return pts.slice();
  const len = routeLength(pts);
  let a = Math.max(0, Math.min(len, Number(alongA) || 0));
  let b = Math.max(0, Math.min(len, Number(alongB) || 0));
  const reverse = b < a;
  if (reverse) {
    const tmp = a;
    a = b;
    b = tmp;
  }

  const out = [];
  const startPt = pointAtDistance(pts, a);
  out.push({ lat: startPt.lat, lng: startPt.lng });
  let cursor = a + stepMeters;
  while (cursor < b - 1) {
    const p = pointAtDistance(pts, cursor);
    out.push({ lat: p.lat, lng: p.lng });
    cursor += stepMeters;
  }
  const endPt = pointAtDistance(pts, b);
  out.push({ lat: endPt.lat, lng: endPt.lng });
  if (reverse) out.reverse();
  return out;
}

/**
 * Đường đi bo sông từ `from` → `to`:
 * vào corridor (nếu lệch) → chạy dọc hành lang → ra tới đích.
 * `corridorOnly`: không đâm nhánh V vào cầu tàu — chỉ chạy trên vạch sông.
 */
export function buildRiverPath(from, to, basePath, { joinMeters = 80, corridorOnly = false } = {}) {
  const start = toPoint(from);
  const end = toPoint(to);
  if (!start || !end) return { coordinates: [], lengthMeters: 0 };

  const base = (basePath || []).map(toPoint).filter(Boolean);
  if (base.length < 2) {
    const coordinates = [start, ...densifySegment(start, end, 50), end];
    return { coordinates, lengthMeters: routeLength(coordinates) };
  }

  const projStart = projectOnPath(base, start);
  const projEnd = projectOnPath(base, end);
  if (!projStart || !projEnd) {
    const coordinates = [start, end];
    return { coordinates, lengthMeters: distanceMeters(start, end) };
  }

  const coordinates = [];
  // Vào sông nếu đang lệch corridor (cứu hộ từ đất). Trip: corridorOnly → không stub.
  if (!corridorOnly && projStart.distMeters > joinMeters) {
    coordinates.push(start);
    coordinates.push(...densifySegment(start, projStart, 40));
  }
  coordinates.push({ lat: projStart.lat, lng: projStart.lng });

  const alongSlice = slicePathByAlong(base, projStart.alongMeters, projEnd.alongMeters, 45);
  for (const p of alongSlice) {
    const last = coordinates[coordinates.length - 1];
    if (!last || distanceMeters(last, p) > 8) coordinates.push(p);
  }

  // Ra bến chỉ khi thật sự lệch và không bật corridorOnly.
  // (Trước đây luôn push `end` → tạo góc V đâm vào cầu tàu.)
  if (!corridorOnly && projEnd.distMeters > joinMeters) {
    coordinates.push(...densifySegment(projEnd, end, 40));
    coordinates.push(end);
  }

  // Gỡ điểm trùng.
  const cleaned = [];
  for (const p of coordinates) {
    const last = cleaned[cleaned.length - 1];
    if (!last || distanceMeters(last, p) > 3) cleaned.push(p);
  }
  if (cleaned.length < 2) {
    cleaned.push({ lat: projEnd.lat, lng: projEnd.lng });
  }

  return {
    coordinates: cleaned,
    lengthMeters: routeLength(cleaned),
  };
}

export function advanceAlongCoordinates(coordinates, progressMeters, stepMeters) {
  const lengthMeters = routeLength(coordinates || []);
  const nextProgress = Math.min(lengthMeters, Math.max(0, Number(progressMeters) || 0) + Math.max(0, Number(stepMeters) || 0));
  const point = pointAtDistance(coordinates, nextProgress);
  return {
    progressMeters: nextProgress,
    lengthMeters,
    lat: point.lat,
    lng: point.lng,
    heading: point.heading,
    remainingMeters: Math.max(0, lengthMeters - nextProgress),
    arrived: nextProgress >= lengthMeters - 2,
  };
}
