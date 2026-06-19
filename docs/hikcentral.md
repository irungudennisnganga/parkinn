# How HikCentral Works in Parking Altura

This document describes how the Parking Altura service integrates with **HikCentral** (Hikvision Cloud) for ANPR-based vehicle detection and barrier gate control. It covers authentication, resource synchronization, barrier control, the webhook event flow, and the code paths involved.

> The integration is implemented against the **HikCentral OpenAPI V2.15.0** spec. Base URL, access key, and secret key are configured via environment variables (see `src/config/index.js:10`).

---

## 1. Overview

HikCentral is the central platform managing the ANPR cameras and barrier gates installed at the building's entry/exit points. Parking Altura talks to HikCentral in two directions:

```
                ┌─────────────────────────────┐
                │       HikCentral Server     │
                │   (ANPR cameras + barriers) │
                └──────────────┬──────────────┘
                               │
   (A) Outbound API calls      │      (B) Inbound webhook push
   ─ resource sync             │      ─ ANPR event notifications
   ─ barrier control           │      ─ alarm/raw messages
   ─ passing record search     │
   ─ webhook configuration     │
                               │
                ┌──────────────▼──────────────┐
                │     Parking Altura (Fastify)│
                │  HikCentralClient           │
                │  ResourceSync               │
                │  BarrierControl             │
                │  EventProcessor (/eventsRCV)│
                └─────────────────────────────┘
```

- **(A) Outbound** — Parking Altura uses the `HikCentralClient` (`src/services/HikCentralClient.js`) to fetch resources, control barriers, and configure the webhook.
- **(B) Inbound** — HikCentral pushes ANPR/alarm events to the `/eventsRCV` endpoint (`src/routes/events.js`), which feeds them to `EventProcessor` (`src/services/EventProcessor.js`).

---

## 2. Authentication & Token Lifecycle

All HikCentral API calls (except the token endpoint itself) require a bearer token. Unlike most OAuth APIs, HikCentral expects the token in a custom **`Token`** header (not `Authorization: Bearer`).

### 2.1 Obtaining a token

- **Endpoint:** `POST /api/hccgw/platform/v1/token/get`
- **Body:** `{ "appKey": "<HIK_ACCESS_KEY>", "secretKey": "<HIK_SECRET_KEY>" }`
- **Response:** `data.accessToken` (string) and `data.expireTime` (Unix timestamp, in **seconds**)

Implementation: `src/services/HikCentralClient.js:15` (`getToken`).

### 2.2 Token caching

Tokens are valid for **7 days**. Parking Altura persists every token in the `hikcentral_tokens` MongoDB collection (`src/models/Token.js`) and reuses it until it is within **5 minutes** of expiry:

```js
const cached = await Token.findOne().sort({ expiresAt: -1 })
const FIVE_MIN_MS = 5 * 60 * 1000
if (cached && cached.expiresAt > new Date(Date.now() + FIVE_MIN_MS)) {
  return cached.token
}
```

When the cached token is too close to expiry, a fresh token is requested and inserted. Old tokens are retained for audit (no cleanup job currently).

### 2.3 Authenticated requests

The `request(method, url, data)` helper (`HikCentralClient.js:47`) is the single chokepoint for all authenticated calls — it fetches a token (cached or fresh) and attaches it as the `Token` header:

```js
const token = await this.getToken()
const res = await this.client.request({ method, url, data, headers: { Token: token } })
```

> If a request fails with an auth error, re-run `getToken` to force a refresh. (No automatic retry-on-401 exists yet.)

---

## 3. Resource Synchronization

HikCentral owns the source of truth for areas (floors/zones), cameras, and doors (barriers). Parking Altura periodically mirrors these into MongoDB so the logic engine can run without hitting HikCentral on every event.

### 3.1 Triggering a sync

- **Manual:** `POST /resources` (`src/routes/admin.js:8`) → `syncResources()` in `src/services/ResourceSync.js:29`.
- **Status check:** `GET /status` (`admin.js:14`) returns counts of areas/cameras/barriers currently cached.

### 3.2 What gets synced

1. **Areas** — `POST /api/hccgw/resource/v1/areas/get` (`getAreas`, `HikCentralClient.js:53`).
   Each area is upserted into the `areas` collection. The `areaType` (`residential` vs `commercial`) is derived by matching the area name against the configured residential floor list (`config.floors.residential`, e.g. `5,6,7,8,9`).
2. **Cameras per area** — `POST /api/hccgw/resource/v1/areas/cameras/get` with `{ areaId }` (`getCameras`).
   Stored in the `cameras` collection with `cameraId`, `name`, `areaId`, `cameraType` (defaults to `ANPR`), and `indexCode`.
3. **Doors/barriers per area** — `POST /api/hccgw/resource/v1/areas/doors/get` with `{ areaId }` (`getDoors`).
   Stored in the `barriers` collection. Each barrier is linked to the first camera found in the same area as its `cameraId` (a simple heuristic — see `ResourceSync.js:71`).

