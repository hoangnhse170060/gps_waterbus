export function liveGpsOwnerMode({
  fromTrip = false,
  fromRescue = false,
  tripOwned = false,
  rescueOwned = false,
} = {}) {
  if (rescueOwned && !fromRescue) return 'rescue-owned';
  if (tripOwned && !fromTrip && !fromRescue) return 'trip-owned';
  return null;
}
