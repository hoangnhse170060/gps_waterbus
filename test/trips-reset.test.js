import assert from 'node:assert/strict';
import test from 'node:test';
import { distanceMeters, routeLength } from '../src/geo-distance.js';
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
  return { autorun, mission, published, state };
}

test('tripsReset snaps a boat without a new trip to its nearest station', async () => {
  const { autorun, mission, published } = createFixture();
  const result = await autorun.handleTripsReset({
    boatCode: 'WB_01',
    operatingDate: '2026-08-30',
    removedTrips: [{ tripId: 'trip-1', status: 'Scheduled', endStationCode: 'BD' }],
    keptActiveTrips: [],
  });

  assert.equal(result.ok, true);
  assert.equal(mission.status, 'ReturnedToBase');
  assert.equal(mission.returnStationCode, 'ST-TT');
  assert.equal(mission.returnReason, 'NearestAvailableStation');
  assert.equal(result.results[0].snapped, true);
  assert.equal(published.at(-1).tripId, null);
  assert.equal(published.at(-1).movementStatus, 'AtStation');
  assert.equal(autorun.tripMissionsPublic()[0].tripId, null);
  assert.equal(published.at(-1).currentStationCode, 'ST-TT');
});

test('tripsReset snaps the nearest station position to the river corridor', async () => {
  const { autorun, mission, state } = createFixture();
  state.osmWaterbusCorridor = [
    { lat: 10.7750, lng: 106.7077 },
    { lat: 10.7768, lng: 106.7096 },
    { lat: 10.7760, lng: 106.7100 },
  ];

  await autorun.handleTripsReset({
    boatCode: 'WB_01',
    removedTrips: [{ tripId: 'trip-1', status: 'Scheduled', endStationCode: 'BD' }],
  });

  assert.ok(distanceMeters(
    { lat: mission.returnLat, lng: mission.returnLng },
    state.stations[1],
  ) < 120);
  assert.equal(mission.returnStationCode, 'ST-TT');
});

test('tripsReset snaps the boat to the nearest added trip departure station', async () => {
  const { autorun, mission, state, published } = createFixture();
  const now = Date.now();

  const result = await autorun.handleTripsReset({
    boatCode: 'WB_01',
    removedTrips: [{ tripId: 'trip-1', status: 'Scheduled', endStationCode: 'BD' }],
    addedTrips: [
      {
        tripId: 'trip-later',
        tripCode: 'TR-LATER',
        departureTime: new Date(now + 60 * 60_000).toISOString(),
        startStationCode: 'BD',
      },
      {
        tripId: 'trip-next',
        tripCode: 'TR-NEXT',
        departureTime: new Date(now + 15 * 60_000).toISOString(),
        startStationCode: 'TT',
      },
    ],
  });

  const tt = state.stations.find((station) => station.stationCode === 'ST-TT');
  assert.equal(mission.returnStationCode, 'TT');
  assert.equal(mission.relocationTripId, 'trip-next');
  assert.equal(mission.returnReason, 'NextTripDeparture');
  assert.equal(mission.status, 'ReturnedToBase');
  assert.equal(mission.movementStatus, 'AtStation');
  assert.equal(mission.speedKmh, 0);
  assert.equal(mission.currentLat, mission.returnLat);
  assert.equal(mission.currentLng, mission.returnLng);
  assert.ok(distanceMeters(
    { lat: mission.returnLat, lng: mission.returnLng },
    tt,
  ) < 120);
  assert.equal(result.results[0].relocationTripId, 'trip-next');
  assert.equal(result.results[0].snapped, true);
  assert.equal(published.at(-1).tripId, null);
  assert.equal(published.at(-1).movementStatus, 'AtStation');
  assert.equal(published.at(-1).currentStationCode, 'TT');
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

test('WaitingAtStop snaps the boat from the river path to the exact station', async () => {
  const { autorun, mission, published } = createFixture({ status: 'Running' });
  const station = mission.stops[0];
  const riverPoint = { lat: station.lat - 0.0008, lng: station.lng };
  mission.coordinates = [
    { lat: riverPoint.lat, lng: riverPoint.lng - 0.001 },
    { lat: riverPoint.lat, lng: riverPoint.lng + 0.001 },
  ];
  mission.lengthMeters = routeLength(mission.coordinates);
  mission.progressMeters = mission.lengthMeters / 2;
  mission.currentLat = riverPoint.lat;
  mission.currentLng = riverPoint.lng;
  mission.departureTime = new Date(Date.now() - 60_000).toISOString();
  mission.arrivalTime = new Date(Date.now() + 60 * 60_000).toISOString();
  station.plannedDepartureTime = new Date(Date.now() + 60 * 60_000).toISOString();
  mission.stopIndex = 0;
  mission.corridorSnapped = true;
  mission.lastTickAt = Date.now() - 1000;

  assert.ok(distanceMeters(riverPoint, station) > 28);
  await autorun.tickTripMissions();

  assert.equal(mission.status, 'WaitingAtStop');
  assert.equal(mission.movementStatus, 'AtStation');
  assert.equal(mission.currentLat, station.lat);
  assert.equal(mission.currentLng, station.lng);
  assert.equal(mission.currentStationCode, station.stationCode);
  assert.equal(published.at(-1).speedKmh, 0);
  assert.equal(published.at(-1).movementStatus, 'AtStation');
  assert.equal(published.at(-1).currentStationCode, station.stationCode);
});

test('completed trip publishes a final idle position without tripId', async () => {
  const { autorun, mission, published } = createFixture({ status: 'Running' });
  mission.coordinates = [
    { lat: 10.7752, lng: 106.7073 },
    { lat: 10.7768, lng: 106.7096 },
  ];
  mission.lengthMeters = routeLength(mission.coordinates);
  mission.progressMeters = mission.lengthMeters - 1;
  mission.currentLat = mission.coordinates[1].lat;
  mission.currentLng = mission.coordinates[1].lng;
  mission.stopIndex = mission.stops.length;
  mission.departureTime = new Date(Date.now() - 60_000).toISOString();
  mission.arrivalTime = new Date(Date.now() + 60_000).toISOString();
  mission.lastTickAt = Date.now() - 1000;

  await autorun.tickTripMissions();

  assert.equal(mission.status, 'Completed');
  assert.equal(published.at(-1).tripId, null);
  assert.equal(published.at(-1).routeCode, null);
  assert.equal(published.at(-1).fromTrip, false);
  assert.equal(published.at(-1).status, 'idle');
});
