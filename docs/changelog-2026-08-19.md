# Changelog — 2026-08-19

## Summary

Fixed critical session creation failures on server restart caused by timezone
misconfiguration, a race condition between startup processes, and HikCentral
clock drift. Added configurable query time buffers and proper timezone support.

---

## Issues Fixed

### 1. Missing vehicle sessions on server restart

**Symptom:** After restarting the server, only some of the day's vehicle entries
were created as sessions. Vehicles that entered hours before the restart were
silently dropped.

**Root causes (3):**

| # | Cause | Impact |
|---|-------|--------|
| A | `startStaleSessionCleanup()` ran concurrently with startup reconciliation (race condition) | Stale cleanup closed active sessions before reconciliation could process them — sessions silently lost |
| B | `PassagewaySync` only looked back **30 minutes** on startup (`STARTUP_LOOKBACK_MINUTES = 30`) | Any vehicle entering more than 30 min before restart was missed by the recurring sync |
| C | No forward buffer on HikCentral query end times | HikCentral device clock runs ~5 min ahead; records near the query boundary were excluded |

### 2. Server timezone not applied to Node.js process

**Symptom:** Server displayed correct system time (`date` command) but
`new Date().getHours()` inside Node.js returned wrong values.

**Cause:** `TZ` environment variable was not set for the Node.js process.
Node.js reads `TZ` at startup — setting it in `.env` (loaded by `dotenv`) is
too late.

### 3. CORS blocking frontend requests

**Symptom:** Frontend at `https://sandbox.payserve.co.ke` and local
`http://localhost:3000` were blocked by CORS.

**Cause:** CORS origin was set to accept all origins (`cb(null, true)`),
which is insecure. Replaced with explicit whitelist.

---

## Changes

### `src/utils/dateUtils.js`

**Added `hikQueryEnd()`** — returns `hikNow()` + configurable forward buffer.

```js
// Before: endTime was always "now" — missed HikCentral records with forward clock drift
const endTime = isoLocal(hikNow())

// After: endTime extends 2 hours ahead to capture all HikCentral records
const endTime = isoLocal(hikQueryEnd())
```

The buffer is configurable via `HIKCENTRAL_QUERY_BUFFER_MINUTES` (default: 120).

**Exports updated:** Added `hikQueryEnd` to module exports.

### `src/config/index.js`

**Added `queryBufferMs`** to `hikcentral` config block:

```js
hikcentral: {
  // ... existing fields ...
  queryBufferMs: parseInt(process.env.HIKCENTRAL_QUERY_BUFFER_MINUTES || '120', 10) * 60 * 1000,
}
```

### `src/index.js` — Startup reconciliation

**Fixed race condition:** `startStaleSessionCleanup()` now runs **after**
the startup reconciliation completes (was before, un-awaited).

```diff
- startStaleSessionCleanup()    // fired-and-forgotten, raced with reconciliation
  try {
    // ... startup reconciliation creates/validates sessions ...
  }
+ await startStaleSessionCleanup()   // runs after reconciliation, awaited
  startPassagewaySync()
```

**Added forward buffer** to query end time:

```diff
- const endTime = isoLocal(now)
+ const queryEnd = hikQueryEnd()
+ const endTime = isoLocal(queryEnd)
```

**Added per-plate logging** in the reconciliation loop to trace exactly which
sessions are created, skipped, or have missing entry records.

### `src/index.js` — Stale session cleanup

**Awaited first check:** `check()` is now `await`ed before starting the
interval timer, ensuring the first cleanup pass completes before periodic runs.

**Added forward buffer** to query end time (same pattern as above).

### `src/services/PassagewaySync.js`

**Fixed startup lookback:** Changed from hardcoded 30 minutes to full day
(`now.getHours() * 60 + now.getMinutes()`), matching the startup reconciliation.

```diff
- : STARTUP_LOOKBACK_MINUTES    // 30 minutes
+ : (now.getHours() * 60 + now.getMinutes())   // full day on startup
```

