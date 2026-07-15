/**
 * Phút chạy theo lịch Saigon Waterbus (bảng giờ D3/D6).
 * Key: FROM|TO theo stationCode (hai chiều đủ cặp).
 * Nguồn: bản đồ + giờ khởi hành Bạch Đằng ↔ Linh Đông.
 */
export const WATERBUS_SCHEDULE_NOTE = 'Saigon Waterbus timetable (BD↔LD active line)';

export const WATERBUS_SEGMENT_MINUTES = Object.freeze({
  // Bạch Đằng → Linh Đông
  'ST-BD|ST-TT': 5,
  'ST-TT|ST-BA': 15,
  'ST-BA|ST-TD2': 5,
  'ST-TD2|ST-TD': 12,
  'ST-TD|ST-HBC': 10,
  'ST-HBC|ST-LD': 10,
  // Linh Đông → Bạch Đằng
  'ST-LD|ST-HBC': 10,
  'ST-HBC|ST-TD': 10,
  'ST-TD|ST-TD2': 12,
  'ST-TD2|ST-BA': 5,
  'ST-BA|ST-TT': 15,
  'ST-TT|ST-BD': 5,
});

export function scheduleTravelMinutes(fromCode, toCode) {
  const from = String(fromCode || '').trim().toUpperCase();
  const to = String(toCode || '').trim().toUpperCase();
  if (!from || !to) return null;
  const value = WATERBUS_SEGMENT_MINUTES[`${from}|${to}`];
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

export function waterbusSchedulePublic() {
  return {
    note: WATERBUS_SCHEDULE_NOTE,
    segments: { ...WATERBUS_SEGMENT_MINUTES },
  };
}
