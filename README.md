# Waterbus GPS Route Survey

Thu thập tuyến GPS Saigon Waterbus: vẽ đường trên map → mô phỏng tàu chạy → POST GPS lên Azure → lưu route (`/api/routes/from-gps` hoặc Neon).

## Stack

- Node.js HTTP server (`src/server.js`)
- UI: HTML + Leaflet + Turf (`public/`)
- DB: Neon PostgreSQL
- BE GPS: Azure Waterbus API

## Chạy local (test)

```bash
cp .env.example .env
# Điền DATABASE_URL + TARGET_GPS_ENDPOINT
npm install
npm run dev
```

Mở: http://localhost:5177

Checklist test:

1. Chọn bến đầu / cuối → vẽ điểm dọc sông → **Xong** (đường cong)
2. Kiểm tra km / phút = `(km / tốc độ) × 60`
3. **Bắt đầu ghi GPS** — đường vẫn còn trên map khi tàu chạy
4. Tàu đến đích → tự lưu (Azure hoặc fallback Neon)
5. `GET /api/health` trả `{ ok: true }`

## Vì sao không dùng Vercel?

App cần:

- SSE `/events` (kết nối dài)
- `setInterval` mô phỏng GPS liên tục

**Vercel serverless** không phù hợp (timeout, không giữ process).  
Deploy chuẩn: **Railway** hoặc **Render** (connect GitHub giống Vercel).

## Deploy Railway (khuyến nghị)

1. Vào [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub**
2. Chọn repo `hoangnhse170060/gps_waterbus`
3. **Variables** (Settings → Variables), copy từ `.env` local:

| Biến | Bắt buộc |
|------|----------|
| `DATABASE_URL` | Có (Neon) |
| `TARGET_GPS_ENDPOINT` | Có (Azure tracking URL) |
| `SEND_TO_TARGET` | `true` |
| `TARGET_GPS_API_KEY` | Nếu BE yêu cầu |
| `DEFAULT_SPEED_KMH` | `16` |
| `USE_FALLBACK_WHEN_EMPTY` | `true` |

4. Railway tự set `PORT` — không cần ghi đè
5. Generate Domain → mở URL public để demo/test

Health check: `https://YOUR-APP.up.railway.app/api/health`

## API chính

**Local server**

- `GET /events` — realtime SSE
- `POST /api/collector/start|stop` — ghi GPS
- `POST /api/recording/save-route` — lưu tuyến
- `GET /api/health` — healthcheck

**Azure (proxy qua server)**

- `POST /api/tracking/locations`
- `POST /api/tracking/sessions/start`
- `POST /api/routes/from-gps`

### Reset trip / đưa tàu về bến

GPS relay kết nối `/hubs/tracking`, gọi `JoinBoat(boatId)` cho từng tàu và nghe event
`tripsReset`. Mỗi phần tử trong `removedTrips` được gỡ khỏi trip hiện tại rồi điều hướng
về `endStationCode` theo hành lang sông. Trong lúc quay về GPS gửi `tripId=null`,
`movementStatus=Moving`; khi đến bến gửi `movementStatus=AtStation` và
`currentStationCode`.

Trip đang `InProgress`/đã rời bến hoặc payload báo còn hành khách sẽ không tự quay về;
kết quả ACK trả `requiresAdminConfirmation=true`. `keptActiveTrips` luôn được giữ nguyên.

Mặc định GPS ACK qua hub method `AcknowledgeTripsReset`. Có thể đổi tên method bằng
`SIGNALR_TRIPS_RESET_ACK_METHOD`; method join group đổi bằng `SIGNALR_JOIN_BOAT_METHOD`.
BE cũng có thể fallback push cùng payload qua `POST /api/gps/trips/hook` với
`event="tripsReset"` và header `X-Live-Hook-Secret`.

## Bảo mật

- Không commit `.env`
- Dùng `.env.example` làm mẫu
