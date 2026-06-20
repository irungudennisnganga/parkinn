# Barrier Gate Control

## How It Works

Barriers are controlled via `POST /artemis/api/acs/v1/door/doControl` with the barrier's `doorIndexCode` (which we store as `barrierId`).

### controlType Values

| Value | Action | Behavior |
|------:|--------|----------|
| 1 | Open | Opens barrier momentarily — **auto-closes** after vehicle passes the sensor |
| 2 | Close | Closes barrier immediately |
| 3 | Remain open | Keeps barrier open indefinitely |
| 4 | Disable remain open | Cancels remain-open, barrier returns to normal |

**Auto-close**: When opened with `controlType: 1`, HikCentral closes the barrier automatically after the vehicle clears the passage sensor. No manual close needed for normal vehicle passes.

## Terminal Commands (curl)

```bash
BASE="http://localhost:3000"

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

# Open it
curl -s -X POST http://localhost:3000/sync/barrier/1/open
# Response: {"barrierId":"1","action":"open","success":true}

# Close it
curl -s -X POST http://localhost:3000/sync/barrier/1/close
# Response: {"barrierId":"1","action":"close","success":true}
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/sync/barriers` | GET | List all barriers |
| `/sync/barrier/:id/open` | POST | Open barrier (momentary, auto-closes) |
| `/sync/barrier/:id/close` | POST | Close barrier |
| `/sync/barrier/:id/remain-open` | POST | Keep open indefinitely |
| `/sync/barrier/:id/disable-remain-open` | POST | Cancel remain-open |
| `/sync/status` | GET | Resource counts |
| `/sync/resources` | POST | Trigger manual resource sync |
