/**
 * 🧪 Test Simulation: Marker bám GPS mới nhất
 * 
 * Script này mô phỏng việc thay đổi tọa độ hub và kiểm tra
 * xem marker có giữ đúng tọa độ hub, trừ khi trip xác nhận tàu đang ở bến.
 */

// Mock data - BẠN CẦN ĐIỀN DATA THẬT VÀO ĐÂY
const mockStations = [
  { stationCode: 'TNC', stationName: 'Thanh Niên Center', lat: 10.7756, lng: 106.7012 },
  { stationCode: 'ST-BD', stationName: 'Bạch Đằng', lat: 10.7712, lng: 106.7056 },
  { stationCode: 'ST-BS', stationName: 'Ba Son', lat: 10.7820162, lng: 106.7092747 },
  { stationCode: 'BD', stationName: 'Bình Đông', lat: 10.7489, lng: 106.6823 },
  { stationCode: 'T1', stationName: 'Terminal 1', lat: 10.7234, lng: 106.6891 },
];

// Test scenarios
const testScenarios = [
  {
    name: 'Test 1: Tàu không có trip - giữ GPS giữa sông',
    boatCode: 'BD',
    hubPosition: { lat: 10.7600, lng: 106.6900 }, // Giữa sông
    hasTrip: false,
    hasRescue: false,
    hasIncident: false,
    expectedBehavior: 'use-hub-position'
  },
  {
    name: 'Test 2: Tàu có trip - hub ở giữa sông',
    boatCode: 'T1',
    hubPosition: { lat: 10.7600, lng: 106.6900 },
    hasTrip: true,
    hasRescue: false,
    hasIncident: false,
    expectedBehavior: 'use-hub-position'
  },
  {
    name: 'Test 3: Tàu không có trip - không tự snap về bến',
    boatCode: 'BS',
    hubPosition: { lat: 10.7720, lng: 106.7050 }, // Gần bến BS
    hasTrip: false,
    hasRescue: false,
    hasIncident: false,
    expectedBehavior: 'use-hub-position'
  },
  {
    name: 'Test 4: Tàu đang rescue - hub ở giữa sông',
    boatCode: 'SOS1',
    hubPosition: { lat: 10.7500, lng: 106.6950 },
    hasTrip: false,
    hasRescue: true,
    hasIncident: false,
    expectedBehavior: 'use-hub-position'
  },
  {
    name: 'Test 5: Tàu WaitingAtStop - bỏ hub ngoài sông và nhảy đúng bến',
    boatCode: 'BS',
    hubPosition: { lat: 10.7702, lng: 106.7068 },
    hasTrip: true,
    tripStatus: 'WaitingAtStop',
    movementStatus: 'AtStation',
    currentStationCode: 'ST-BS',
    tripPosition: { lat: 10.7756, lng: 106.7012 },
    hasRescue: false,
    hasIncident: false,
    expectedBehavior: 'snap-to-trip-station'
  },
  {
    name: 'Test 6: Tàu không có trip nhưng GPS đang chạy - giữ vị trí hub',
    boatCode: 'FREE-MOVING',
    hubPosition: { lat: 10.7600, lng: 106.6900 },
    speedKmh: 12,
    hasTrip: false,
    hasRescue: false,
    hasIncident: false,
    expectedBehavior: 'use-hub-position'
  },
  {
    name: 'Test 7: Tàu báo sự cố được phép dừng giữa sông',
    boatCode: 'INCIDENT-01',
    hubPosition: { lat: 10.7600, lng: 106.6900 },
    speedKmh: 0,
    hasTrip: false,
    hasRescue: false,
    hasIncident: true,
    expectedBehavior: 'use-hub-position'
  },
  {
    name: 'Test 8: GPS còn status moving nhưng tốc độ 0 - vẫn giữ GPS',
    boatCode: 'STALE-MOVING',
    hubPosition: { lat: 10.7600, lng: 106.6900 },
    speedKmh: 0,
    gpsStatus: 'moving',
    hasTrip: false,
    hasRescue: false,
    hasIncident: false,
    expectedBehavior: 'use-hub-position'
  }
];

