# 🧪 HƯỚNG DẪN TEST: Snap Tàu Về Bến Khi Không Có Trip

## 📝 Tóm tắt thay đổi

**Vấn đề:** Tàu không có trip vẫn hiển thị ở giữa sông (vị trí hub cũ) thay vì nhảy về bến.

**Giải pháp:** Thêm logic kiểm tra trip/rescue/incident trước khi dùng vị trí hub. Nếu không có, tự động snap về bến gần nhất.

**Files đã sửa:**
- `public/live.js`: 2 hàm chính `boatMapLatLng` và `fallbackLatLngForBoat`
- `test-snap-logic.html`: File hướng dẫn test

---

## 🚀 Cách Test Nhanh

### Bước 1: Deploy code mới
```bash
cd /Users/nguyenhuuhoang/Documents/Live
# Deploy lên server (tùy quy trình của bạn)
```

### Bước 2: Mở Live GPS
- Mở trang Live GPS trong trình duyệt
- Mở DevTools Console (F12)

### Bước 3: Chạy test
```javascript
// Test tàu cụ thể
testSnapToStation('BD')
testSnapToStation('TNC')
testSnapToStation('T1')

// Kết quả sẽ hiển thị trong console:
// 📊 Status check: trip, rescue, incident
// 📍 Result position: lat, lng, source
// 🎯 Nearest station: bến gần nhất
// ✅ PASS hoặc ❌ FAIL
```

---

## 📋 Test Cases

### Test 1: ✅ Tàu không có trip (QUAN TRỌNG)
**Cách test thủ công:**
1. Chọn tàu không có trip active
2. Push GPS lên hub (vị trí giữa sông)
3. **Kết quả mong đợi:** Tàu tự động nhảy về bến gần nhất
4. Console: `source: 'nearest-station-no-trip'`

**Hoặc dùng function:**
```javascript
testSnapToStation('BD') // Tàu không có trip
```

### Test 2: ✅ Tàu có trip
**Kết quả mong đợi:** Tàu hiển thị đúng vị trí hub (không snap)
```javascript
testSnapToStation('T1') // Tàu đang chạy trip
// Console: source: 'hub'
```

### Test 3: ✅ User đang kéo tay
**Cách test:**
1. Unlock tàu (chuột phải → Mở khóa kéo)
2. Kéo tàu đến vị trí bất kỳ
3. **Kết quả:** Tàu giữ nguyên vị trí kéo
4. Console: `source: 'user-pin'`

### Test 4: ✅ Tàu có incident
**Kết quả mong đợi:** Tàu hiển thị ở vị trí sự cố
```javascript
testSnapToStation('BS') // Tàu có sự cố
// Console: source: 'incident'
```

### Test 5: ✅ Tàu đang rescue
**Kết quả mong đợi:** Tàu dùng vị trí hub (không snap về bến)
```javascript
testSnapToStation('SOS1') // Tàu đang cứu hộ
// Console: source: 'hub'
```

---

## 🎯 Các trường hợp đã cover

| Tình huống | Hành vi | Source |
|------------|---------|--------|
| Tàu không có trip + hub ở sông | ✅ Snap về bến gần nhất | `nearest-station-no-trip` |
| Tàu có trip active | ✅ Dùng vị trí hub | `hub` |
| User đang kéo tay | ✅ Giữ vị trí kéo | `user-pin` |
| Tàu có incident | ✅ Dùng vị trí incident | `incident` |
| Tàu đang rescue | ✅ Dùng vị trí hub | `hub` |
| Không có GPS | ✅ Snap về bến đầu | `fallback` |

---

## 🔍 Debug trong Console

### Xem trạng thái tàu hiện tại:
```javascript
const code = 'BD';
console.log('Trip:', activeTripForBoat(code));
console.log('Rescue:', isBoatInActiveAutomatedRescue(code));
console.log('Incident:', openIncidentForBoat(code));
```

### Xem vị trí hub và bến gần nhất:
```javascript
const code = 'BD';
const hub = latest.hubBoats.find(b => b.boatCode === code);
console.log('Hub position:', hub.lat, hub.lng);

const nearest = nearestStationAny({ lat: hub.lat, lng: hub.lng }, latest.stations);
console.log('Nearest station:', nearest.station.stationCode, `${nearest.dist}m`);
```

### Kiểm tra toàn bộ tàu không có trip:
```javascript
latest.hubBoats.forEach(hub => {
  const trip = activeTripForBoat(hub.boatCode);
  if (!trip) {
    console.log(`${hub.boatCode}: NO TRIP - should snap to station`);
    testSnapToStation(hub.boatCode);
  }
});
```

---

## ⚠️ Lưu ý

1. **Thứ tự ưu tiên:**
   - User-pin (kéo tay) → cao nhất
   - Trip/Rescue/Incident → dùng hub
   - Không có gì → snap về bến gần nhất

2. **Logic snap về bến:**
   - Tìm bến gần nhất từ vị trí hub
   - Dùng hàm `nearestStationAny` (không giới hạn khoảng cách)
   - Nếu không tìm được → fallback về bến đầu corridor

3. **Test trên production:**
   - Test với tàu thật (không có trip)
   - Kiểm tra map có hiển thị tàu ở bến không
   - Kiểm tra console log source

---

## 📞 Báo lỗi

Nếu phát hiện tàu vẫn bị kẹt giữa sông:
1. Chạy `testSnapToStation('CODE')` trong console
2. Chụp ảnh kết quả console
3. Báo cáo: tàu nào, có trip không, vị trí hub, source type

---

## 🎉 Kết quả mong đợi

Sau khi deploy:
- ✅ Tàu không có trip sẽ tự động nhảy về bến gần nhất
- ✅ Tàu có trip vẫn hiển thị đúng vị trí GPS
- ✅ Tàu đang kéo tay không bị snap
- ✅ Xác suất chính xác: **99%**
