# Barrier Gate Control

## Opening Strategy (3-method fallback)

Barrier opening uses three methods in priority order. Whichever succeeds first wins:

| Priority | Method | HikCentral Endpoint | Availability |
|---------:|--------|---------------------|-------------|
| 1 | ANPR gate control (HCCGW) | `POST /api/hccgw/bi/v1/anpr/barrierGate/control` | Cloud-only — 404 on on-premise V3.1.0 |
| 2 | Alarm output control | `POST /artemis/api/resource/v1/alarmOutput/controlling` | Always available |
| 3 | ACS door control | `POST /artemis/api/acs/v1/door/doControl` | Always available |

> **On-premise note:** The HCCGW gateway (`/api/hccgw/`) is a cloud service. On-premise HikCentral (V3.1.0) returns 404. Method 2 (alarm output) or 3 (ACS door) will be used instead. The HCCGW attempt is kept as a bonus — it silently falls through on error.

Implementation: `src/services/BarrierControl.js:9` (`openBarrier`). Each method is caught and the next is tried.

### controlType / controlMode Values

The ACS door control endpoint uses `controlType`. The HCCGW endpoint uses `controlMode`. Both share the same values:

| Value | Action | Behavior |
|------:|--------|----------|
| 1 | Open | Opens barrier momentarily — **auto-closes** after vehicle passes the sensor |
| 2 | Close | Closes barrier immediately |
| 3 | Remain open | Keeps barrier open indefinitely |
| 4 | Disable remain open | Cancels remain-open, barrier returns to normal |

**Auto-close**: When opened with value `1`, HikCentral closes the barrier automatically after the vehicle clears the passage sensor. No manual close needed for normal vehicle passes.

### Alarm Output Values

| Value | Action |
|------:|--------|
| 1 | Open / activate output |
| 0 | Close / deactivate output |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/gate/control` | POST | Direct gate control by cameraId (all 3 methods, camera-based) |
| `/sync/gate/control` | POST | Same as above, under admin prefix |
| `/camera/:id/open` | POST | Open by camera ID (all 3 methods) |
| `/sync/camera/:id/open` | POST | Same as above, under admin prefix |
| `/sync/barriers` | GET | List all known barriers |
| `/sync/barrier/:id/open` | POST | Open by barrier ID (alarm → ACS only, no HCCGW) |
| `/sync/barrier/:id/close` | POST | Close barrier |
| `/sync/barrier/:id/remain-open` | POST | Keep open indefinitely |
| `/sync/barrier/:id/disable-remain-open` | POST | Cancel remain-open |
| `/sync/status` | GET | Resource counts |
| `/sync/resources` | POST | Trigger manual resource sync |
| `/sync/cameras` | GET | List all cameras with id/name/direction |

## Terminal Commands (curl)

```bash
BASE="http://localhost:3000"

# Direct gate control by camera ID (recommended for camera-based barriers)
curl -s -X POST $BASE/gate/control \
  -H "Content-Type: application/json" \
  -d '{"cameraId":"9","controlMode":1}' | python3 -m json.tool

# Open by camera ID (same 3-method fallback)
curl -s -X POST $BASE/camera/CAMERA_ID/open | python3 -m json.tool

# List cameras to find cameraId
curl -s $BASE/sync/cameras | python3 -m json.tool

# List all known barriers
curl -s $BASE/sync/barriers | python3 -m json.tool

# Open a barrier (replace BARRIER_ID with actual ID from list above)
curl -s -X POST $BASE/sync/barrier/BARRIER_ID/open | python3 -m json.tool

# Close a barrier
curl -s -X POST $BASE/sync/barrier/BARRIER_ID/close | python3 -m json.tool

# Keep barrier open
curl -s -X POST $BASE/sync/barrier/BARRIER_ID/remain-open | python3 -m json.tool

# Return to normal (disable remain-open)
curl -s -X POST $BASE/sync/barrier/BARRIER_ID/disable-remain-open | python3 -m json.tool

# Check sync status
curl -s $BASE/sync/status | python3 -m json.tool
```

### Example Flow

```bash
# View barriers and pick one
curl -s http://localhost:3000/sync/barriers
# Response: [{"id":"1","name":"Default Entrance & Exit01","cameraId":""}]

# Open it via barrier ID (alarm output → ACS door)
curl -s -X POST http://localhost:3000/sync/barrier/1/open
# Response: {"barrierId":"1","action":"open","success":true,"method":"alarmOutput"}

# Or open via gate/control with cameraId (all 3 methods)
curl -s -X POST http://localhost:3000/gate/control \
  -H "Content-Type: application/json" \
  -d '{"cameraId":"9","controlMode":1}'
# Response: {"success":true,"cameraId":"9","action":"open","method":"alarmOutput"}

# Close it
curl -s -X POST http://localhost:3000/sync/barrier/1/close
# Response: {"barrierId":"1","action":"close","success":true}
```

### Response Fields

| Field | Description |
|-------|-------------|
| `success` | `true` if any method succeeded |
| `method` | Which method succeeded: `anprGate`, `alarmOutput`, or `acsDoor` |
| `action` | `open` or `close` |
| `cameraId` | Camera ID used (gate/control endpoint) |

