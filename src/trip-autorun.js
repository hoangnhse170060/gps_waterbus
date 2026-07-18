/**
 * GPS tự chạy trip theo lịch BE.
 * Poll GET /api/gps/trips/due → chạy routeGeometry → POST locations + tripId
 * → POST /api/gps/trips/{tripId}/complete
 */
import { distanceMeters, routeLength } from './geo-distance.js';

const ACTIVE_TRIP_STATUSES = new Set([
  'Pending',
  'Boarding',
  'Running',
  'WaitingAtStop',
  'Paused',
]);

const STOP_ARRIVE_METERS = 40;
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

  function tripAutorunEnabled() {
    return parseBool(env.TRIP_AUTORUN ?? 'true');
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
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const ms = Date.parse(String(value));
    return Number.isFinite(ms) ? ms : NaN;
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
          const a = Number(point[0]);
          const b = Number(point[1]);
          if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
          // Ưu tiên GeoJSON [lng, lat]; nhận diện [lat, lng] khi |lng| > 90 ở phần tử 2.
          if (Math.abs(b) > 90 && Math.abs(a) <= 90) {
            out.push({ lat: a, lng: b });
          } else {
            out.push({ lat: b, lng: a });
          }
          continue;
        }
        const lat = Number(point?.lat ?? point?.Latitude ?? point?.latitude);
        const lng = Number(point?.lng ?? point?.lon ?? point?.Longitude ?? point?.longitude);
        if (Number.isFinite(lat) && Number.isFinite(lng)) out.push({ lat, lng });
      }
      return out;
    }
    try {
      return parseRouteCoordinates(raw);
    } catch {
      return [];
    }
  }

  function normalizeStops(rawStops) {
    if (!Array.isArray(rawStops)) return [];
    return rawStops.map((stop, index) => ({
      stationId: cleanOptionalText(stop.stationId || stop.StationId) || null,
      stationCode: cleanOptionalText(stop.stationCode || stop.StationCode) || null,
      stationName: cleanOptionalText(stop.stationName || stop.StationName) || null,
      stopOrder: Number(stop.stopOrder ?? stop.StopOrder) || index + 1,
      lat: Number.isFinite(Number(stop.lat ?? stop.Latitude)) ? Number(stop.lat ?? stop.Latitude) : null,
      lng: Number.isFinite(Number(stop.lng ?? stop.Longitude)) ? Number(stop.lng ?? stop.Longitude) : null,
      plannedArrivalTime: stop.plannedArrivalTime || stop.PlannedArrivalTime || stop.arrivalTime || null,
      plannedDepartureTime: stop.plannedDepartureTime || stop.PlannedDepartureTime || stop.departureTime || null,
    })).sort((a, b) => a.stopOrder - b.stopOrder);
  }

  function resolveCoordinatesForTrip(row) {
    const fromPayload = parseTripCoordinates(
      row.routeGeometry || row.RouteGeometry || row.geometry || row.coordinates,
    );
    if (fromPayload.length >= 2) return fromPayload;

    const routeCode = cleanOptionalText(row.routeCode || row.RouteCode);
    if (!routeCode) return [];
    for (const route of state.routes.values()) {
      if (String(route.routeCode || '').trim() !== routeCode) continue;
      const coords = Array.isArray(route.coordinates) ? route.coordinates : [];
      if (coords.length >= 2) return coords.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }));
    }
    return [];
  }

  function resolveLengthMeters(row, coordinates) {
    const geoLen = coordinates.length >= 2 ? routeLengthFn(coordinates) : 0;
    if (geoLen > 10) return geoLen;
    const baseKm = Number(row.baseDistanceKm ?? row.BaseDistanceKm);
    if (Number.isFinite(baseKm) && baseKm > 0) return baseKm * 1000;
    return geoLen;
  }

  async function fetchDueTrips({ boatCode, lookAheadMinutes: lookAhead } = {}) {
    const code = cleanOptionalText(boatCode);
    if (!code) return { ok: false, trips: [], error: 'missing boatCode' };
    const minutes = Number.isFinite(Number(lookAhead)) ? Number(lookAhead) : lookAheadMinutes();
    const path = `${duePath()}?boatCode=${encodeURIComponent(code)}&lookAheadMinutes=${encodeURIComponent(String(minutes))}`;
    const result = await requestTargetApi({
      method: 'GET',
      pathname: path,
      auth: 'hook',
      silent: false,
    });
    if (!result.ok) {
      return { ok: false, trips: [], status: result.status, error: result.error, data: result.data };
    }
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
        completedAt: formatRecordedAt ? formatRecordedAt(new Date()) : new Date().toISOString(),
        note: 'GPS arrived at route end',
      },
      auth: 'hook',
    });
  }

  function eligibleBoatCodes() {
    const codes = new Set();
    for (const boat of state.boats.values()) {
      const code = cleanOptionalText(boat.boatCode);
      if (!code || String(boat.boatId || '').startsWith('collector-')) continue;
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
      updatedAt: new Date().toISOString(),
    };

    // Target speed ban đầu theo contract.
    const depMs = parseTimeMs(departureTime);
    const arrMs = parseTimeMs(arrivalTime);
    if (Number.isFinite(depMs) && Number.isFinite(arrMs) && arrMs > depMs) {
      const hours = (arrMs - depMs) / 3600000;
      const km = lengthMeters / 1000;
      if (hours > 0 && km > 0) {
        mission.requiredSpeedKmh = km / hours;
        mission.speedKmh = clampSpeedToBoatMax(mission.requiredSpeedKmh, maxSpeedKmh);
      }
    }

    state.tripMissions.set(tripId, mission);
    console.log(
      `[trip-gps] START ${boatCode} trip=${tripId} `
      + `${Math.round(lengthMeters)}m · max ${maxSpeedKmh} km/h · dep ${departureTime || '?'}`,
    );
    return mission;
  }

  function computeRequiredSpeedKmh(mission, nowMs) {
    const remainingMeters = Math.max(0, Number(mission.lengthMeters) - Number(mission.progressMeters));
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
    return remainingKm / remainingHours;
  }

  function nearStop(mission, stop, radius = STOP_ARRIVE_METERS) {
    if (!stop || !Number.isFinite(Number(stop.lat)) || !Number.isFinite(Number(stop.lng))) return false;
    const d = distanceMetersFn(
      { lat: mission.currentLat, lng: mission.currentLng },
      { lat: Number(stop.lat), lng: Number(stop.lng) },
    );
    return d <= radius;
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
    mission.completedAt = new Date().toISOString();
    mission.updatedAt = mission.completedAt;
    await publishTripPoint(mission, { speedKmh: 0, status: 'idle' });
    const complete = await completeTripOnBe(mission.tripId);
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

    if (isBoatInActiveRescueMission(mission.boatCode) || hasOpenIncidentForBoat(mission.boatCode)) {
      mission.status = 'Paused';
      mission.speedKmh = 0;
      mission.updatedAt = new Date().toISOString();
      return;
    }

    const depMs = parseTimeMs(mission.departureTime);
    const coords = mission.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) {
      mission.lastError = 'missing coordinates';
      return;
    }

    // Trước giờ khởi hành: đứng đầu tuyến (Boarding).
    if (Number.isFinite(depMs) && nowMs < depMs) {
      mission.status = 'Boarding';
      mission.progressMeters = 0;
      const start = pointAtDistance(coords, 0);
      mission.currentLat = start.lat;
      mission.currentLng = start.lng;
      mission.lastHeading = start.heading || mission.lastHeading || 0;
      mission.speedKmh = 0;
      mission.requiredSpeedKmh = computeRequiredSpeedKmh(
        { ...mission, progressMeters: 0 },
        depMs,
      );
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
    pollBusy = true;
    try {
      pruneCompletedTrips();
      const codes = eligibleBoatCodes();
      for (const boatCode of codes) {
        if (isBoatInActiveTripMission(boatCode)) continue;
        if (isBoatInActiveRescueMission(boatCode)) continue;
        const due = await fetchDueTrips({ boatCode, lookAheadMinutes: lookAheadMinutes() });
        if (!due.ok) {
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
