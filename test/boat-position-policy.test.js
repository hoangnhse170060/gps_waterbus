import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveCatalogBoatPosition,
  shouldPublishCatalogBoat,
} from '../src/boat-position-policy.js';
import { projectOnPath } from '../src/river-corridor.js';

const corridor = [
  { lat: 10.7750, lng: 106.7077 },
  { lat: 10.7768, lng: 106.7096 },
  { lat: 10.7800, lng: 106.7110 },
];

test('catalog boat with an off-river saved position is seeded on the river corridor', () => {
  const saved = { lat: 10.7900, lng: 106.7200 };
  const result = resolveCatalogBoatPosition({
    lastPosition: saved,
    stations: [{ lat: 10.7752, lng: 106.7073 }],
    riverPath: corridor,
  });
  const projected = projectOnPath(corridor, saved);

  assert.ok(projected);
  assert.equal(result.lat, projected.lat);
  assert.equal(result.lng, projected.lng);
  assert.ok(Number.isFinite(result.heading));
});

test('catalog boat prefers the current hub position over stale saved and route positions', () => {
  const hub = { lat: 10.7760, lng: 106.7090 };
  const result = resolveCatalogBoatPosition({
    hubPosition: hub,
    lastPosition: { lat: 10.8000, lng: 106.7300 },
    existingPosition: { lat: 10.8100, lng: 106.7400 },
    riverPath: corridor,
  });
  const projected = projectOnPath(corridor, hub);

  assert.equal(result.lat, projected.lat);
  assert.equal(result.lng, projected.lng);
});

test('periodic catalog publisher excludes idle boats and the active survey boat', () => {
  assert.equal(shouldPublishCatalogBoat({ boatCode: 'WB_001' }), false);
  assert.equal(shouldPublishCatalogBoat({ boatCode: 'WB_001', hasActiveTrip: true }), true);
  assert.equal(shouldPublishCatalogBoat({ boatCode: 'WB_001', hasActiveRescue: true }), true);
  assert.equal(shouldPublishCatalogBoat({
    boatCode: 'WB_001',
    surveyBoatCode: 'WB_001',
    hasActiveTrip: true,
  }), false);
});
