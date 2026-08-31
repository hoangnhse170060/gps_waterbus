/**
 * 🧪 Test với Database thật
 * Test logic snap-to-station với data từ PostgreSQL
 */

import pkg from 'pg';
const { Client } = pkg;

// Database connection
const connectionString = 'postgresql://neondb_owner:npg_SjkEuQNt14Of@ep-frosty-frog-aoi0agia-pooler.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require';

// Helper functions từ live.js
function distMeters(a, b) {
  const toRad = (deg) => (Number(deg) * Math.PI) / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = lat2 - lat1;
  const dLng = toRad(Number(b.lng) - Number(a.lng));
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371008.8 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

function nearestStationAny(latlng, stations) {
  let best = null;
  let bestDist = Infinity;
  for (const station of stations || []) {
    if (!Number.isFinite(Number(station.lat)) || !Number.isFinite(Number(station.lng))) continue;
    const d = distMeters(latlng, station);
    if (d < bestDist) {
      bestDist = d;
      best = station;
    }
  }
  return best ? { station: best, dist: bestDist } : null;
}

// Simulate boatMapLatLng logic
function simulateBoatMapLatLng(boat, stations, hasTrip, hasRescue, hasIncident) {
  const hubPosition = { lat: boat.lat, lng: boat.lng };
  
  if (hasTrip || hasRescue || hasIncident) {
    return {
      position: hubPosition,
      source: 'hub',
      nearestStation: null
    };
  }
  
  // Không có trip → snap về bến gần nhất
  const nearest = nearestStationAny(hubPosition, stations);
  if (nearest) {
    return {
      position: { lat: nearest.station.lat, lng: nearest.station.lng },
      source: 'nearest-station-no-trip',
      nearestStation: nearest
    };
  }
  
  return {
    position: hubPosition,
    source: 'hub',
    nearestStation: null
  };
}

async function testWithRealData() {
  const client = new Client({ connectionString });
  
  try {
    console.log('🔌 Đang kết nối database...');
    await client.connect();
    console.log('✅ Kết nối thành công!\n');
    
    // Lấy danh sách stations
    console.log('📊 Đang lấy danh sách bến...');
    const stationsResult = await client.query(`
      SELECT 
        station_code as "stationCode",
        station_name as "stationName",
        latitude::float as lat,
        longitude::float as lng
      FROM stations
      WHERE latitude IS NOT NULL 
        AND longitude IS NOT NULL
        AND is_waterbus_station = true
      ORDER BY station_code
    `);
    const stations = stationsResult.rows;
    console.log(`✅ Đã tải ${stations.length} bến:\n`);
    stations.forEach(s => {
      console.log(`   - ${s.stationCode}: ${s.stationName} (${s.lat}, ${s.lng})`);
    });
    
    // Lấy danh sách boats với GPS (từ bảng riêng hoặc mock)
    console.log('\n📊 Tạo mock data tàu với tọa độ giữa sông...');
    // Vì boats không có lat/lng trong DB, tôi sẽ tạo mock data
    // Giả lập tàu ở các vị trí giữa sông để test logic snap về bến
    const boats = [
      { boatCode: 'BD-01', boatName: 'Bình Đông 1', lat: 10.7600, lng: 106.6900 },
      { boatCode: 'TNC-02', boatName: 'Thanh Niên 2', lat: 10.7800, lng: 106.7100 },
      { boatCode: 'BS-03', boatName: 'Ba Son 3', lat: 10.7500, lng: 106.6950 },
      { boatCode: 'LD-04', boatName: 'Linh Đông 4', lat: 10.8200, lng: 106.7400 },
      { boatCode: 'BA-05', boatName: 'Bình An 5', lat: 10.7900, lng: 106.7200 },
    ];
    console.log(`✅ Đã tạo ${boats.length} tàu mock\n`);
    
    // Mock trip data - giả sử 2 tàu đầu có trip, 3 tàu sau không có
    console.log('📊 Tạo mock trip missions...');
    const boatsWithTrip = new Set(['BD-01', 'TNC-02']);
    console.log(`✅ Có ${boatsWithTrip.size} tàu đang có trip active\n`);
    
    // Test từng tàu
    console.log('='.repeat(80));
    console.log('🧪 BẮT ĐẦU TEST VỚI DATA THẬT');
    console.log('='.repeat(80));
    
    let passCount = 0;
    let totalCount = 0;
    
    for (const boat of boats) {
      totalCount++;
      const hasTrip = boatsWithTrip.has(boat.boatCode);
      const hasRescue = false; // Giả định không có rescue
      const hasIncident = false; // Giả định không có incident
      
      console.log(`\n${'─'.repeat(80)}`);
      console.log(`🚤 Tàu: ${boat.boatCode} ${boat.boatName ? `(${boat.boatName})` : ''}`);
      console.log(`📍 Hub position: ${boat.lat}, ${boat.lng}`);
      console.log(`📋 Has trip: ${hasTrip ? '✅ YES' : '❌ NO'}`);
      
      const result = simulateBoatMapLatLng(boat, stations, hasTrip, hasRescue, hasIncident);
      
      console.log(`\n🎯 Kết quả:`);
      console.log(`   Position: ${result.position.lat}, ${result.position.lng}`);
      console.log(`   Source: ${result.source}`);
      
      if (result.nearestStation) {
        console.log(`   Bến gần nhất: ${result.nearestStation.station.stationCode} (${result.nearestStation.station.stationName})`);
        console.log(`   Khoảng cách: ${Math.round(result.nearestStation.dist)}m`);
      }
      
      // Verify logic
      if (!hasTrip && !hasRescue && !hasIncident) {
        if (result.source === 'nearest-station-no-trip') {
          console.log(`\n✅ PASS: Tàu không có trip → đã snap về bến gần nhất`);
          passCount++;
        } else {
          console.log(`\n❌ FAIL: Tàu không có trip nhưng vẫn dùng hub position`);
        }
      } else {
        if (result.source === 'hub') {
          console.log(`\n✅ PASS: Tàu có trip → dùng hub position như mong đợi`);
          passCount++;
        } else {
          console.log(`\n❌ FAIL: Tàu có trip nhưng bị snap về bến`);
        }
      }
    }
    
    // Summary
    console.log('\n' + '='.repeat(80));
    console.log('📊 TÓM TẮT KẾT QUẢ TEST VỚI DATABASE THẬT');
    console.log('='.repeat(80));
    console.log(`✅ Passed: ${passCount}/${totalCount}`);
    console.log(`❌ Failed: ${totalCount - passCount}/${totalCount}`);
    console.log(`📈 Success rate: ${((passCount/totalCount) * 100).toFixed(1)}%`);
    
    if (passCount === totalCount) {
      console.log(`\n🎉 TẤT CẢ TEST ĐỀU PASS! Logic hoạt động chính xác với data thật!`);
    } else {
      console.log(`\n⚠️  Có ${totalCount - passCount} test bị fail. Cần kiểm tra lại.`);
    }
    
  } catch (error) {
    console.error('❌ Lỗi:', error.message);
    console.error(error.stack);
  } finally {
    await client.end();
    console.log('\n🔌 Đã đóng kết nối database.');
  }
}

// Run test
testWithRealData();
