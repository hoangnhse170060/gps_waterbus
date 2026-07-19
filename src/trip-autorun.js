/**
 * GPS tự chạy trip theo lịch BE.
 * Poll GET /api/gps/trips/due → chạy routeGeometry → POST locations + tripId
 * → POST /api/gps/trips/{tripId}/complete
 */
import { distanceMeters, routeLength } from './geo-distance.js';
import {
  advanceAlongCoordinates,
  buildRiverPath,
  projectOnPath,
  resolveRiverBasePath,
  slicePathByAlong,
} from './river-corridor.js';

const ACTIVE_TRIP_STATUSES = new Set([
  'Pending',
  'ToDeparture', // chạy về bến xuất phát của lịch trước khi boarding/chạy tuyến
  'Boarding',
  'Running',
  'WaitingAtStop',
  'Paused',
]);

// Khớp Live FE: Arriving sớm hơn, Arrived sát bến (không báo cập bến khi còn ngoài sông).
const STOP_ARRIVING_M = 120;
const STOP_ARRIVED_M = 28;
const STOP_DEPART_M = 45;
const TO_DEPARTURE_ARRIVE_M = 35;
const COMPLETED_TTL_MS = 30 * 60 * 1000;

export function createTripAutorun(ctx) {
  const {
    state,
    env,
    parseBool,
    cleanOptionalText,
    clampSpeedToBoatMax,
    maxSpeedForBoatCode,
    routeLengthFn = routeLength,
    distanceMetersFn = distanceMeters,
    pointAtDistance,
    parseRouteCoordinates,
    requestTargetApi,
    publishLiveGpsPosition,
    isBoatInActiveRescueMission,
    hasOpenIncidentForBoat,
    isActiveBoatCode,
    deviceIdForBoat,
    boatByIdOrCode,
    normalizeBoatStatus,
    effectiveBoatStatus,
    formatRecordedAt,
  } = ctx;

  let pollBusy = false;
  let tickBusy = false;
  /** Sau 401/403: tạm dừng poll due (ms epoch) — tránh spam log mỗi 30s. */
  let dueAuthBlockedUntil = 0;
  let dueAuthLastWarnAt = 0;

  function tripAutorunEnabled() {
    return parseBool(env.TRIP_AUTORUN ?? 'true');
  }

  function dueAuthBackoffMs() {
    return Math.max(60_000, Number(env.TRIP_DUE_AUTH_BACKOFF_MS || 10 * 60 * 1000));
  }

  function noteDueAuthFailure(status, error) {
    const now = Date.now();
    dueAuthBlockedUntil = now + dueAuthBackoffMs();
    if (now - dueAuthLastWarnAt < 60_000) return;
    dueAuthLastWarnAt = now;
    const mins = Math.round(dueAuthBackoffMs() / 60_000);
    console.warn(
      `[trip-gps] BE ${status || '401'} trên /trips/due — LIVE_HOOK_SECRET local ≠ secret Azure. `
      + `Tạm dừng poll ${mins} phút. Đồng bộ App Setting LIVE_HOOK_SECRET trên BE rồi restart. `
      + `(${error || 'empty body'})`,
    );
  }

  function clearDueAuthFailure() {
    dueAuthBlockedUntil = 0;
  }

  function lookAheadMinutes() {
    return Math.max(5, Number(env.TRIP_LOOKAHEAD_MINUTES || 120));
  }

  function duePath() {
    return String(env.TRIP_DUE_PATH || '/api/gps/trips/due').trim() || '/api/gps/trips/due';
  }

  function completePath(tripId) {
    const template = String(env.TRIP_COMPLETE_PATH || '/api/gps/trips/{tripId}/complete').trim()
      || '/api/gps/trips/{tripId}/complete';
    return template.replace('{tripId}', encodeURIComponent(tripId));
  }

  function isBoatInActiveTripMission(boatCode) {
    const code = String(boatCode || '').trim();
    if (!code) return false;
    for (const mission of state.tripMissions.values()) {
      if (!ACTIVE_TRIP_STATUSES.has(String(mission.status || ''))) continue;
      if (String(mission.boatCode || '').trim() === code) return true;
    }
    return false;
  }

  function tripMissionPublic(mission) {
    if (!mission) return null;
    return {
      tripId: mission.tripId,
      boatCode: mission.boatCode,
      routeCode: mission.routeCode,
      status: mission.status,
      departureTime: mission.departureTime,
      arrivalTime: mission.arrivalTime,
      progressMeters: round1(mission.progressMeters),
      lengthMeters: round1(mission.lengthMeters),
      speedKmh: round1(mission.speedKmh),
      maxSpeedKmh: mission.maxSpeedKmh,
      requiredSpeedKmh: round1(mission.requiredSpeedKmh),
      currentLat: mission.currentLat == null ? null : Number(mission.currentLat),
      currentLng: mission.currentLng == null ? null : Number(mission.currentLng),
      stopIndex: mission.stopIndex ?? 0,
      // FE / BE schedule fields
      nextStationId: mission.nextStationId || null,
      nextStopCode: mission.nextStopCode || null,
      nextStopName: mission.nextStopName || null,
      nextStationName: mission.nextStopName || null,
      nextStopDistanceKm: round3(mission.nextStopDistanceKm),
      nextStopEtaMin: round1(mission.nextStopEtaMin),
      remainingDistanceKmToNextStation: round3(mission.nextStopDistanceKm),
      remainingMinutesToNextStation: round1(mission.nextStopEtaMin),
      nextStopPlannedArrivalAt: mission.nextStopPlannedArrivalAt || null,
      remainingDistanceKm: round3(mission.remainingDistanceKm),
      remainingEtaMin: round1(mission.remainingEtaMin),
      movementStatus: mission.movementStatus || null,
      lastError: mission.lastError || null,
      completedAt: mission.completedAt || null,
      updatedAt: mission.updatedAt || null,
    };
  }

  function tripMissionsPublic() {
    return [...state.tripMissions.values()].map(tripMissionPublic);
  }

  function parseTimeMs(value) {
    if (value == null || value === '') return NaN;
    if (typeof value === 'number' && Number.isFinite(value)) {
      // epoch giây → ms
      return value < 1e12 ? value * 1000 : value;
    }
    const raw = String(value).trim();
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : NaN;
  }

  /** Chuẩn hoá lat/lng — sửa swap (lat=106, lng=10) thường gặp từ BE. */
  function sanitizeLatLng(lat, lng) {
    let la = Number(lat);
    let lo = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
    if (Math.abs(la) > 90 && Math.abs(lo) <= 90) {
      const tmp = la;
      la = lo;
      lo = tmp;
    }
    if (Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
    return { lat: la, lng: lo };
  }

  function latLngFromArrayPair(a, b) {
    const x = Number(a);
    const y = Number(b);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    // VN: lng ~102–110, lat ~8–24
    if (x >= 100 && x <= 120 && y >= 5 && y <= 25) return sanitizeLatLng(y, x);
    if (y >= 100 && y <= 120 && x >= 5 && x <= 25) return sanitizeLatLng(x, y);
    if (Math.abs(x) > 90 && Math.abs(y) <= 90) return sanitizeLatLng(y, x);
    if (Math.abs(y) > 90 && Math.abs(x) <= 90) return sanitizeLatLng(x, y);
    // Mặc định GeoJSON [lng, lat]
    return sanitizeLatLng(y, x);
  }

  function normalizeDueTrips(data) {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.items)) return data.items;
    if (Array.isArray(data.trips)) return data.trips;
    if (Array.isArray(data.data)) return data.data;
    if (data.tripId || data.TripId) return [data];
    return [];
  }

  function parseTripCoordinates(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) {
      const out = [];
      for (const point of raw) {
        if (Array.isArray(point) && point.length >= 2) {
          const pair = latLngFromArrayPair(point[0], point[1]);
          if (pair) out.push(pair);
          continue;
        }
        const pair = sanitizeLatLng(
          point?.lat ?? point?.Latitude ?? point?.latitude,
          point?.lng ?? point?.lon ?? point?.Longitude ?? point?.longitude,
        );
        if (pair) out.push(pair);
      }
      return out;
    }
    try {
      return parseRouteCoordinates(raw)
        .map((p) => sanitizeLatLng(p.lat, p.lng))
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  function normalizeStops(rawStops) {
    if (!Array.isArray(rawStops)) return [];
    return rawStops.map((stop, index) => {
      const pair = sanitizeLatLng(
        stop.lat ?? stop.Latitude ?? stop.latitude,
        stop.lng ?? stop.lon ?? stop.Longitude ?? stop.longitude,
      );
      return {
        stationId: cleanOptionalText(stop.stationId || stop.StationId) || null,
        stationCode: cleanOptionalText(stop.stationCode || stop.StationCode) || null,
        stationName: cleanOptionalText(stop.stationName || stop.StationName) || null,
        stopOrder: Number(stop.stopOrder ?? stop.StopOrder) || index + 1,
        lat: pair?.lat ?? null,
        lng: pair?.lng ?? null,
        plannedArrivalTime: stop.plannedArrivalTime || stop.PlannedArrivalTime || stop.arrivalTime || null,
        plannedDepartureTime: stop.plannedDepartureTime || stop.PlannedDepartureTime || stop.departureTime || null,
      };
    }).sort((a, b) => a.stopOrder - b.stopOrder);
  }

  function tripSnapToRiverEnabled() {
    // Mặc định OFF — tàu phải bám đúng đường đã vẽ (routeGeometry / Neon), không ép OSM corridor.
    return String(env.TRIP_SNAP_TO_RIVER || '').trim().toLowerCase() === 'true';
  }

  function resolveCoordinatesForTrip(row) {
    let fromPayload = parseTripCoordinates(
      row.routeGeometry || row.RouteGeometry || row.geometry || row.coordinates,
    );
    // Geometry lỗi (đoạn xuyên địa cầu) → bỏ, lấy Neon.
    if (fromPayload.length >= 2) {
      const len = routeLengthFn(fromPayload);
      if (len > 0 && len <= 80_000) {
        return maybeSnapTripPath(fromPayload, normalizeStops(row.stops || row.Stops || []));
      }
      console.warn(`[trip-gps] routeGeometry bất thường ${Math.round(len)}m — fallback Neon`);
      fromPayload = [];
    }

    const routeCode = cleanOptionalText(row.routeCode || row.RouteCode);
    if (!routeCode) return fromPayload;
    for (const route of state.routes.values()) {
      if (String(route.routeCode || '').trim() !== routeCode) continue;
      const coords = Array.isArray(route.coordinates) ? route.coordinates : [];
      const cleaned = coords
        .map((p) => sanitizeLatLng(p.lat, p.lng))
        .filter(Boolean);
      if (cleaned.length >= 2) {
        return maybeSnapTripPath(cleaned, normalizeStops(row.stops || row.Stops || []));
      }
    }
    return fromPayload;
  }

  function maybeSnapTripPath(coordinates, stops = []) {
    if (!tripSnapToRiverEnabled()) return coordinates;
    return snapTripPathToRiver(coordinates, stops);
  }

  /** Optional: ép tuyến trip lên vạch sông (TRIP_SNAP_TO_RIVER=true). Mặc định giữ path vẽ. */
  function snapTripPathToRiver(coordinates, stops = []) {
    const base = resolveRiverBasePath({
      stations: state.stations || [],
      routes: [...state.routes.values()],
      osmCorridor: state.osmWaterbusCorridor || [],
    });
    if (base.length < 2) return coordinates;

    const stopPts = (stops || [])
      .filter((s) => Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng)))
      .map((s) => ({ lat: Number(s.lat), lng: Number(s.lng) }));

    const anchors = stopPts.length >= 2
      ? stopPts
      : [
        coordinates[0],
        coordinates[coordinates.length - 1],
      ].filter((p) => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)));

    if (anchors.length < 2) return coordinates;

    const projs = anchors.map((a) => projectOnPath(base, a)).filter(Boolean);
    if (projs.length < 2) return coordinates;

    const out = [];
    for (let i = 0; i < projs.length - 1; i += 1) {
      const slice = slicePathByAlong(
        base,
        projs[i].alongMeters,
        projs[i + 1].alongMeters,
        40,
      );
      for (const p of slice) {
        const last = out[out.length - 1];
        if (!last || distanceMetersFn(last, p) > 5) out.push({ lat: p.lat, lng: p.lng });
      }
    }
    if (out.length < 2) return coordinates;
    const snappedLen = routeLengthFn(out);
    if (!(snappedLen > 50) || snappedLen > 80_000) return coordinates;
    return out;
  }

  /** Mission cũ: chỉ snap corridor khi bật TRIP_SNAP_TO_RIVER. */
  function ensureMissionCorridorPath(mission) {
    if (!mission || mission.corridorSnapped) return;
    if (!tripSnapToRiverEnabled()) {
      mission.corridorSnapped = true;
      return;
    }
    const snapped = snapTripPathToRiver(mission.coordinates || [], mission.stops || []);
    if (snapped.length < 2) {
      mission.corridorSnapped = true;
      return;
    }
    const prevProgress = Number(mission.progressMeters) || 0;
    const prevLen = Number(mission.lengthMeters) || routeLengthFn(mission.coordinates || []);
    const ratio = prevLen > 10 ? Math.min(1, prevProgress / prevLen) : 0;
    mission.coordinates = snapped;
    mission.lengthMeters = routeLengthFn(snapped);
    mission.progressMeters = Math.min(mission.lengthMeters, ratio * mission.lengthMeters);
    const point = pointAtDistance(snapped, mission.progressMeters);
    mission.currentLat = point.lat;
    mission.currentLng = point.lng;
    mission.lastHeading = point.heading || mission.lastHeading || 0;
    mission.corridorSnapped = true;
    console.log(
      `[trip-gps] ${mission.boatCode} path bo sông (TRIP_SNAP_TO_RIVER): ${snapped.length} pts · ${Math.round(mission.lengthMeters)}m`,
    );
  }

  function resolveLengthMeters(row, coordinates) {
    const geoLen = coordinates.length >= 2 ? routeLengthFn(coordinates) : 0;
    if (geoLen > 10 && geoLen <= 80_000) return geoLen;
    const baseKm = Number(row.baseDistanceKm ?? row.BaseDistanceKm);
    if (Number.isFinite(baseKm) && baseKm > 0 && baseKm <= 80) return baseKm * 1000;
    // Fallback: tổng đoạn thẳng giữa các bến có toạ độ.
    return Math.max(geoLen > 10 ? Math.min(geoLen, 80_000) : 0, estimateStopsLengthMeters(row));
  }

  function estimateStopsLengthMeters(row) {
    const stops = normalizeStops(row.stops || row.Stops || []);
    let sum = 0;
    for (let i = 1; i < stops.length; i += 1) {
      const a = stops[i - 1];
      const b = stops[i];
      if (!Number.isFinite(a.lat) || !Number.isFinite(b.lat)) continue;
      sum += distanceMetersFn(
        { lat: a.lat, lng: a.lng },
        { lat: b.lat, lng: b.lng },
      );
    }
    return sum;
  }

  /** Neo progress vào điểm path gần vị trí hub hiện tại — tránh teleport về đầu tuyến. */
  function seedProgressFromHub(mission) {
    const hub = state.hubBoats.get(mission.boatCode);
    const lat = Number(hub?.lat);
    const lng = Number(hub?.lng);
    const coords = mission.coordinates || [];
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || coords.length < 2) return;
    let bestAlong = 0;
    let bestDist = Infinity;
    let travelled = 0;
    for (let i = 0; i < coords.length; i += 1) {
      if (i > 0) travelled += distanceMetersFn(coords[i - 1], coords[i]);
      const d = distanceMetersFn(coords[i], { lat, lng });
      if (d < bestDist) {
        bestDist = d;
        bestAlong = travelled;
      }
    }
    // Chỉ neo khi đang gần path (≤ 400m) — tránh nhảy nếu GPS lệch xa.
    if (bestDist <= 400) {
      mission.progressMeters = Math.min(Number(mission.lengthMeters) || bestAlong, bestAlong);
      const point = pointAtDistance(coords, mission.progressMeters);
      mission.currentLat = point.lat;
      mission.currentLng = point.lng;
      mission.lastHeading = point.heading || mission.lastHeading || 0;
    }
  }

  async function fetchDueTrips({ boatCode, lookAheadMinutes: lookAhead, silent = false } = {}) {
    const code = cleanOptionalText(boatCode);
    if (!code) return { ok: false, trips: [], error: 'missing boatCode' };
    const minutes = Number.isFinite(Number(lookAhead)) ? Number(lookAhead) : lookAheadMinutes();
    const path = `${duePath()}?boatCode=${encodeURIComponent(code)}&lookAheadMinutes=${encodeURIComponent(String(minutes))}`;
    const result = await requestTargetApi({
      method: 'GET',
      pathname: path,
      auth: 'hook',
      silent,
    });
    if (!result.ok) {
      if (result.status === 401 || result.status === 403) {
        noteDueAuthFailure(result.status, result.error);
      }
      return { ok: false, trips: [], status: result.status, error: result.error, data: result.data };
    }
    clearDueAuthFailure();
    return {
      ok: true,
      trips: normalizeDueTrips(result.data),
      status: result.status,
      data: result.data,
    };
  }

  async function completeTripOnBe(tripId, body = null) {
    const id = cleanOptionalText(tripId);
    if (!id) return { ok: false, error: 'missing tripId' };
    return requestTargetApi({
      method: 'POST',
      pathname: completePath(id),
      payload: body || {
        boatCode: null,
        completedAt: formatRecordedAt ? formatRecordedAt(new Date()) : new Date().toISOString(),
      },
      auth: 'hook',
    });
  }

  function stopEventPath(tripId, stationId) {
    const template = String(env.TRIP_STOP_EVENT_PATH || '/api/gps/trips/{tripId}/stops/{stationId}/event').trim()
      || '/api/gps/trips/{tripId}/stops/{stationId}/event';
    return template
      .replace('{tripId}', encodeURIComponent(tripId))
      .replace('{stationId}', encodeURIComponent(stationId));
  }

  async function postStopEvent(mission, stop, event) {
    const tripId = cleanOptionalText(mission?.tripId);
    const stationId = cleanOptionalText(stop?.stationId || stop?.stationCode);
    const boatCode = cleanOptionalText(mission?.boatCode);
    if (!tripId || !stationId || !event) return { ok: false, skipped: true };
    if (!mission.stopEventsSent) mission.stopEventsSent = new Set();
    const key = `${stationId}:${event}`;
    if (mission.stopEventsSent.has(key)) return { ok: true, skipped: true, reason: 'already-sent' };

    const result = await requestTargetApi({
      method: 'POST',
      pathname: stopEventPath(tripId, stationId),
      payload: {
        boatCode,
        event,
        occurredAt: formatRecordedAt ? formatRecordedAt(new Date()) : new Date().toISOString(),
      },
      auth: 'hook',
    });
    if (result.ok) {
      mission.stopEventsSent.add(key);
      console.log(`[trip-gps] event ${event} ${boatCode} → ${stationId} trip=${tripId}`);
    } else {
      console.warn(`[trip-gps] event ${event} FAIL ${stationId}: ${result.error || result.status}`);
    }
    return result;
  }

  function distanceToStopMeters(mission, stop) {
    if (!stop || !Number.isFinite(Number(stop.lat)) || !Number.isFinite(Number(stop.lng))) return Infinity;
    return distanceMetersFn(
      { lat: mission.currentLat, lng: mission.currentLng },
      { lat: Number(stop.lat), lng: Number(stop.lng) },
    );
  }

  /** Contract: Arriving → Arrived → Departed theo bán kính bến. */
  async function maybeEmitStopEvents(mission) {
    const stops = mission.stops || [];
    if (!stops.length) return;
    if (!mission.stopEventsSent) mission.stopEventsSent = new Set();

    for (const stop of stops) {
      const stationId = cleanOptionalText(stop.stationId || stop.stationCode);
      if (!stationId) continue;
      const dist = distanceToStopMeters(mission, stop);
      if (dist <= STOP_ARRIVING_M) {
        await postStopEvent(mission, stop, 'Arriving');
      }
      if (dist <= STOP_ARRIVED_M) {
        await postStopEvent(mission, stop, 'Arrived');
        mission.atStationId = stationId;
      }
      if (
        mission.atStationId === stationId
        && dist > STOP_DEPART_M
        && mission.stopEventsSent.has(`${stationId}:Arrived`)
      ) {
        await postStopEvent(mission, stop, 'Departed');
        if (mission.atStationId === stationId) mission.atStationId = null;
      }
    }
  }

  function movementStatusFor(mission) {
    const st = String(mission.status || '');
    if (st === 'ToDeparture') return 'Moving';
    if (st === 'Boarding') return 'Boarding';
    if (st === 'WaitingAtStop') return 'AtStation';
    if (st === 'Paused') return 'Delayed';
    if (st === 'Completed') return 'Completed';
    if (st === 'Running') {
      const km = Number(mission.nextStopDistanceKm);
      if (Number.isFinite(km) && km * 1000 <= STOP_ARRIVING_M && km * 1000 > STOP_ARRIVED_M) {
        return 'Arriving';
      }
      if (Number.isFinite(km) && km * 1000 <= STOP_ARRIVED_M) return 'AtStation';
      return 'Moving';
    }
    return 'Scheduled';
  }

  function resolveDeparturePoint(coordinates, stops) {
    const firstStop = (stops || []).find((s) => (
      Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng))
    ));
    if (firstStop) {
      return {
        lat: Number(firstStop.lat),
        lng: Number(firstStop.lng),
        stop: firstStop,
        source: 'stop',
      };
    }
    if (Array.isArray(coordinates) && coordinates.length) {
      const start = pointAtDistance(coordinates, 0);
      return {
        lat: start.lat,
        lng: start.lng,
        stop: null,
        source: 'path',
        heading: start.heading || 0,
      };
    }
    return null;
  }

  function bearingTo(from, to) {
    const lat1 = Number(from.lat) * Math.PI / 180;
    const lat2 = Number(to.lat) * Math.PI / 180;
    const dLng = (Number(to.lng) - Number(from.lng)) * Math.PI / 180;
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function moveToward(from, to, stepMeters) {
    const dist = distanceMetersFn(from, to);
    if (!(dist > 0) || !(stepMeters > 0)) {
      return { lat: Number(to.lat), lng: Number(to.lng), heading: bearingTo(from, to), arrived: true };
    }
    if (stepMeters >= dist) {
      return { lat: Number(to.lat), lng: Number(to.lng), heading: bearingTo(from, to), arrived: true };
    }
    const ratio = stepMeters / dist;
    return {
      lat: Number(from.lat) + (Number(to.lat) - Number(from.lat)) * ratio,
      lng: Number(from.lng) + (Number(to.lng) - Number(from.lng)) * ratio,
      heading: bearingTo(from, to),
      arrived: false,
    };
  }

  /** Phase: đang ở Bình An → chạy bo sông về bến xuất phát lịch (vd Bạch Đằng). */
  async function tickToDeparture(mission, nowMs) {
    const target = {
      lat: Number(mission.departureLat),
      lng: Number(mission.departureLng),
    };
    if (!Number.isFinite(target.lat) || !Number.isFinite(target.lng)) {
      mission.status = 'Boarding';
      return;
    }

    const from = { lat: Number(mission.currentLat), lng: Number(mission.currentLng) };
    const dist = distanceMetersFn(from, target);
    mission.nextStationId = mission.departureStop?.stationId || mission.departureStop?.stationCode || null;
    mission.nextStopCode = mission.departureStop?.stationCode || mission.nextStationId;
    mission.nextStopName = mission.departureStop?.stationName
      || mission.departureStop?.stationCode
      || 'Bến xuất phát';
    mission.nextStopDistanceKm = Math.max(0, dist) / 1000;

    const depMs = parseTimeMs(mission.departureTime);
    let speed = Number(env.DEFAULT_SPEED_KMH || 16);
    if (Number.isFinite(depMs) && nowMs > depMs) {
      speed = Number(mission.maxSpeedKmh) || speed;
    } else if (Number.isFinite(depMs) && depMs > nowMs && dist > 0) {
      const hours = (depMs - nowMs) / 3600000;
      if (hours > 0) {
        const required = (dist / 1000) / hours;
        speed = clampSpeedToBoatMax(Math.max(speed, required), mission.maxSpeedKmh);
      }
    }
    mission.speedKmh = clampSpeedToBoatMax(speed, mission.maxSpeedKmh);
    mission.requiredSpeedKmh = mission.speedKmh;
    mission.nextStopEtaMin = etaMinutesFromDistance(dist, mission.speedKmh);
    mission.movementStatus = 'Moving';
    mission.status = 'ToDeparture';

    if (dist <= TO_DEPARTURE_ARRIVE_M) {
      mission.currentLat = target.lat;
      mission.currentLng = target.lng;
      mission.speedKmh = 0;
      mission.progressMeters = 0;
      mission.stopIndex = 0;
      mission.approachPath = null;
      mission.approachProgress = 0;
      mission.status = (Number.isFinite(depMs) && nowMs < depMs) ? 'Boarding' : 'Running';
      mission.movementStatus = mission.status === 'Boarding' ? 'Boarding' : 'Moving';
      console.log(
        `[trip-gps] đã tới bến xuất phát ${mission.nextStopName || ''} · ${mission.boatCode} → ${mission.status}`,
      );
      refreshNextStopInfo(mission, nowMs);
      await maybeEmitStopEvents(mission);
      await publishTripPoint(mission, { speedKmh: 0, status: 'idle' });
      mission.lastTickAt = nowMs;
      return;
    }

    // Path bo sông (corridor Neon / bến Waterbus).
    const pathEnd = Array.isArray(mission.approachPath) && mission.approachPath.length
      ? mission.approachPath[mission.approachPath.length - 1]
      : null;
    const endDrift = pathEnd ? distanceMetersFn(pathEnd, target) : Infinity;
    if (!Array.isArray(mission.approachPath) || mission.approachPath.length < 2 || endDrift > 40) {
      const base = resolveRiverBasePath({
        stations: state.stations || [],
        routes: [...state.routes.values()],
        osmCorridor: state.osmWaterbusCorridor || [],
      });
      const built = buildRiverPath(from, target, base, { joinMeters: 90 });
      mission.approachPath = built.coordinates;
      mission.approachProgress = 0;
    }

    const elapsedSeconds = Math.max(
      0.2,
      Math.min(5, (nowMs - (mission.lastTickAt || nowMs)) / 1000),
    );
    const stepMeters = Math.max(0.5, (mission.speedKmh * 1000 / 3600) * elapsedSeconds);
    const adv = advanceAlongCoordinates(
      mission.approachPath,
      mission.approachProgress || 0,
      stepMeters,
    );
    mission.approachProgress = adv.progressMeters;
    mission.currentLat = adv.lat;
    mission.currentLng = adv.lng;
    mission.lastHeading = adv.heading;
    await publishTripPoint(mission, {
      speedKmh: mission.speedKmh,
      status: 'moving',
    });
    mission.lastTickAt = nowMs;
  }

  function eligibleBoatCodes() {
    const codes = new Set();
    const surveyCode = cleanOptionalText(state.collector?.boatCode);
    for (const boat of state.boats.values()) {
      const code = cleanOptionalText(boat.boatCode);
      if (!code || String(boat.boatId || '').startsWith('collector-')) continue;
      // Tàu đang survey: không poll trip / không chạy lịch Live.
      if (surveyCode && code === surveyCode) continue;
      if (!isActiveBoatCode(code)) continue;
      if (hasOpenIncidentForBoat(boat)) continue;
      if (isBoatInActiveRescueMission(code)) continue;
      const status = normalizeBoatStatus(effectiveBoatStatus(boat) || boat.dbStatus);
      if (status === 'incident' || status === 'undermaintenance' || status === 'inactive') continue;
      const deviceId = deviceIdForBoat({ boatCode: code, boatId: boat.boatId });
      if (!deviceId) continue;
      codes.add(code);
    }
    return [...codes];
  }

  function startTripMission(row) {
    const tripId = cleanOptionalText(row.tripId || row.TripId);
    const boatCode = cleanOptionalText(row.boatCode || row.BoatCode);
    if (!tripId || !boatCode) return null;
    if (state.tripMissions.has(tripId)) {
      const existing = state.tripMissions.get(tripId);
      if (ACTIVE_TRIP_STATUSES.has(String(existing.status || '')) || existing.status === 'Completed') {
        return existing;
      }
    }
    if (isBoatInActiveTripMission(boatCode)) return null;
    if (isBoatInActiveRescueMission(boatCode)) return null;

    const coordinates = resolveCoordinatesForTrip(row);
    if (coordinates.length < 2) {
      console.warn(`[trip-gps] skip ${tripId}: thiếu routeGeometry (≥2 điểm)`);
      return null;
    }
    const lengthMeters = resolveLengthMeters(row, coordinates);
    if (!(lengthMeters > 10)) {
      console.warn(`[trip-gps] skip ${tripId}: lengthMeters quá ngắn`);
      return null;
    }
    if (lengthMeters > 80_000) {
      console.warn(`[trip-gps] skip ${tripId}: lengthMeters bất thường ${Math.round(lengthMeters)}m`);
      return null;
    }

    const boat = boatByIdOrCode(boatCode);
    const maxSpeedKmh = Number(boat?.maxSpeedKmh)
      || maxSpeedForBoatCode(boatCode)
      || Number(env.DEFAULT_SPEED_KMH || 16)
      || 16;

    const departureTime = row.departureTime || row.DepartureTime || null;
    const arrivalTime = row.arrivalTime || row.ArrivalTime || null;
    const start = pointAtDistance(coordinates, 0);

    const mission = {
      tripId,
      boatCode,
      routeCode: cleanOptionalText(row.routeCode || row.RouteCode) || null,
      departureTime,
      arrivalTime,
      estimatedDurationMin: Number(row.estimatedDurationMin ?? row.EstimatedDurationMin) || null,
      baseDistanceKm: Number(row.baseDistanceKm ?? row.BaseDistanceKm) || (lengthMeters / 1000),
      coordinates,
      lengthMeters,
      progressMeters: 0,
      stops: normalizeStops(row.stops || row.Stops),
      stopIndex: 0,
      status: 'Pending',
      speedKmh: 0,
      requiredSpeedKmh: 0,
      maxSpeedKmh,
      currentLat: start.lat,
      currentLng: start.lng,
      lastHeading: start.heading || 0,
      lastTickAt: Date.now(),
      lastError: null,
      completedAt: null,
      completeSent: false,
      stopEventsSent: new Set(),
      atStationId: null,
      nextStationId: null,
      nextStopDistanceKm: null,
      nextStopEtaMin: null,
      movementStatus: 'Scheduled',
      departureLat: null,
      departureLng: null,
      departureStop: null,
      updatedAt: new Date().toISOString(),
    };

    const depPoint = resolveDeparturePoint(coordinates, mission.stops);
    if (depPoint) {
      mission.departureLat = depPoint.lat;
      mission.departureLng = depPoint.lng;
      mission.departureStop = depPoint.stop;
    }

    // Giữ vị trí hub hiện tại (vd Bình An) — không teleport về đầu tuyến.
    const hub = state.hubBoats.get(boatCode);
    const hubLat = Number(hub?.lat);
    const hubLng = Number(hub?.lng);
    if (Number.isFinite(hubLat) && Number.isFinite(hubLng)) {
      mission.currentLat = hubLat;
      mission.currentLng = hubLng;
      if (Number.isFinite(Number(hub.heading))) mission.lastHeading = Number(hub.heading);
    }

    const distToDep = (Number.isFinite(mission.departureLat) && Number.isFinite(mission.departureLng))
      ? distanceMetersFn(
        { lat: mission.currentLat, lng: mission.currentLng },
        { lat: mission.departureLat, lng: mission.departureLng },
      )
      : 0;

    if (distToDep > TO_DEPARTURE_ARRIVE_M) {
      // Đang ở bến khác → chạy về bến xuất phát lịch trước.
      mission.status = 'ToDeparture';
      mission.movementStatus = 'Moving';
      mission.nextStationId = mission.departureStop?.stationId || mission.departureStop?.stationCode || null;
      mission.nextStopCode = mission.departureStop?.stationCode || mission.nextStationId;
      mission.nextStopName = mission.departureStop?.stationName
        || mission.departureStop?.stationCode
        || 'Bến xuất phát';
      mission.nextStopDistanceKm = distToDep / 1000;
    } else {
      mission.currentLat = mission.departureLat ?? mission.currentLat;
      mission.currentLng = mission.departureLng ?? mission.currentLng;
      mission.progressMeters = 0;
      const depMs0 = parseTimeMs(departureTime);
      mission.status = (Number.isFinite(depMs0) && Date.now() < depMs0) ? 'Boarding' : 'Running';
      mission.movementStatus = mission.status === 'Boarding' ? 'Boarding' : 'Moving';
    }

    // Target speed ban đầu theo contract (khi đã chạy tuyến).
    const depMs = parseTimeMs(departureTime);
    const arrMs = parseTimeMs(arrivalTime);
    if (Number.isFinite(depMs) && Number.isFinite(arrMs) && arrMs > depMs) {
      const hours = (arrMs - depMs) / 3600000;
      const km = lengthMeters / 1000;
      if (hours > 0 && km > 0) {
        mission.requiredSpeedKmh = km / hours;
        if (mission.status !== 'ToDeparture') {
          mission.speedKmh = clampSpeedToBoatMax(mission.requiredSpeedKmh, maxSpeedKmh);
        }
      }
    }

    state.tripMissions.set(tripId, mission);
    console.log(
      `[trip-gps] START ${boatCode} trip=${tripId} · ${mission.status} `
      + `${Math.round(lengthMeters)}m · tới bến XP ${Math.round(distToDep)}m · dep ${departureTime || '?'}`,
    );
    // Chạy ngay ≤1s — không chờ interval tick sau.
    setTimeout(() => {
      tickOneMission(mission, Date.now()).catch((error) => {
        console.warn(`[trip-gps] first-tick ${tripId}: ${error.message}`);
      });
    }, 0);
    return mission;
  }

  function computeRequiredSpeedKmh(mission, nowMs) {
    const rawRemaining = Math.max(0, Number(mission.lengthMeters) - Number(mission.progressMeters));
    // Trần hợp lý tuyến sông — tránh geometry lỗi → tốc độ ~0 và đứng im.
    const remainingMeters = Math.min(rawRemaining, 80_000);
    const remainingKm = remainingMeters / 1000;
    if (!(remainingKm > 0.001)) return 0;

    const arrMs = parseTimeMs(mission.arrivalTime);
    if (!Number.isFinite(arrMs)) {
      return Number(mission.speedKmh) || Number(env.DEFAULT_SPEED_KMH || 16);
    }
    const remainingHours = (arrMs - nowMs) / 3600000;
    if (!(remainingHours > 0)) {
      // Trễ: chạy max, chấp nhận đến muộn.
      return Number(mission.maxSpeedKmh) || 80;
    }
    // Nếu lịch còn rất xa so với quãng đường (ETA ảo) → dùng tốc độ mặc định.
    const required = remainingKm / remainingHours;
    if (required < 0.5) return Number(env.DEFAULT_SPEED_KMH || 16);
    return required;
  }

  function nearStop(mission, stop, radius = STOP_ARRIVED_M) {
    if (!stop || !Number.isFinite(Number(stop.lat)) || !Number.isFinite(Number(stop.lng))) return false;
    const boat = { lat: mission.currentLat, lng: mission.currentLng };
    const stopPt = { lat: Number(stop.lat), lng: Number(stop.lng) };
    if (distanceMetersFn(boat, stopPt) <= radius) return true;
    // Path chỉ chạy giữa sông — coi tới điểm chiếu bến trên path là đã cập.
    const coords = mission.coordinates || [];
    if (coords.length >= 2) {
      const proj = projectOnPath(coords, stopPt);
      if (proj && distanceMetersFn(boat, { lat: proj.lat, lng: proj.lng }) <= radius) return true;
    }
    return false;
  }

  /** Khoảng cách dọc path từ progress hiện tại tới điểm gần stop nhất. */
  function alongMetersToStop(mission, stop) {
    const coords = mission.coordinates || [];
    if (!stop || coords.length < 2) return null;
    if (!Number.isFinite(Number(stop.lat)) || !Number.isFinite(Number(stop.lng))) return null;
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < coords.length; i += 1) {
      const d = distanceMetersFn(coords[i], { lat: Number(stop.lat), lng: Number(stop.lng) });
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    let along = 0;
    for (let i = 1; i <= bestIdx; i += 1) along += distanceMetersFn(coords[i - 1], coords[i]);
    return Math.max(0, along - Number(mission.progressMeters || 0));
  }

  function etaMinutesFromDistance(distanceMeters, speedKmh) {
    const meters = Number(distanceMeters);
    const speed = Number(speedKmh);
    if (!(meters > 0)) return 0;
    if (!(speed > 0.2)) return null;
    return (meters / 1000) / speed * 60;
  }

  /** Cập nhật nextStop* + remaining* cho FE (snapshot/SSE). */
  function refreshNextStopInfo(mission, nowMs = Date.now()) {
    if (!mission) return;
    const remainingMeters = Math.max(
      0,
      Number(mission.lengthMeters || 0) - Number(mission.progressMeters || 0),
    );
    mission.remainingDistanceKm = remainingMeters / 1000;

    const arrMs = parseTimeMs(mission.arrivalTime);
    if (Number.isFinite(arrMs)) {
      mission.remainingEtaMin = Math.max(0, (arrMs - nowMs) / 60000);
    } else {
      const bySpeed = etaMinutesFromDistance(
        remainingMeters,
        Number(mission.speedKmh) || Number(mission.requiredSpeedKmh) || 0,
      );
      mission.remainingEtaMin = bySpeed;
    }

    const stops = mission.stops || [];
    let idx = Number(mission.stopIndex) || 0;
    // Đang chờ tại bến → next là bến hiện tại (0 km) hoặc bến kế.
    let next = null;
    if (mission.status === 'WaitingAtStop' && stops[idx]) {
      next = stops[idx];
    } else {
      while (idx < stops.length && nearStop(mission, stops[idx], STOP_ARRIVED_M * 1.2)) {
        idx += 1;
      }
      next = stops[idx] || null;
    }

    if (!next && remainingMeters > 8) {
      // Không có stops — coi đích cuối tuyến là “bến tiếp theo”.
      mission.nextStationId = null;
      mission.nextStopCode = mission.routeCode || 'END';
      mission.nextStopName = 'Đích tuyến';
      mission.nextStopDistanceKm = mission.remainingDistanceKm;
      mission.nextStopEtaMin = mission.remainingEtaMin;
      mission.nextStopPlannedArrivalAt = mission.arrivalTime || null;
      mission.movementStatus = movementStatusFor(mission);
      return;
    }
    if (!next) {
      mission.nextStationId = null;
      mission.nextStopCode = null;
      mission.nextStopName = null;
      mission.nextStopDistanceKm = 0;
      mission.nextStopEtaMin = 0;
      mission.nextStopPlannedArrivalAt = null;
      mission.movementStatus = movementStatusFor(mission);
      return;
    }

    const along = alongMetersToStop(mission, next);
    const straight = Number.isFinite(Number(next.lat)) && Number.isFinite(Number(next.lng))
      ? distanceMetersFn(
        { lat: mission.currentLat, lng: mission.currentLng },
        { lat: Number(next.lat), lng: Number(next.lng) },
      )
      : null;

    // Ưu tiên đường thẳng khi dọc path bất thường (toạ độ swap / geometry lỗi).
    let metersToNext = null;
    if (Number.isFinite(straight) && Number.isFinite(along) && along > 0) {
      metersToNext = (along > straight * 3 + 300 || along > 50_000) ? straight : along;
    } else if (Number.isFinite(along) && along > 0 && along <= 50_000) {
      metersToNext = along;
    } else if (Number.isFinite(straight)) {
      metersToNext = straight;
    } else {
      metersToNext = Math.min(remainingMeters, 50_000);
    }
    if (!(metersToNext >= 0) || metersToNext > 80_000) {
      metersToNext = Number.isFinite(straight) ? straight : Math.min(remainingMeters, 5_000);
    }

    mission.nextStationId = next.stationId || next.stationCode || null;
    mission.nextStopCode = next.stationCode || next.stationId || null;
    mission.nextStopName = next.stationName || next.stationCode || 'Bến kế';
    mission.nextStopDistanceKm = Math.max(0, metersToNext) / 1000;
    mission.nextStopPlannedArrivalAt = next.plannedArrivalTime || null;

    const planArr = parseTimeMs(next.plannedArrivalTime);
    const speedForEta = Number(mission.speedKmh) > 0.5
      ? Number(mission.speedKmh)
      : (Number(mission.requiredSpeedKmh) || Number(mission.maxSpeedKmh) || 16);
    if (Number.isFinite(planArr) && planArr > nowMs) {
      mission.nextStopEtaMin = Math.max(0, (planArr - nowMs) / 60000);
    } else {
      // Lịch quá khứ / thiếu → ETA theo quãng đường & tốc độ thực.
      mission.nextStopEtaMin = etaMinutesFromDistance(metersToNext, speedForEta);
    }
    mission.movementStatus = movementStatusFor(mission);
  }

  async function publishTripPoint(mission, { speedKmh, status }) {
    const result = await publishLiveGpsPosition({
      boatCode: mission.boatCode,
      lat: mission.currentLat,
      lng: mission.currentLng,
      heading: mission.lastHeading,
      speedKmh,
      status,
      tripId: mission.tripId,
      routeCode: mission.routeCode,
      nextStationId: mission.nextStationId || null,
      remainingDistanceKmToNextStation: Number.isFinite(Number(mission.nextStopDistanceKm))
        ? Number(mission.nextStopDistanceKm)
        : null,
      remainingMinutesToNextStation: Number.isFinite(Number(mission.nextStopEtaMin))
        ? Number(mission.nextStopEtaMin)
        : null,
      sendToTarget: true,
      fromTrip: true,
    });
    mission.lastError = result.ok || result.skipped || result.soft
      ? null
      : (result.error || result.warning || 'publish failed');
    mission.updatedAt = new Date().toISOString();
    return result;
  }

  async function finishTripMission(mission) {
    if (mission.completeSent) return;
    mission.completeSent = true;
    mission.status = 'Completed';
    mission.speedKmh = 0;
    mission.movementStatus = 'Completed';
    mission.completedAt = new Date().toISOString();
    mission.updatedAt = mission.completedAt;
    await publishTripPoint(mission, { speedKmh: 0, status: 'idle' });
    const complete = await completeTripOnBe(mission.tripId, {
      boatCode: mission.boatCode,
      completedAt: formatRecordedAt ? formatRecordedAt(new Date()) : new Date().toISOString(),
    });
    if (!complete.ok) {
      mission.lastError = complete.error || `complete ${complete.status}`;
      mission.completeSent = false; // cho phép retry tick sau
      console.warn(`[trip-gps] complete FAIL ${mission.tripId}: ${mission.lastError}`);
    } else {
      console.log(`[trip-gps] COMPLETE ${mission.boatCode} trip=${mission.tripId}`);
    }
  }

  async function tickOneMission(mission, nowMs) {
    if (!mission || mission.status === 'Completed') return;

    // Path cũ đâm V vào cầu tàu → ép lại đúng vạch sông.
    ensureMissionCorridorPath(mission);

    // Mission geometry/ETA lỗi từ BE (vd 11832 km / -95000p) → huỷ để poll lại.
    if (Number(mission.lengthMeters) > 80_000) {
      console.warn(`[trip-gps] drop ${mission.tripId}: length ${Math.round(mission.lengthMeters)}m`);
      state.tripMissions.delete(mission.tripId);
      return;
    }
    // Sửa stop lat/lng bị swap nếu còn sót.
    if (Array.isArray(mission.stops)) {
      mission.stops = mission.stops.map((stop) => {
        const pair = sanitizeLatLng(stop.lat, stop.lng);
        return pair ? { ...stop, lat: pair.lat, lng: pair.lng } : stop;
      });
    }

    if (isBoatInActiveRescueMission(mission.boatCode) || hasOpenIncidentForBoat(mission.boatCode)) {
      mission.status = 'Paused';
      mission.speedKmh = 0;
      refreshNextStopInfo(mission, nowMs);
      await maybeEmitStopEvents(mission);
      mission.updatedAt = new Date().toISOString();
      return;
    }

    const depMs = parseTimeMs(mission.departureTime);
    const coords = mission.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) {
      mission.lastError = 'missing coordinates';
      return;
    }

    // Đang ở bến khác (vd Bình An) → chạy về bến xuất phát lịch trước.
    if (mission.status === 'ToDeparture' || (
      mission.status !== 'Running'
      && mission.status !== 'WaitingAtStop'
      && Number.isFinite(Number(mission.departureLat))
      && distanceMetersFn(
        { lat: mission.currentLat, lng: mission.currentLng },
        { lat: mission.departureLat, lng: mission.departureLng },
      ) > TO_DEPARTURE_ARRIVE_M
      && Number(mission.progressMeters || 0) < 5
    )) {
      await tickToDeparture(mission, nowMs);
      return;
    }

    // Trước giờ khởi hành: đứng tại bến xuất phát (không teleport về đầu path).
    if (Number.isFinite(depMs) && nowMs < depMs) {
      mission.status = 'Boarding';
      mission.progressMeters = 0;
      if (Number.isFinite(Number(mission.departureLat))) {
        mission.currentLat = Number(mission.departureLat);
        mission.currentLng = Number(mission.departureLng);
      } else {
        const start = pointAtDistance(coords, 0);
        mission.currentLat = start.lat;
        mission.currentLng = start.lng;
        mission.lastHeading = start.heading || mission.lastHeading || 0;
      }
      mission.speedKmh = 0;
      mission.requiredSpeedKmh = computeRequiredSpeedKmh(
        { ...mission, progressMeters: 0 },
        depMs,
      );
      refreshNextStopInfo(mission, nowMs);
      await maybeEmitStopEvents(mission);
      await publishTripPoint(mission, { speedKmh: 0, status: 'idle' });
      mission.lastTickAt = nowMs;
      return;
    }

    // Early tại bến: chờ plannedDepartureTime.
    const stops = mission.stops || [];
    let stopIndex = Number(mission.stopIndex) || 0;
    while (stopIndex < stops.length) {
      const stop = stops[stopIndex];
      const planDep = parseTimeMs(stop.plannedDepartureTime);
      if (nearStop(mission, stop) && Number.isFinite(planDep) && nowMs < planDep) {
        mission.status = 'WaitingAtStop';
        mission.stopIndex = stopIndex;
        mission.speedKmh = 0;
        refreshNextStopInfo(mission, nowMs);
        await maybeEmitStopEvents(mission);
        await publishTripPoint(mission, { speedKmh: 0, status: 'idle' });
        mission.lastTickAt = nowMs;
        return;
      }
      if (nearStop(mission, stop) && (!Number.isFinite(planDep) || nowMs >= planDep)) {
        stopIndex += 1;
        mission.stopIndex = stopIndex;
        continue;
      }
      break;
    }

    const required = computeRequiredSpeedKmh(mission, nowMs);
    mission.requiredSpeedKmh = required;
    // Early (required thấp): giảm tốc; late: tăng tới max.
    const speed = required <= 0
      ? 0
      : clampSpeedToBoatMax(Math.max(1, required), mission.maxSpeedKmh);
    mission.speedKmh = speed;
    mission.status = 'Running';

    const elapsedSeconds = Math.max(
      0.2,
      Math.min(5, (nowMs - (mission.lastTickAt || nowMs)) / 1000),
    );
    const stepMeters = Math.max(0.5, (speed * 1000 / 3600) * elapsedSeconds);
    mission.progressMeters = Math.min(
      Number(mission.lengthMeters),
      Number(mission.progressMeters) + stepMeters,
    );

    const point = pointAtDistance(coords, mission.progressMeters);
    mission.currentLat = point.lat;
    mission.currentLng = point.lng;
    mission.lastHeading = point.heading || mission.lastHeading || 0;

    const arrived = mission.progressMeters >= (Number(mission.lengthMeters) - 8);
    refreshNextStopInfo(mission, nowMs);
    await maybeEmitStopEvents(mission);
    await publishTripPoint(mission, {
      speedKmh: arrived ? 0 : speed,
      status: arrived ? 'idle' : 'moving',
    });
    mission.lastTickAt = nowMs;

    if (arrived) {
      await finishTripMission(mission);
    }
  }

  async function pollDueTrips() {
    if (!tripAutorunEnabled()) return;
    if (pollBusy) return;
    if (!state.liveHookSecret && !env.LIVE_HOOK_SECRET) return;
    if (Date.now() < dueAuthBlockedUntil) return;
    pollBusy = true;
    try {
      pruneCompletedTrips();
      const codes = eligibleBoatCodes();
      let loggedAuthToUi = false;
      for (const boatCode of codes) {
        if (isBoatInActiveTripMission(boatCode)) continue;
        if (isBoatInActiveRescueMission(boatCode)) continue;
        // Chỉ ghi 1 dòng đỏ vào API log khi auth sai — tránh flood mỗi tàu × mỗi 30s.
        const silent = loggedAuthToUi;
        const due = await fetchDueTrips({
          boatCode,
          lookAheadMinutes: lookAheadMinutes(),
          silent,
        });
        if (!due.ok) {
          if (due.status === 401 || due.status === 403) {
            loggedAuthToUi = true;
            break;
          }
          if (due.status !== 404) {
            console.warn(`[trip-gps] due ${boatCode}: ${due.error || due.status}`);
          }
          continue;
        }
        for (const row of due.trips) {
          const tripBoat = cleanOptionalText(row.boatCode || row.BoatCode) || boatCode;
          if (tripBoat !== boatCode) continue;
          startTripMission({ ...row, boatCode: tripBoat });
          // Một trip đang chạy / vừa start cho tàu này là đủ.
          if (isBoatInActiveTripMission(boatCode)) break;
        }
      }
    } finally {
      pollBusy = false;
    }
  }

  async function tickTripMissions() {
    if (!tripAutorunEnabled()) return;
    if (tickBusy) return;
    tickBusy = true;
    try {
      const nowMs = Date.now();
      const list = [...state.tripMissions.values()];
      for (const mission of list) {
        if (mission.status === 'Completed') continue;
        try {
          await tickOneMission(mission, nowMs);
        } catch (error) {
          mission.lastError = error.message;
          console.warn(`[trip-gps] tick ${mission.tripId}: ${error.message}`);
        }
      }
    } finally {
      tickBusy = false;
    }
  }

  function pruneCompletedTrips() {
    const now = Date.now();
    for (const [id, mission] of state.tripMissions) {
      if (String(mission.status) !== 'Completed') continue;
      const at = parseTimeMs(mission.completedAt) || parseTimeMs(mission.updatedAt);
      if (Number.isFinite(at) && now - at > COMPLETED_TTL_MS) {
        state.tripMissions.delete(id);
      }
    }
  }

  return {
    fetchDueTrips,
    completeTripOnBe,
    pollDueTrips,
    tickTripMissions,
    isBoatInActiveTripMission,
    tripMissionsPublic,
    startTripMission,
  };
}

function round1(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10) / 10;
}

function round3(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000) / 1000;
}
