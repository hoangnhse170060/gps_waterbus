/**
 * Đo khoảng cách khảo sát (WGS84) — ưu tiên Turf.js nếu đã load CDN.
 * Browser: window.turf · fallback haversine cùng bán kính mean.
 */
(function initGeoDistance(global) {
  const EARTH_RADIUS_M = 6371008.8;

  function toLatLng(point) {
    if (!point || typeof point !== 'object') return null;
    const lat = Number(point.lat);
    const lng = Number(point.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  }

  function haversineMeters(a, b) {
    const p1 = toLatLng(a);
    const p2 = toLatLng(b);
    if (!p1 || !p2) return 0;
    const toRad = (value) => (value * Math.PI) / 180;
    const lat1 = toRad(p1.lat);
    const lat2 = toRad(p2.lat);
    const dLat = lat2 - lat1;
    const dLng = toRad(p2.lng - p1.lng);
    const h = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
  }

  function turfDistanceMeters(a, b) {
    const turf = global.turf;
    const p1 = toLatLng(a);
    const p2 = toLatLng(b);
    if (!p1 || !p2) return 0;
    if (!turf?.distance || !turf?.point) return haversineMeters(p1, p2);
    return turf.distance(
      turf.point([p1.lng, p1.lat]),
      turf.point([p2.lng, p2.lat]),
      { units: 'meters' },
    );
  }

  function turfPathLengthMeters(points) {
    const turf = global.turf;
    const coords = [];
    for (const point of Array.isArray(points) ? points : []) {
      const p = toLatLng(point);
      if (!p) continue;
      const prev = coords[coords.length - 1];
      if (prev && prev[0] === p.lng && prev[1] === p.lat) continue;
      coords.push([p.lng, p.lat]);
    }
    if (coords.length < 2) return 0;
    if (turf?.length && turf?.lineString) {
      return turf.length(turf.lineString(coords), { units: 'meters' });
    }
    let total = 0;
    for (let i = 1; i < coords.length; i += 1) {
      total += haversineMeters(
        { lat: coords[i - 1][1], lng: coords[i - 1][0] },
        { lat: coords[i][1], lng: coords[i][0] },
      );
    }
    return total;
  }

  global.GeoDistance = {
    EARTH_RADIUS_M,
    distanceMeters: turfDistanceMeters,
    pathLengthMeters: turfPathLengthMeters,
    haversineMeters,
  };
})(typeof window !== 'undefined' ? window : globalThis);
