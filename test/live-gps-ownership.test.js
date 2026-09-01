import assert from 'node:assert/strict';
import test from 'node:test';
import { liveGpsOwnerMode } from '../src/live-gps-ownership.js';

test('regular Live GPS cannot overwrite an active trip', () => {
  assert.equal(liveGpsOwnerMode({ tripOwned: true }), 'trip-owned');
});

test('trip autorun remains authoritative for its active trip', () => {
  assert.equal(liveGpsOwnerMode({ tripOwned: true, fromTrip: true }), null);
});

test('regular and trip GPS cannot overwrite an active rescue', () => {
  assert.equal(liveGpsOwnerMode({ rescueOwned: true }), 'rescue-owned');
  assert.equal(
    liveGpsOwnerMode({ rescueOwned: true, tripOwned: true, fromTrip: true }),
    'rescue-owned',
  );
  assert.equal(liveGpsOwnerMode({ rescueOwned: true, fromRescue: true }), null);
});
