# How Sessions Are Created Automatically

## Overview

Every car entering the parking building gets a session created automatically through a two-layer system:

| Layer | Trigger | When | Purpose |
|-------|---------|------|---------|
| **Real-time** | HikCentral webhook | Instant (sub-second) | Primary path — catches events as they happen |
| **Startup catch-up** | Server boot | Once on startup | Safety net — catches cars missed during downtime |

---

## Layer 1: Real-time Webhook Processing

```
Car passes ANPR camera
    ↓
HikCentral detects plate → pushes webhook to /eventsRCV
    ↓
extractEvents() parses the payload
    ↓
reply { code: "0", msg: "success" }  ← acknowledged immediately (<1ms)
    ↓
setImmediate → process each event:
    │
    ├── processAnprEvent(evt)
    │   ├── normalizePlate()           → uppercase, strip spaces
    │   ├── extractAnprData()          → get plate, cameraId, eventTime
    │   ├── resolveCamera()            → match cameraId/indexCode to DB
    │   ├── resolveDirection()         → determine entry vs exit
    │   ├── handleEntry()              → create session (status: "active")
    │   │   ├── Checks for existing active session
    │   │   ├── If >1hr old on different camera → auto-close, create new
    │   │   ├── If same camera → skip (duplicate)
    │   │   ├── If different camera → update entryCamera (floor movement)
    │   │   ├── If residential & unknown → blocked
    │   │   └── Creates VehicleSession in MongoDB
    │   └── handleExit()               → calculate charge, mark unpaid/exited
    │       ├── Paid session found → open barrier, mark exited
    │       ├── Known vehicle → free exit
    │       └── Unknown vehicle → calculate charge → mark unpaid
    │
    └── If no session created AND not skipped/blocked:
        └── createSessionFromPassageway(plate)
            ├── Checks no session exists (active/unpaid/paid)
            ├── Queries HikCentral passageway API (start of today → now)
            ├── Maps laneIndexCode → Camera → Barrier
            ├── Creates VehicleSession directly with entry time from passageway
            └── Broadcasts via WebSocket
```

### How `extractEvents()` parses HikCentral payloads

Handles 6 different formats:

| Format | Key fields | How it parses |
|--------|-----------|---------------|
| `params.events[]` | `data.plateNo`, `evt.srcIndex`, `evt.eventTime` | Most common — uses event's own timestamp |
| `eventData` | `eventData.plateNumber`, `eventData.cameraId` | Direct format |
| `events[]` | `evt.eventData.plateNumber` | Array format |
| `list[]` | Combined events (basicInfo + evenData) | Passed to extractAnprData for nested parsing |
| String | Regex-based plate extraction | Fallback for raw text |
| Direct | `rawBody.plateNumber` | Simplest format |

### Camera direction resolution

```
resolveDirection(cameraId, cameraName)
  ├── Check Camera.direction in DB (entry/exit/both)
  ├── If 'both' → infer from camera name ("ENTRY"/"EXIT" keywords)
  ├── If still unknown → default to 'entry' (never skip events)
  └── If 'exit' on internal floor (floor > 1) → force to 'entry' (floor movement)
```

### Event time — fixed priority order

```
evt.eventTime           ← actual camera event time (MOST ACCURATE)
  ↓ fallback
data.eventTime          ← alternative field in some formats
  ↓ fallback
rawBody.params.sendTime ← HikCentral batch send time
  ↓ fallback
evt.occurTime           ← occurrence time in alarm format
  ↓ fallback
new Date()              ← server current time (last resort)
```

**Previously**: `sendTime` was used first — if HikCentral delayed sending a webhook batch by an hour, all events got the wrong timestamp.

---

## Layer 2: Startup Reconciliation

Runs once when the server starts. Catches cars that:
- Entered while the server was down
- Had events missed by the webhook during previous uptime
- Have stale active sessions that need closing