**Removed** unused `STARTUP_LOOKBACK_MINUTES` constant.

**Added forward buffer** to query end time.

### `src/routes/events.js`

**Updated `fetchPassagewayRecords()`** to use `hikQueryEnd()` instead of a
hardcoded 5-minute forward window:

```diff
- const windowEnd = new Date(now.getTime() + 5 * 60000)
+ const windowEnd = hikQueryEnd()
```

### `src/routes/events.js` — imports

Updated import to include `hikQueryEnd`:

```diff
- const { isoLocal, hikNow } = require('../utils/dateUtils')
+ const { isoLocal, hikNow, hikQueryEnd } = require('../utils/dateUtils')
```

### `.env`

```diff
+ TZ=Africa/Nairobi
+ CORS_ORIGINS=https://sandbox.payserve.co.ke,http://localhost:3000
+ HIKCENTRAL_QUERY_BUFFER_MINUTES=120
```

`HIKCENTRAL_TIME_OFFSET_MINUTES` comment updated to clarify usage.

### `package.json`

Start scripts now set `TZ` directly so Node.js picks it up at process start:

```diff
- "dev": "nodemon src/index.js",
- "start": "node src/index.js",
+ "dev": "TZ=Africa/Nairobi nodemon src/index.js",
+ "start": "TZ=Africa/Nairobi node src/index.js",
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TZ` | _(none)_ | System timezone for Node.js process. **Must be set before process starts** (not via dotenv). Use `Africa/Nairobi` for EAT (UTC+3). |
| `CORS_ORIGINS` | _(empty)_ | Comma-separated list of allowed CORS origins. |
| `HIKCENTRAL_QUERY_BUFFER_MINUTES` | `120` | Forward buffer (minutes) added to HikCentral query end times. Accounts for clock drift on the HikCentral device. |
| `HIKCENTRAL_TIME_OFFSET_MINUTES` | `0` | Fixed offset (minutes) applied to `hikNow()`. Set positive if HikCentral clock is ahead of the server. |

---

## Startup Sequence (after changes)

```
1. createApp()          — registers routes, connects MongoDB, seeds admin
2. app.listen()         — server starts accepting connections
3. setupWebhook()       — registers HikCentral event callback URL
4. syncResources()      — syncs cameras, barriers, parking lots from HikCentral
5. startup reconciliation — queries HikCentral (midnight → now+2h), creates missing sessions
6. await startStaleSessionCleanup() — closes stale active sessions with exit records
7. startPassagewaySync() — starts 1-min interval reconciliation (lookback: full day on first run, 2 min after)
```

Key ordering guarantee: step 5 completes before step 6 begins (no race condition).

---

## Query Time Windows

| Component | Start Time | End Time | Notes |
|-----------|-----------|----------|-------|
| Startup reconciliation | Midnight (local) | `hikNow() + buffer` | Full day catch-up on boot |
| Stale cleanup (first run) | Midnight (local) | `hikNow() + buffer` | Closes sessions with exit records |
| Stale cleanup (periodic) | `now - 10 min` | `hikNow() + buffer` | Lightweight ongoing check |
| PassagewaySync (first run) | `now - full day` | `hikNow() + buffer` | Full day on startup (was 30 min) |
| PassagewaySync (periodic) | `now - 2 min` (or since last run) | `hikNow() + buffer` | 1-minute interval |
| Event fallback query | `now - 15 min` | `hikNow() + buffer` | Reactive fallback for missed webhooks |

---

## Deployment Notes

### systemd service

If running via systemd, add the timezone to your service file:

```ini
[Service]
Environment=TZ=Africa/Nairobi
ExecStart=/usr/bin/node src/index.js
```

### Manual start

```bash
TZ=Africa/Nairobi node src/index.js
# or
npm start    # package.json scripts now include TZ
```

### Verify timezone

After deploying, confirm Node.js sees the correct timezone:

```bash
node -e "console.log(new Date().toString())"
# Should show: ... GMT+0300 (East Africa Time)
```
