/**
 * Đo khoảng cách khảo sát thực tế (WGS84) bằng Turf.js.
 * Dọc polyline GPS / đường vẽ — không lấy đường thẳng bến↔bến.
 */
import * as turf from '@turf/turf';

function toLatLng(point) {
  if (!point || typeof point !== 'object') return null;
  const lat = Number(point.lat);
  const lng = Number(point.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

/** Khoảng cách giữa 2 điểm (mét) — turf.distance / Haversine WGS84. */
export function distanceMeters(a, b) {
  const p1 = toLatLng(a);
  const p2 = toLatLng(b);
  if (!p1 || !p2) return 0;
  return turf.distance(
    turf.point([p1.lng, p1.lat]),
    turf.point([p2.lng, p2.lat]),
    { units: 'meters' },
  );
}

/** Tổng chiều dài polyline (mét). */
export function pathLengthMeters(points) {
  const coords = [];
  for (const point of Array.isArray(points) ? points : []) {
    const p = toLatLng(point);
    if (!p) continue;
    // Bỏ điểm trùng sát (nhiễu GPS 0-length).
    const prev = coords[coords.length - 1];
    if (prev && prev[0] === p.lng && prev[1] === p.lat) continue;
    coords.push([p.lng, p.lat]);
  }
  if (coords.length < 2) return 0;
  return turf.length(turf.lineString(coords), { units: 'meters' });
}

export const routeLength = pathLengthMeters;