```
Server starts → after listen + resource sync
    ↓
Startup reconciliation:
    ├── Fetches all parking lots from DB
    ├── Queries HikCentral passageway API (midnight → now + 2h buffer)
    ├── For each record:
    │   ├── Maps laneIndexCode → Camera → Barrier
    │   ├── Checks existing session (active)
    │   ├── Entry record + no session → creates session (status: "active")
    │   ├── Entry + exit record + no session → creates session (status: "unpaid")
    │   └── Exit record + active session → closes as "unpaid"
    ├── Deduplicates by plate
    ├── Logs each plate's processing status for debugging
    └── Broadcasts via WebSocket
    ↓
await startStaleSessionCleanup()   ← runs AFTER reconciliation (no race)
    ↓
startPassagewaySync()              ← ongoing 1-min reconciliation
```

### Query time windows

All HikCentral queries use a **forward buffer** (`HIKCENTRAL_QUERY_BUFFER_MINUTES`,
default 120 min) to account for clock drift on the HikCentral device:

| Phase | Start | End |
|-------|-------|-----|
| Startup reconciliation | Midnight (local) | `now + buffer` |
| PassagewaySync (first run) | Full day back | `now + buffer` |
| PassagewaySync (periodic) | Last run or 2 min | `now + buffer` |
| Stale cleanup (first run) | Full day back | `now + buffer` |
| Stale cleanup (periodic) | 10 min back | `now + buffer` |

### Why session is closed as "unpaid" not "exited"

Reconciled exits are marked `unpaid` so they appear in the **"Exited Without Paying"** tab on the frontend. This allows operators to see which cars need payment reconciliation.

---

## Duplicate Prevention

Multiple layers prevent duplicate sessions:

| Level | Mechanism | File:Line |
|-------|-----------|-----------|
| **App** | `handleEntry`: `findOne({ plate, status: 'active' })` before creating | EventProcessor.js:213 |
| **App** | Reactive fallback: `findOne({ plate, status: { $in: ['active','unpaid','paid'] } })` | events.js:274 |
| **App** | Startup sync: `findOne({ plate, status: { $in: ['active','unpaid','paid'] } })` | index.js |
| **DB** | Unique partial index: `{ plate: 1, status: 'active' }` | VehicleSession.js:23-26 |
| **DB** | MongoDB error 11000 caught in try/catch | EventProcessor.js:248-251 |

---

## Session Status Lifecycle

```
    ANPR entry detected
         ↓
    [active] ←── car parked, no charge yet
         ↓
    ANPR exit detected
         ↓
    charge calculated (HikCentral or local)
         ↓
    ┌─ charge = 0 ──→ [exited]  (free exit)
    │
    └─ charge > 0 ──→ [unpaid]  (payment required)
         ↓
    payment confirmed (manual or M-Pesa)
         ↓
    ──→ [paid] ←── HikCentral notified
         ↓
    car passes exit camera
         ↓
    barrier opens → [exited]
```

---

## Key Files

| File | Role |
|------|------|
| `src/routes/events.js` | Webhook receiver, event extraction, reactive fallback |
| `src/services/EventProcessor.js` | Core event processing: handleEntry, handleExit, direction resolution |
| `src/index.js` | Startup reconciliation + stale session cleanup |
| `src/services/PassagewaySync.js` | Ongoing 1-min reconciliation (full day on startup) |
| `src/utils/dateUtils.js` | `hikNow()`, `hikQueryEnd()`, `isoLocal()` — time helpers |
| `src/config/index.js` | Config: `queryBufferMs`, `timeOffsetMs`, `TZ` |
| `src/models/VehicleSession.js` | Session schema with unique index |
| `src/services/WebSocketManager.js` | Real-time broadcasts to frontend |

---

## Timezone & Clock Drift

The system accounts for clock drift between the server and HikCentral device:

- **`TZ=Africa/Nairobi`** — must be set before Node.js starts (in shell, systemd, or npm script)
- **`HIKCENTRAL_TIME_OFFSET_MINUTES`** — fixed offset applied to `hikNow()` if the HikCentral clock is consistently ahead/behind
- **`HIKCENTRAL_QUERY_BUFFER_MINUTES`** — extends query endTime forward (default 120 min) to capture all records even with clock drift

```
Server clock:     ────────|──── now
HikCentral clock: ───────────|──── now (ahead)
Query window:     ──────────────────|──── endTime = now + buffer
                                     ↑ ensures HikCentral records are within range
```