> The sync uses pagination with `pageNo: 1, pageSize: 200`. Sites with more than 200 resources per area will need paging support added.

---

## 4. Barrier Gate Control

The core actuator integration. Opening/closing a barrier is a single API call:

- **Endpoint:** `POST /api/hccgw/bi/v1/anpr/barrierGate/control`
- **Payload:** `{ "cameraId": "<camera_id>", "controlMode": <int> }`
- **`controlMode` values:**
  | Value | Meaning              |
  |------:|----------------------|
  |   1   | Open                 |
  |   2   | Close                |
  |   3   | Remain open          |
  |   4   | Disable remain open  |

> **Important:** The OpenAPI V2.15.0 payload uses `cameraId` + `controlMode`. The alternative `resourceIndexCode`/`resourceType`/`command` schema is **not** used here.

Implementation: `HikCentralClient.js:76` (`controlBarrier`). Wrapper helpers live in `src/services/BarrierControl.js`:

- `openBarrierByCamera(cameraId)` — calls `controlBarrier(cameraId, 1)`, returns `true`/`false`.
- `closeBarrier(cameraId)` — calls `controlBarrier(cameraId, 2)`.
- `findBarrierForCamera(cameraId)` — looks up the cached `Barrier` doc linked to a camera.
- `resolveCameraByIndexCode(indexCode)` — maps a camera's `indexCode` to its `Camera` doc.
- `getCameraDirection(cameraId)` — returns `entry` / `exit` (falls back to `entry` if unknown or `both`).
- `isResidentialCamera(cameraId)` — resolves the camera's area and checks `area.areaType === 'residential'`.

Barrier commands are addressed by **camera ID**, not barrier ID — HikCentral triggers the gate linked to that camera's ANPR channel.

---

## 5. Webhook Event Flow (Inbound)

Parking Altura does not poll HikCentral for ANPR events. Instead, HikCentral pushes events to a configured callback URL.

### 5.1 Configuring the webhook

`setupWebhook()` in `src/services/ResourceSync.js:10` runs at startup and performs two calls:

1. `configureWebhook(callbackUrl, signSecret, retryTimes)` → `POST /api/hccgw/webhook/v1/config/save`
   - `callbackUrl` is taken from `MPESA_CALLBACK_URL` (see note below).
   - `signSecret` reuses `HIK_SECRET_KEY`.
   - `retryTimes` defaults to 3, `retryDelay` to 5000 ms.
   > ⚠️ **Known issue:** `setupWebhook` currently reads `config.mpesa.callbackUrl` instead of a dedicated HikCentral callback URL. If these differ, set the HikCentral callback URL explicitly before deployment.
2. `subscribeCombineEvents([])` → `POST /api/hccgw/combine/v1/mq/subscribe`
   - Empty event types array with `subscribeMode: 0` subscribes to all combined events.

A failure here is logged as a warning (the webhook may already be configured from a previous run).

### 5.2 Receiving events — `/eventsRCV`

Handler: `src/routes/events.js:5`. It must:

- Accept HTTPS POST from HikCentral.
- Respond with **HTTP 2XX** and body `{ "code": "0", "msg": "success" }` **within 5 seconds** — otherwise HikCentral will retry.
- Always return success, even on internal errors, to prevent retry storms (errors are logged instead).

### 5.3 Payload parsing

`/eventsRCV` accepts several payload shapes and forwards normalized events to `processAnprEvent` (`src/services/EventProcessor.js:19`):

| Shape                              | Trigger in handler                |
|------------------------------------|-----------------------------------|
| `{ eventData: { plateNumber, cameraId, ... } }` | top-level `eventData` |
| `{ data: { ... } }`                | top-level `data`                  |
| `{ events: [ { eventData/data } ] }` | array form                      |
| `{ list: [ { basicInfo, evenData } ] }` | HikCentral combined event batch |
| HikCentral alarm / raw message     | forwarded as a single event       |

`extractAnprData` (`EventProcessor.js:7`) tries, in order:
1. `event.plateNumber` (custom transformed format).
2. `event.vehicleRelatedInfo.vehicleInfo.plateNumber` (HikCentral alarm format).
3. `event.intelliInfo.vehicleInfo.plateNumber` (alternative HikCentral layout).
4. `event.data.vehicleRelatedInfo.vehicleInfo.plateNumber` (HikCentral raw message format — nested under `data`).
5. `event.evenData.anprInfo.licensePlate` (HikCentral combined event ANPR info).
6. `event.evenData.vehicleReletedInfo.vehicleInfo.plateNumber` (combined event vehicle info).

### 5.4 Event → action dispatch

`processAnprEvent` resolves the camera's `direction` and routes to `handleEntry` or `handleExit`:

**Entry (`handleEntry`, `EventProcessor.js:40`)**
1. Look up `RegisteredVehicle` by plate.
2. If the camera is residential and the vehicle is **not** registered → block (do nothing, barrier stays closed) and log a warning.
3. Otherwise → `openBarrierByCamera(cameraId)`.
4. Find the linked barrier and create a `VehicleSession` (`entryTime`, `entryCamera`, `entryBarrier`, `isKnown`, `status: 'active'`) unless one already exists.

