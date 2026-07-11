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

## Bảo mật

- Không commit `.env`
- Dùng `.env.example` làm mẫu
