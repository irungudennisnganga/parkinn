# Parking Altura — System Architecture

## Overview

Integration service between **HikCentral** (ANPR cameras & barrier gates) and a parking management system for a mixed-use building:

- **Floors 1–4**: Commercial paid parking (unknown vehicles)
- **Floors 5–9**: Residential parking (known/registered vehicles)
- **Floor 1**: Entry/Exit point for commercial parking
- **Floor 5**: Entry/Exit point for residential parking; barrier that unknown cars cannot pass without payment

## High-Level Architecture

```
┌─────────────┐     ANPR Events (HTTPS push)     ┌──────────────────┐
│  HikCentral  │ ──────────────────────────────▶  │  Parking Altura  │
│  Server      │ ◀──────────────────────────────  │  (Fastify App)   │
│              │     Barrier control API calls     │                  │
│  (Cameras,   │                                   │  - Events RCV    │
│   Barriers)  │                                   │  - Token Cache   │
└─────────────┘                                   │  - Sync Svc      │
                                                  │  - Payment Svc   │
                                                  │  - Logic Engine  │
                                                  └──────┬───────────┘
                                                         │
                                                         ▼
                                                  ┌──────────────────┐
                                                  │    MongoDB       │
                                                  │  - Sessions      │
                                                  │  - Known plates  │
                                                  │  - Cached API    │
                                                  │    resources     │
                                                  └──────────────────┘
                                                         │
                                                  ┌───────┴────────┐
                                                  │   M-Pesa API   │
                                                  │   (Safaricom)  │
                                                  └────────────────┘
```

## Data Flow

### 1. Unknown Vehicle Entry (Floor 1 — Commercial)

1. Camera detects plate → HikCentral pushes event to `/eventsRCV`
2. Service checks: plate NOT in `registered_vehicles` collection
3. Service calls `POST /api/hccgw/bi/v1/anpr/barrierGate/control` (open)
4. Service creates a `VehicleSession` in MongoDB with `entryTime`, `cameraId`, `plate`
5. Barrier opens, vehicle enters
6. Vehicle now on floors 1–4 (commercial paid parking)

### 2. Unknown Vehicle Exit (Floor 1 — Commercial)

1. Camera detects plate at exit → event pushed to `/eventsRCV`
2. Service looks up active `VehicleSession` by plate
3. Calculates duration: `exitTime - entryTime`
4. Looks up applicable **charge rate** (e.g., per hour or flat rate)
5. **If balance is 0 / unpaid**: barrier stays closed; triggers M-Pesa STK push to phone number associated with session (or USSD code)
6. **If payment confirmed**: barrier opens, session closed with `Paid` status

### 3. Known (Registered) Vehicle Entry/Exit (Floors 1 & 5)

1. Camera detects plate → event pushed
2. Service checks: plate found in `registered_vehicles`
3. Barrier opens immediately (entry or exit)
4. Session is created for audit, but no charge applied

### 4. Unknown Vehicle at Floor 5 Barrier

1. Camera at floor 5 entry detects plate
2. Service checks: plate is NOT registered
3. Session has not been paid (unpaid unknown)
4. Barrier **stays closed** — prevents access to residential floors
5. (Optional: trigger payment request or alert security)

### 5. Payment via M-Pesa

1. Exit trigger → system calculates charge
2. System initiates **STK Push** to driver's phone (if known) or generates **USSD code**
3. Driver pays via M-Pesa
4. M-Pesa callback hits a `/mpesa/callback` endpoint
5. Callback body includes `BillRefNumber` = license plate (configured at STK push)
6. Service reconciles payment, marks session as `Paid`
7. On next poll or event, barrier opens

## Data Models (MongoDB Collections)

### `hikcentral_tokens`
| Field    | Type   | Description                  |
|----------|--------|------------------------------|
| _id      | ObjectId | Auto                        |
| token    | String | The HikCentral bearer token  |
| expiresAt| Date   | 7 days from issue            |

### `cameras` (cached from HikCentral)
| Field         | Type   | Description                     |
|---------------|--------|---------------------------------|
| cameraId      | String | HikCentral camera resource ID   |
| name          | String | Camera display name             |
| areaId        | String | The floor/zone this camera covers |
| cameraType    | String | e.g. ANPR, LPR                  |
| indexCode     | String | Camera index code (for API calls) |
| direction     | String | entry / exit / both             |

