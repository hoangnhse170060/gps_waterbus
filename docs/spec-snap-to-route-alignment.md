# Spec: Thống nhất logic Snap-to-Route giữa BE/FE/GPS

**Trạng thái:** Đang chờ align GPS team  
**Người soạn:** FE team  
**Phạm vi:** Tracking pipeline (GPS → BE → FE)  
**Liên quan:** Issue "Tàu hiển thị lệch khỏi route khi dừng bến"

---

## 1. Bối cảnh

Hiện tại có 2 hiện tượng quan sát được:

### 1.1. Tàu hiển thị lệch khỏi route (ảnh 1 - HBC station)
- Khi tàu dừng ở bến, marker tàu trên FE không nằm trên đường `routeGeometry` mà BE cung cấp
- Lệch có thể đến vài chục mét tùy độ chính xác GPS

### 1.2. FE không phản ánh đúng khi BE "nhảy tàu" (ảnh 2, 3)
- Phía BE/GPS đã xử lý việc tàu chuyển trip / chuyển bến đúng
- Nhưng FE cập nhật chậm hoặc giữ vị trí cũ
- Nguyên nhân: Có thể là timing issue giữa hub broadcast vs REST polling, hoặc FE cache vị trí cũ

---

## 2. Nguyên tắc hiện tại (KHÔNG thay đổi)

```
GPS app → POST /api/tracking/locations 
  → BE validate, resolve trip/station, ghi DB (boat_latest_locations) 
  → BE broadcast BoatLocationUpdated qua SignalR hub
  → FE Admin nhận hub event ngay; REST polling là fallback
```

- **BE/DB là Single Source of Truth** (bảng `boat_latest_locations`)
- **SignalR hub chỉ broadcast realtime**, không persist
- **FE Admin (`useLiveBoatTracking.js`) đã subscribe `BoatLocationUpdated`** — SignalR là kênh chính; REST polling chạy song song mỗi 5 giây để reconciliation. Khi Hub mất kết nối, REST polling là nguồn cập nhật duy nhất
- **GPS app (mobile) là bên POST** `/api/tracking/locations`
- **FE Admin chỉ GET** `/tracking/boats/latest` và nhận hub events
- **FE chỉ vẽ routeGeometry từ BE** — không tự nối GPS thành tuyến
- **FE hiển thị marker từ tọa độ BE trả về; BE còn dùng tọa độ GPS để suy ra bến, ETA và trạng thái.** Raw GPS không chỉ phục vụ FE.

---

## 3. Câu hỏi cần GPS team xác nhận

Trước khi thiết kế snap-to-route ở BE, cần align các điểm sau:

### 3.1. Metadata GPS gửi lên

GPS hiện gửi kèm các field nào trong body `POST /api/tracking/locations`?

| Field | Hiện tại | Mục đích |
|-------|-----------|----------|
| `tripId` | Optional | Xác định chuyến hiện tại. Nếu thiếu, BE suy ra từ active trip theo thời gian (±30 phút trước/sau giờ chuyến) |
| `routeCode` | Optional | Xác định tuyến đường |
| `nextStationId` | Optional | Trạm tiếp theo trong lộ trình. Nếu thiếu, BE suy ra từ TripStop |
| `sequence` | Optional (contract yêu cầu) | Sắp xếp thứ tự khi `recordedAt` bằng nhau. BE chỉ từ chối khi < 0; thiếu field → mặc định 0 |
| `status` | Optional | Trạng thái tàu |

**Câu hỏi:** 
1. GPS app có thể gửi đủ `tripId` + `nextStationId` chính xác theo từng chuyến không? 
2. **Quan trọng:** Khi tàu đổi chuyến, GPS có refresh `tripId` ngay không? Nếu gửi `tripId` cũ, BE chỉ validate tồn tại/tàu/route chứ không tự sửa; nếu không gửi, BE suy luận trong cửa sổ ±30 phút — cả 2 đều có risk khi chuyến overlap hoặc tàu chạy lẫn lộn.

### 3.2. Độ lệch GPS thực tế

- Trung bình GPS mobile trên sông lệch bao nhiêu mét?
- Có trường hợp nào tàu dừng bến mà GPS lệch > 50m không?
- Đã đo ở môi trường thực tế (TP.HCM, sông Sài Gòn) chưa?

### 3.3. Khi tàu lệch tuyến — hiển thị hay ép về route?

Có 2 hướng tiếp cận:

| Hướng | Ưu | Nhược |
|-------|----|------|
| **A. Ép về route** (snap) | Marker luôn nằm trên đường → UX đẹp, dễ theo dõi | Có thể che lấp lỗi GPS thực; nếu tàu đi lạc thật cũng bị "kéo về" |
| **B. Giữ vị trí thật** | Audit được GPS gốc, phát hiện sai lệch bất thường | Marker nhảy lung tung khi GPS kém chất lượng |

**Câu hỏi:** Sản phẩm cần hướng nào? Hay hybrid (giữ GPS thô cho audit, trả vị trí đã hiệu chỉnh cho FE)?

### 3.4. Tần suất gửi GPS packet và trạng thái online

