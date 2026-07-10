# HikCentral Event Processing & Session Sync

## Two-layer design

### Layer 1: Reactive fallback (real-time)

When a webhook event arrives at `/eventsRCV` and `processAnprEvent` fails to create a session, the system immediately queries HikCentral passageway records for that specific plate (from start of today) and creates the session.

```
Webhook → /eventsRCV
  ├── processAnprEvent() succeeds → session created ✓
  └── processAnprEvent() fails → createSessionFromPassageway(plate)
      ├── Queries HikCentral from start of today
      ├── Finds entry record → creates session
      └── Finds exit record → closes session
```

### Layer 2: Startup reconciliation (catch-up)

When the server starts, it syncs ALL passageway records from start of today. This catches cars that were missed before the server was running or during downtime.

```
Server start
  └── Startup reconciliation (once, non-blocking)
      ├── Queries all parking lots from start of today
      ├── For entries without sessions → creates sessions
      └── For exits with stale active sessions → closes them
```

## Lookback window

All queries use **start of today (midnight)** to now. This ensures:
- Cars from hours ago are caught
- Cars that entered and already left are handled
- Restart recovery picks up everything since midnight

## No cron, no polling

- Layer 1 fires only when an event arrives and fails — zero overhead for successful events
- Layer 2 fires exactly once at startup — zero overhead during operation
- No timers, no intervals, no wasted HikCentral API calls

## Files

| File | Layer | Purpose |
|------|-------|---------|
| `src/routes/events.js` | 1 | `createSessionFromPassageway()` — reactive per-plate fallback |
| `src/index.js` | 2 | Startup reconciliation — one-time catch-up on boot |