### `barriers` (cached from HikCentral — doors resource)
| Field       | Type   | Description                     |
|-------------|--------|---------------------------------|
| barrierId   | String | HikCentral door resource ID     |
| name        | String | Barrier display name            |
| areaId      | String | Floor/zone this barrier controls |
| cameraId    | String | Associated camera               |
| direction   | String | entry / exit                    |

### `areas` (cached from HikCentral)
| Field    | Type   | Description                   |
|----------|--------|-------------------------------|
| areaId   | String | HikCentral area ID            |
| name     | String | e.g. "Floor 1", "Floor 2"     |
| parentId | String | Parent area ID (for hierarchy)|
| areaType | String | commercial / residential      |

### `registered_vehicles`
| Field       | Type   | Description                    |
|-------------|--------|--------------------------------|
| plate       | String | License plate (unique)         |
| ownerName   | String | Resident name                  |
| unitNumber  | String | Apartment/unit number          |
| phoneNumber | String | For M-Pesa STK push            |
| floorAccess | [Number] | Array of accessible floor IDs|
| isActive    | Boolean | Active or deactivated          |

### `vehicle_sessions`
| Field       | Type    | Description                          |
|-------------|---------|--------------------------------------|
| plate       | String  | License plate                        |
| entryTime   | Date    | When vehicle entered                 |
| exitTime    | Date    | When vehicle exited (null if inside) |
| entryCamera | String  | Camera ID at entry                   |
| exitCamera  | String  | Camera ID at exit                    |
| entryBarrier| String  | Barrier ID opened at entry           |
| exitBarrier | String  | Barrier ID opened at exit            |
| isKnown     | Boolean | True if registered vehicle           |
| chargeAmount| Number  | Calculated charge (0 for known)      |
| chargeRate  | String  | Rate applied description             |
| paymentRef  | String  | M-Pesa transaction ID                |
| status      | String  | active / paid / unpaid / exited      |

### `charge_rates`
| Field       | Type   | Description                     |
|-------------|--------|---------------------------------|
| floorId     | String | Area/floor this rate applies to |
| ratePerHr   | Number | KES per hour                    |
| flatRate    | Number | Flat rate (if applicable)       |
| gracePeriod | Number | Minutes before charging starts  |
| maxDaily    | Number | Maximum daily charge            |

## API Endpoints (Internal)

| Method | Path                | Description                        |
|--------|---------------------|------------------------------------|
| POST   | /eventsRCV          | HikCentral webhook event receiver  |
| POST   | /mpesa/callback     | M-Pesa payment callback            |
| POST   | /vehicles/register  | Register a known vehicle           |
| GET    | /vehicles/:plate    | Lookup vehicle info & session      |
| GET    | /sessions/active    | List all active sessions           |
| POST   | /sync/resources     | Trigger manual HikCentral sync     |
| GET    | /sync/status        | Check sync status / last sync time |
| GET    | /health             | Health check                       |

## HikCentral API Integration Points

| Purpose                     | Method | Endpoint                                                     | Auth Header    |
|-----------------------------|--------|--------------------------------------------------------------|----------------|
| Get token                   | POST   | /api/hccgw/platform/v1/token/get                             | None (AK/SK in body) |
| Get cameras by area         | POST   | /api/hccgw/resource/v1/areas/cameras/get                     | Token          |
| Get doors/barriers by area  | POST   | /api/hccgw/resource/v1/areas/doors/get                       | Token          |
| Get area tree               | POST   | /api/hccgw/resource/v1/areas/get                             | Token          |
| Control barrier gate        | POST   | /api/hccgw/bi/v1/anpr/barrierGate/control                    | Token          |
| Search passing records      | POST   | /api/hccgw/bi/v1/anpr/passing/record/search                  | Token          |
| Configure webhook           | POST   | /api/hccgw/webhook/v1/config/save                            | Token          |
| Query webhook config        | POST   | /api/hccgw/webhook/v1/config/query                           | Token          |
| Subscribe to alarm messages | POST   | /api/hccgw/alarm/v1/mq/subscribe                             | Token          |
| Subscribe to raw messages   | POST   | /api/hccgw/rawmsg/v1/mq/subscribe                            | Token          |
| Subscribe to combined events | POST   | /api/hccgw/combine/v1/mq/subscribe                           | Token          |