**Hiện trạng:**
- BE không đảm bảo luôn nhận được packet mới nhất (nếu GPS không gửi liên tục hoặc mất mạng)
- Khi GPS gửi thành công, BE ưu tiên packet có `recordedAt` mới nhất
- Packet đến muộn không ghi đè vị trí hiện tại

**Câu hỏi cần GPS team xác nhận:**

| Tình huống | Tần suất hiện tại | Mong muốn |
|------------|-------------------|-----------|
| Tàu đang chạy | ? giây/lần | 2-5s/lần |
| Tàu dừng bến | ? giây/lần | 10-15s/lần |
| Mất mạng | Có queue và resend không? | Queue với `recordedAt` + `sequence` đúng |

**Đề xuất:**
- **Đang chạy:** gửi mỗi 2-5 giây
- **Dừng bến:** gửi mỗi 10-15 giây (heartbeat)
- **Bao gồm:** `recordedAt` (UTC) + `sequence` tăng dần
- **BE hiển thị `isOnline=false`** nếu không có latest update được BE chấp nhận trong 60 giây (packet cũ/replay bị từ chối không làm mới `boat_latest_locations`)

**Câu hỏi:** GPS app hiện có logic tự động điều chỉnh tần suất gửi theo trạng thái tàu không?

---

## 4. Đề xuất hướng đi (sau khi align)

### Phase 1 — Giữ nguyên logic hiện tại (KHÔNG sửa gì)
- BE tiếp tục nhận GPS và ghi vào `boat_latest_locations` (latest position, không phải full raw history)
- Khi phát hiện GPS nhảy bất thường, BE có thể giữ tọa độ trước đó thay vì ghi đè
- Full raw track history chỉ có khi tracking session đang hoạt động
- FE tiếp tục hiển thị GPS từ BE
- Thu thập số liệu: đo độ lệch trung bình, số lần nhảy xa

### Phase 2 — Sau khi có data, thiết kế snap ở BE
```
GPS app → POST /api/tracking/locations với raw GPS
  → BE nhận, snap vào routeGeometry
  → BE lưu vào boat_latest_locations:
     - Nếu cần audit: lưu thêm rawLat/rawLng (hiện chưa có)
     - displayLat/displayLng: vị trí đã snap (cho FE hiển thị)
  → BE broadcast BoatLocationUpdated với vị trí đã snap
  → FE nhận vị trí đã hiệu chỉnh qua hub/REST
```

**Lý do làm ở BE:**
- ✅ Single source of truth
- ✅ FE/Admin/Mobile đều nhận vị trí đã hiệu chỉnh

**Lưu ý:**
- **ETA hiện tính theo khoảng cách thẳng hoặc GPS gửi sẵn** — snap marker không tự biến ETA thành ETA theo đường sông. Nếu cần ETA chính xác theo route, Phase 2 phải thiết kế route-distance calculation riêng.
- **Audit raw GPS:** Hiện bảng `boat_latest_locations` lưu latest position, không lưu full track history. Nếu Phase 2 cần audit raw GPS đầy đủ, phải thiết kế thêm cột `rawLat`/`rawLng` hoặc bảng riêng `boat_gps_raw_history`.

### Phase 3 — Tối ưu realtime update (nếu cần)
- FE Admin đã subscribe SignalR (`useLiveBoatTracking.js`)
- Nếu vẫn thấy chậm/nhảy vị trí, cần debug:
  - Hub connection state (connected vs polling fallback)
  - Timing giữa hub event vs REST polling
  - FE cache logic khi nhận vị trí mới

---

## 5. Cần từ GPS team

1. ✅ Xác nhận các field trong payload GPS POST lên BE (mục 3.1)
2. ✅ Số liệu độ lệch GPS thực tế (mục 3.2)
3. ✅ Quyết định hướng hiển thị: snap hay giữ thô (mục 3.3)
4. ✅ Tần suất gửi packet và logic resend khi mất mạng (mục 3.4)
5. ✅ Timeline cho Phase 1 (thu thập data) — bao lâu đủ số liệu?

---

## 6. Out of scope (đã chốt — không làm)

- ❌ Snap-to-route trong FE (chỉ làm ở BE)
- ❌ Thay đổi format payload hiện tại trước khi align
- ❌ Sửa code trước khi có data thực tế về độ lệch GPS

---

## 7. Reference

- **GPS app**: POST `/api/tracking/locations` với raw GPS data
- **BE**: Xử lý GPS, lưu `boat_latest_locations`, broadcast SignalR
- **FE Admin**: 
  - `useLiveBoatTracking.js`: subscribe SignalR `BoatLocationUpdated`
  - GET `/tracking/boats/latest` làm fallback khi hub disconnect
- **FE Live GPS** (`public/live.js`):
  - `syncLiveHubPins` (dòng 876): nhận GPS từ snapshot, không snap
  - `startHeartbeat` (dòng 3027): gửi GPS từ manual drag
  - Hằng số: `SNAP_STATION_M = 28`, `APPROACH_M = 180` (snap **bến**, không snap **route**)

**Lưu ý:** Spec này chưa thay đổi code gì, logic hiện tại vẫn nguyên.