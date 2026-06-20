# How Cameras and Barriers Are Discovered

## Overview

HikCentral Professional V3.1.0 manages ANPR cameras and barrier gates as part of the **parking lot module**, not as standalone camera/door resources. The standard camera list API (`POST /artemis/api/resource/v1/cameras`) and ACS door API return empty because the OpenAPI partner permissions may not include camera/door read access, or the resources are organized differently.

Instead, cameras and barriers are discovered from **vehicle passing records** via the parking lot API.

## Discovery Flow

```
1. GET /artemis/api/resource/v1/regions         → 6 areas (floors)
2. GET /artemis/api/vehicle/v1/parkinglot/list   → 3 parking lots
3. POST /artemis/api/vehicle/v1/parkinglot/passageway/record
   └─ queryInfo: { parkingLotIndexCode, beginTime, endTime }
   └─ Returns vehicle passing records containing:
      ├── passagewayInfo     → barriers (gates)
      ├── laneInfo           → cameras (ANPR lanes)
      └── carInfo            → vehicle data (plate, times, images)
```

## Resource Mapping

| HikCentral Field | Stored As | Collection |
|------------------|-----------|------------|
| `passagewayInfo.passagewayIndexCode` | `barrierId` | `barriers` |
| `passagewayInfo.passagewayName` | `name` | `barriers` |
| `laneInfo.laneIndexCode` | `cameraId` | `cameras` |
| `laneInfo.laneName` | `name` | `cameras` |
| `laneInfo.direction` (1=entry, 2=exit) | `direction` | `cameras` |
| `carInfo.plateLicense` | `plate` | `vehiclerecords` |

## API Endpoints Used

| Purpose | Method | URL |
|---------|--------|-----|
| Version | POST | `/artemis/api/common/v1/version` |
| Areas | POST | `/artemis/api/resource/v1/regions` |
| Parking lots | POST | `/artemis/api/vehicle/v1/parkinglot/list` |
| Vehicle passes | POST | `/artemis/api/vehicle/v1/parkinglot/passageway/record` |
| Event subscription | POST | `/artemis/api/eventService/v1/eventSubscriptionByEventTypes` |

## Event Subscription

ANPR event types subscribed:
- `131329` — ANPR vehicle detected
- `131330` — License plate matched
- `131331` — License plate mismatched

Events are pushed to `HIKCENTRAL_CALLBACK_URL/eventsRCV`.

## Caching

- Areas and parking lots are cached on first sync, skipped on subsequent starts
- Cameras, barriers, and vehicle records are re-discovered from passageway data on every sync
- Event subscriptions are stored in `eventsubscriptions` collection and skipped if already active

## Auth

Uses HMAC-SHA256 signature with `X-Ca-Key`/`X-Ca-Signature` headers — no token management needed.
