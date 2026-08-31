import { pointAtDistance, projectOnPath } from './river-corridor.js';

function validPoint(value) {
  const lat = Number(value?.lat);
  const lng = Number(value?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/**
 * Catalog boats must start on the river. Prefer a known live/saved position,
 * then a station; every candidate is projected onto the Waterbus corridor.
 */
export function resolveCatalogBoatPosition({
  hubPosition,
  lastPosition,
  existingPosition,
  stations = [],
  riverPath = [],
  fallback = { lat: 10.776, lng: 106.705 },
} = {}) {
  const station = (stations || []).map(validPoint).find(Boolean);
  const candidate = [hubPosition, lastPosition, existingPosition, station, fallback]
    .map(validPoint)
    .find(Boolean) || { lat: 10.776, lng: 106.705 };
  const projection = projectOnPath(riverPath, candidate);
  if (!projection) return { ...candidate, heading: 0 };
  const onPath = pointAtDistance(riverPath, projection.alongMeters);
  return {
    lat: projection.lat,
    lng: projection.lng,
    heading: onPath.heading,
  };
}

export function shouldPublishCatalogBoat({
  boatCode,
  surveyBoatCode,
  hasActiveTrip = false,
  hasActiveRescue = false,
} = {}) {
  const code = String(boatCode || '').trim();
  if (!code || (surveyBoatCode && code === String(surveyBoatCode).trim())) return false;
  return hasActiveTrip || hasActiveRescue;
}