// Simulate logic từ boatMapLatLng
function simulateBoatPosition(scenario, stations) {
  const {
    boatCode,
    hubPosition,
    hasTrip,
    hasRescue,
    hasIncident,
    tripStatus,
    movementStatus,
    currentStationCode,
    tripPosition,
  } = scenario;
  
  console.log('\n' + '='.repeat(70));
  console.log(`🧪 ${scenario.name}`);
  console.log('='.repeat(70));
  console.log(`Tàu: ${boatCode}`);
  console.log(`Hub position: ${hubPosition.lat}, ${hubPosition.lng}`);
  console.log(`Has trip: ${hasTrip ? '✅' : '❌'}`);
  console.log(`Has rescue: ${hasRescue ? '✅' : '❌'}`);
  console.log(`Has incident: ${hasIncident ? '✅' : '❌'}`);
  
  // Logic từ boatMapLatLng
  let result;
  let source;

  const tripIsAtStation = hasTrip && (
    ['Boarding', 'WaitingAtStop'].includes(String(tripStatus || ''))
    || String(movementStatus || '').toLowerCase() === 'atstation'
  );
  if (tripIsAtStation) {
    const stationKey = String(currentStationCode || '').replace(/^ST[-_]?/i, '').toUpperCase();
    const station = stations.find((row) => (
      String(row.stationCode || '').replace(/^ST[-_]?/i, '').toUpperCase() === stationKey
    ));
    result = station
      ? { lat: station.lat, lng: station.lng }
      : { lat: tripPosition.lat, lng: tripPosition.lng };
    source = station ? 'trip-station' : 'trip-station-mission';
    console.log(`\n📍 Kết quả: Trip đang ở bến → dùng đúng tọa độ bến`);
  } else {
    // Tọa độ GPS là nguồn truth, kể cả khi không có trip hoặc tốc độ đang bằng 0.
    result = { lat: hubPosition.lat, lng: hubPosition.lng };
    source = 'hub';
    console.log(`\n📍 Kết quả: Dùng hub position`);
  }
  
  console.log(`\n🎯 Final position: ${result.lat}, ${result.lng}`);
  console.log(`📦 Source: ${source}`);
  
  // Verify kết quả
  const expected = scenario.expectedBehavior;
  const actualBehavior = source.startsWith('trip-station')
    ? 'snap-to-trip-station'
    : 'use-hub-position';
  
  if (expected === actualBehavior) {
    console.log(`\n✅ PASS: Kết quả đúng như mong đợi!`);
  } else {
    console.log(`\n❌ FAIL: Mong đợi '${expected}' nhưng nhận được '${actualBehavior}'`);
  }
  
  return { result, source, passed: expected === actualBehavior };
}

// Run all tests
console.log('🚀 Bắt đầu test simulation...\n');
console.log('📊 Danh sách bến:');
mockStations.forEach(s => {
  console.log(`   - ${s.stationCode}: ${s.stationName} (${s.lat}, ${s.lng})`);
});

const results = testScenarios.map(scenario => 
  simulateBoatPosition(scenario, mockStations)
);

// Summary
console.log('\n' + '='.repeat(70));
console.log('📊 TÓM TẮT KẾT QUẢ TEST');
console.log('='.repeat(70));
const passed = results.filter(r => r.passed).length;
const total = results.length;
console.log(`✅ Passed: ${passed}/${total}`);
console.log(`❌ Failed: ${total - passed}/${total}`);
console.log(`📈 Success rate: ${((passed/total) * 100).toFixed(1)}%`);

if (passed === total) {
  console.log(`\n🎉 TẤT CẢ TEST ĐỀU PASS! Logic hoạt động chính xác!`);
} else {
  console.log(`\n⚠️  Có ${total - passed} test bị fail. Cần kiểm tra lại logic.`);
  throw new Error(`${total - passed} snap simulation test(s) failed`);
}
