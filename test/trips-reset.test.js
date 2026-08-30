import assert from 'node:assert/strict';
import test from 'node:test';
import { pointAtDistance } from '../src/river-corridor.js';
import { createTripAutorun } from '../src/trip-autorun.js';

function cleanOptionalText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function createFixture({ status = 'Boarding', progressMeters = 0 } = {}) {
  const published = [];
  const mission = {
    tripId: 'trip-1',
    boatCode: 'WB_01',
    status,
    movementStatus: status === 'Running' ? 'Moving' : 'Boarding',
    maxSpeedKmh: 16,
    speedKmh: 0,
    requiredSpeedKmh: 0,
    currentLat: 10.776,
    currentLng: 106.710,
    lastHeading: 180,
    progressMeters,
    lengthMeters: 500,
    stops: [
      { stationId: 'st-tt', stationCode: 'ST-TT', stationName: 'Thu Thiem', lat: 10.7768, lng: 106.7096 },
      { stationId: 'st-bd', stationCode: 'ST-BD', stationName: 'Bach Dang', lat: 10.7752, lng: 106.7073 },
    ],
    updatedAt: new Date().toISOString(),
  };
  const state = {
    tripMissions: new Map([[mission.tripId, mission]]),
    stations: [
      { stationId: 'st-bd', stationCode: 'ST-BD', stationName: 'Bach Dang', lat: 10.7752, lng: 106.7073 },
      { stationId: 'st-tt', stationCode: 'ST-TT', stationName: 'Thu Thiem', lat: 10.7768, lng: 106.7096 },
    ],
    routes: new Map(),
    osmWaterbusCorridor: [
      { lat: 10.7752, lng: 106.7073 },
      { lat: 10.7768, lng: 106.7096 },
      { lat: 10.776, lng: 106.710 },
    ],
  };
  const autorun = createTripAutorun({
    state,
    env: { TRIP_AUTORUN: 'true', DEFAULT_SPEED_KMH: '16' },
    parseBool: (value) => String(value).toLowerCase() === 'true',
    cleanOptionalText,
    clampSpeedToBoatMax: (speed, max) => Math.min(Number(speed), Number(max) || Number(speed)),
    maxSpeedForBoatCode: () => 16,
    pointAtDistance,
    parseRouteCoordinates: () => [],
    requestTargetApi: async () => ({ ok: true, data: [] }),
    publishLiveGpsPosition: async (payload) => {
      published.push(payload);
      return { ok: true };
    },
    isBoatInActiveRescueMission: () => false,
    hasOpenIncidentForBoat: () => false,
    boatNeedsIncidentFreeze: () => false,
    isActiveBoatCode: () => true,
    deviceIdForBoat: () => 'gps-wb-01',
    boatByIdOrCode: () => ({ boatCode: 'WB_01', maxSpeedKmh: 16 }),
    normalizeBoatStatus: (value) => value,
    effectiveBoatStatus: () => 'Active',
    formatRecordedAt: (date) => date.toISOString(),
  });
  return { autorun, mission, published };
}

test('tripsReset returns a safe removed trip to its end station without tripId', async () => {
  const { autorun, mission, published } = createFixture();
  const result = await autorun.handleTripsReset({
    boatCode: 'WB_01',
    operatingDate: '2026-08-30',
    removedTrips: [{ tripId: 'trip-1', status: 'Scheduled', endStationCode: 'BD' }],
    keptActiveTrips: [],
  });

  assert.equal(result.ok, true);
  assert.equal(mission.status, 'ReturnToBase');
  assert.equal(mission.returnStationCode, 'BD');
  assert.equal(published[0].tripId, null);
  assert.equal(published[0].movementStatus, 'Moving');
  assert.equal(autorun.tripMissionsPublic()[0].tripId, null);

  mission.currentLat = mission.returnLat;
  mission.currentLng = mission.returnLng;
  await autorun.tickTripMissions();

  assert.equal(mission.status, 'ReturnedToBase');
  assert.equal(mission.movementStatus, 'AtStation');
  assert.equal(published.at(-1).tripId, null);
  assert.equal(published.at(-1).currentStationCode, 'BD');
});

test('tripsReset requires admin confirmation for an in-progress trip', async () => {
  const { autorun, mission, published } = createFixture({ status: 'Running', progressMeters: 120 });
  const result = await autorun.handleTripsReset({
    boatCode: 'WB_01',
    removedTrips: [{ tripId: 'trip-1', endStationCode: 'BD' }],
  });

  assert.equal(result.results[0].requiresAdminConfirmation, true);
  assert.equal(mission.status, 'Running');
  assert.equal(mission.requiresAdminConfirmation, true);
  assert.equal(published.length, 0);
});

test('tripsReset requires admin confirmation when passengers are onboard', async () => {
  const { autorun, mission, published } = createFixture();
  const result = await autorun.handleTripsReset({
    boatCode: 'WB_01',
    removedTrips: [{
      tripId: 'trip-1',
      status: 'Scheduled',
      endStationCode: 'BD',
      onboardPassengerCount: 3,
    }],
  });

  assert.equal(result.results[0].requiresAdminConfirmation, true);
  assert.equal(result.results[0].reason, 'tàu đang có hành khách');
  assert.equal(mission.status, 'Boarding');
  assert.equal(published.length, 0);
});

test('tripsReset never removes a trip listed in keptActiveTrips', async () => {
  const { autorun, mission, published } = createFixture();
  const result = await autorun.handleTripsReset({
    boatCode: 'WB_01',
    removedTrips: [{ tripId: 'trip-1', status: 'Scheduled', endStationCode: 'BD' }],
    keptActiveTrips: [{ tripId: 'trip-1' }],
  });

  assert.equal(result.results[0].skipped, true);
  assert.equal(mission.status, 'Boarding');
  assert.equal(published.length, 0);
});