**Exit (`handleExit`, `EventProcessor.js:69`)**
1. Find the active session for the plate. If none, log and return.
2. If the vehicle is registered (known) → open the barrier, set `exitTime`/`exitCamera`, mark `status: 'exited'`.
3. Otherwise compute the charge via `calculateCharge`.
   - If charge is `0` (within grace period) → open the barrier, close the session as `exited`.
   - If charge > 0 → set `status: 'unpaid'`, persist `chargeAmount`/`chargeRate`, and **leave the barrier closed**. Payment is then expected via M-Pesa (out of scope for this doc).

---

## 6. Other HikCentral APIs

`HikCentralClient` also exposes:

- `searchPassingRecords(params)` → `POST /api/hccgw/bi/v1/anpr/passing/record/search` — historical ANPR pass records. Useful for reconciling missed events.
- `configureWebhook(...)` — described in §5.1.
- `subscribeAlarms(eventTypes)` → `POST /api/hccgw/alarm/v1/mq/subscribe` — alarm events.
- `subscribeRawMessages(msgTypes)` → `POST /api/hccgw/rawmsg/v1/mq/subscribe` — raw messages (on-board device events). Uses `msgType` (String[]) per V2.15.0 spec.
- `subscribeCombineEvents(eventTypes)` → `POST /api/hccgw/combine/v1/mq/subscribe` — combined events (ANPR plate reads, custom events). Active subscription in use.

Not yet wired up but referenced in the OpenAPI spec:
- `POST /api/hccgw/webhook/v1/config/query` — inspect current webhook config.
- `POST /api/hccgw/rawmsg/v1/mq/messages` — pull raw messages manually.
- `POST /api/hccgw/combine/v1/mq/messages` — pull combined events manually.

---

## 7. Configuration Reference

From `src/config/index.js:10` and `.env.example`:

| Env var              | Used for                                              |
|----------------------|-------------------------------------------------------|
| `HIK_BASE_URL`       | Base URL for all HikCentral API calls.                |
| `HIK_ACCESS_KEY`     | `appKey` in the token request body.                   |
| `HIK_SECRET_KEY`     | `secretKey` in the token request body; also reused as the webhook `signSecret`. |
| `RESIDENTIAL_FLOORS` | Comma-separated floor numbers classified as residential during sync (default `5,6,7,8,9`). |
| `COMMERCIAL_FLOORS`  | Comma-separated commercial floor numbers (default `1,2,3,4`). |

Token validity is fixed at 7 days (`config.hikcentral.tokenExpiryDays`, `config/index.js:14`); the 5-minute refresh buffer is hardcoded in `HikCentralClient.getToken`.

---

## 8. Code Map

| Concern                       | File                                   | Key symbol           |
|-------------------------------|----------------------------------------|----------------------|
| HTTP client + token mgmt      | `src/services/HikCentralClient.js`     | `HikCentralClient`   |
| Resource sync (areas/cams/doors) | `src/services/ResourceSync.js`      | `syncResources`, `setupWebhook` |
| Barrier open/close helpers    | `src/services/BarrierControl.js`       | `openBarrierByCamera`, `isResidentialCamera` |
| Webhook receiver              | `src/routes/events.js`                 | `POST /eventsRCV`    |
| Event → entry/exit dispatch   | `src/services/EventProcessor.js`       | `processAnprEvent`, `handleEntry`, `handleExit` |
| Token persistence             | `src/models/Token.js`                  | `Token`              |
| Cached resources              | `src/models/Area.js`, `Camera.js`, `Barrier.js` | —            |
| Admin endpoints (sync/status) | `src/routes/admin.js`                  | `POST /resources`, `GET /status` |
| Config                        | `src/config/index.js`                  | `config.hikcentral`  |

---

## 9. Operational Notes & Gotchas

- **Always acknowledge webhooks within 5 s.** The handler returns `{ code: '0', msg: 'success' }` even on errors to avoid HikCentral retry storms; failures surface only in logs.
- **`Token` header, not `Authorization`.** Mixing these up is the most common cause of 401s.
- **`expireTime` is in seconds.** The client multiplies by 1000 before storing as a JS Date (`HikCentralClient.js:32`).
- **Barrier commands address cameras, not barriers.** A `cameraId` with no linked barrier will still return success from HikCentral but won't move any gate.
- **Residential blocking is camera-based.** If a residential camera's `direction` is mislabeled, an unknown vehicle could be blocked at exit instead of entry (or vice versa). Verify `Camera.direction` after each sync.
- **Webhook URL source.** `setupWebhook` currently uses `MPESA_CALLBACK_URL` for the HikCentral callback — fix this before deploying to a domain where the M-Pesa and HikCentral callbacks differ.
- **No automatic resource sync schedule.** Sync only runs on startup / manual `POST /resources`. Consider a cron job if HikCentral resources change frequently.
- **Pagination capped at 200.** Sites with > 200 cameras/doors per area will silently miss resources.