### Authentication (Token Lifecycle)

- **Get Token**: POST body `{ "appKey": "...", "secretKey": "..." }`. Response returns `errorCode: "0"` and `data.accessToken` + `data.expireTime` (Unix timestamp in seconds).
- **Token validity**: 7 days. Refresh by calling the same API. The system caches the token in `hikcentral_tokens` collection with a 5-minute expiry buffer.
- **All other APIs**: Pass the token via the `Token` header (NOT `Authorization: Bearer`).

### Barrier Gate Control

Per the OpenAPI V2.15.0 spec, the correct payload is:

```json
{
  "cameraId": "xxx",
  "controlMode": 1
}
```

- `controlMode`: 1 = open, 2 = close, 3 = remain open, 4 = disable remain open
- Header: `Token: hcc.<your_token>` (not `Authorization: Bearer`)
- The alternative format (`resourceIndexCode`/`resourceType`/`command`) is **not** part of this API version.

### Webhook Event Flow (Push Mode)

1. Configure webhook: `POST /api/hccgw/webhook/v1/config/save` with `callbackUrl`, `signSecret`, `retryTimes`
2. Subscribe to events: `POST /api/hccgw/combine/v1/mq/subscribe` (combined ANPR events) or `POST /api/hccgw/rawmsg/v1/mq/subscribe` (raw messages) or `POST /api/hccgw/alarm/v1/mq/subscribe` (alarms)
3. HikCentral pushes events to the callback URL via HTTPS POST
4. The receiver must respond with **HTTP 2XX** within **5 seconds**. The system uses `{"code": "0", "msg": "success"}` as the acknowledgement schema.
5. HikCentral webhook push includes `batchId` and `list[]` of events with `eventSource`, `vehicleRelatedInfo`, etc.

## Event Messages (ANPR)

The `/eventsRCV` endpoint parses multiple formats:

### Custom/Transformed Format
```json
{
  "eventData": {
    "plateNumber": "KCA 123A",
    "cameraId": "camera-uuid",
    "eventTime": "2026-06-16T12:30:00Z",
    "direction": "entry"
  }
}
```

### HikCentral Webhook Raw Message Format
```json
{
  "batchId": "...",
  "list": [{
    "type": "event",
    "basicInfo": { "occurrenceTime": "...", "eventType": "..." },
    "data": {
      "vehicleRelatedInfo": {
        "vehicleInfo": { "plateNumber": "KCA 123A" }
      }
    }
  }]
}
```

### HikCentral Webhook Alarm Format
```json
{
  "batchId": "...",
  "list": [{
    "type": "alarm",
    "eventSource": {
      "sourceID": "camera-uuid",
      "eventType": "100657"
    },
    "vehicleRelatedInfo": {
      "vehicleInfo": { "plateNumber": "KCA 123A" }
    }
  }]
}
```

### HikCentral Webhook Combined Event Format (V2.15.0)
```json
{
  "batchId": "...",
  "list": [{
    "eventId": 123,
    "eventType": "...",
    "basicInfo": {
      "occurrenceTime": "2026-06-16T12:30:00+03:00",
      "resourceInfo": { "sourceID": "camera-uuid" }
    },
    "evenData": {
      "anprInfo": { "licensePlate": "KCA 123A", "driveDirection": 1 }
    }
  }]
}
```

## Configuration (.env)

```
# Server
PORT=3000

# MongoDB
MONGODB_URI=mongodb://localhost:27017/parking_altura

# HikCentral
HIK_BASE_URL=https://hikcentral.tekvancesolutions.co.ke
HIK_ACCESS_KEY=your_access_key
HIK_SECRET_KEY=your_secret_key

# M-Pesa (Safaricom Daraja API)
MPESA_CONSUMER_KEY=your_ck
MPESA_CONSUMER_SECRET=your_cs
MPESA_PASSKEY=your_passkey
MPESA_SHORTCODE=174379
MPESA_CALLBACK_URL=https://your-domain.com/mpesa/callback

# Payment defaults
DEFAULT_RATE_PER_HOUR=100
DEFAULT_GRACE_MINUTES=15
```
