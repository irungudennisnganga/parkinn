# Parking Altura — Backend

HikCentral integration for parking management with M-Pesa payments, Redis caching, and real-time WebSocket updates.

## Architecture

```
parking_altura/
├── src/
│   ├── config/          # App config, MongoDB, Redis connections
│   ├── middleware/       # JWT authentication
│   ├── models/           # Mongoose schemas
│   ├── routes/           # Fastify route handlers
│   ├── services/         # Business logic
│   └── utils/            # Cache, date helpers, logger
├── __tests__/            # Jest test suites
├── .env                  # Environment variables
├── .env.example          # Environment template
└── package.json
```

## Quick Start

```bash
cp .env.example .env
# Edit .env with your credentials

npm install
npm run dev     # nodemon for development
npm start       # production
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `MONGODB_URI` | `mongodb://localhost:27017/parking_altura` | MongoDB connection |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection (optional) |
| `REDIS_ENABLED` | `true` | Set to `false` to disable Redis |
| `HIK_BASE_URL` | — | HikCentral API base URL |
| `HIK_ACCESS_KEY` | — | HikCentral access key |
| `HIK_SECRET_KEY` | — | HikCentral secret key |
| `HIKCENTRAL_CALLBACK_URL` | — | Webhook callback URL |
| `MPESA_CONSUMER_KEY` | — | Daraja API consumer key |
| `MPESA_CONSUMER_SECRET` | — | Daraja API consumer secret |
| `MPESA_PASSKEY` | — | Daraja API passkey |
| `MPESA_SHORTCODE` | `174379` | Paybill/till number |
| `MPESA_CALLBACK_URL` | — | M-Pesa callback URL |
| `DEFAULT_RATE_PER_HOUR` | `100` | Parking rate (KES) |
| `DEFAULT_GRACE_MINUTES` | `15` | Free grace period |
| `CACHE_ACTIVE_SESSIONS_TTL` | `30` | Redis TTL for active sessions cache (seconds) |
| `CACHE_DASHBOARD_TTL` | `60` | Redis TTL for dashboard stats cache (seconds) |
| `RECONCILE_INTERVAL_MS` | `60000` | HikCentral reconciliation interval (1 minute) |
| `STALE_CLEANUP_INTERVAL_MS` | `60000` | Stale session cleanup interval (1 minute) |
| `RESIDENTIAL_FLOORS` | `5,6,7,8,9` | Residential floor numbers |
| `COMMERCIAL_FLOORS` | `1,2,3,4` | Commercial floor numbers |

## Redis Caching

The server uses Redis to cache frequently-queried endpoints. When Redis is available:

- **Active sessions** — cached for 30 seconds (default). Invalidated on new entry, exit, or payment.
- **Dashboard stats** — cached for 60 seconds (default). Invalidated on session state changes.
- **Fallback** — If Redis is unavailable, the server operates normally without caching.

Cache keys follow the pattern `cache:*`. All cached data includes a timestamp (`ts`) so the frontend can detect staleness.

### Invalidation

Cache is automatically invalidated when:
- A new vehicle session is created (ANPR entry event)
- A session is updated (exit, payment, status change)
- Active sessions are broadcast to WebSocket clients

## Data Synchronization

### On Startup
1. Server connects to MongoDB and Redis (if available)
2. Resources are synced from HikCentral (cameras, barriers, lots)
3. Today's passageway records are fetched and reconciled:
   - Missing entry records → new sessions created
   - Exit records for active sessions → sessions closed as unpaid
   - Registered vehicles are identified by matching against the database
4. Stale session cleanup begins (checks for vehicles that exited while server was down)
5. Periodic reconciliation starts (every 1 minute)

### Ongoing (every 1 minute)
- **Passageway reconciliation**: Fetches recent HikCentral records and creates/closes sessions
- **Stale session cleanup**: Checks all active sessions against HikCentral exit records

## API Endpoints

### Auth (public)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/login` | Login with email/password |
| POST | `/auth/create-default-user` | Create first admin user (only when no users exist) |

### Auth (protected)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/auth/me` | Get current user |
| POST | `/auth/change-password` | Change password |
| GET | `/auth/users` | List all users |
| POST | `/auth/users` | Create a new user |
| PATCH | `/auth/users/:id` | Update user role/status |
| GET | `/auth/audit-logs` | Paginated audit logs |

### Vehicles (protected)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/vehicles/active` | Active parking sessions (cached) |
| POST | `/vehicles/register` | Register a known vehicle |
| GET | `/vehicles/:plate` | Get registered vehicle + active session |
| DELETE | `/vehicles/:plate` | Delete registered vehicle |

### Payments (public)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/public/payments/fee/:plate` | Calculate fee for a plate |
| POST | `/public/payments/stkpush` | Initiate M-Pesa STK push |
| POST | `/public/payments/confirm` | Mark payment as confirmed |

### Parking Analytics (protected)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/parking/dashboard-stats` | Dashboard charts and stats (cached) |
| GET | `/parking/daily-analytics` | Daily breakdown with date range |
| POST | `/parking/daily-analytics/save` | Save daily summary snapshot |
| GET | `/parking/session-history` | Paginated past sessions |
| GET | `/parking/exited-unpaid` | Vehicles that exited without paying |
| GET | `/parking/payment-history` | Paid/exited session records |
| GET | `/parking/system-payments` | Detailed payment transactions |
| GET | `/parking/lots` | Parking lot occupancy |
| GET | `/parking/active-by-floor` | Vehicles grouped by floor |

### HikCentral (protected)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/parking/hikcentral-records` | Vehicle pass records from HikCentral |
| GET | `/parking/passageway-records` | Live passageway records |
| POST | `/parking/create-sessions-from-passageway` | Batch create sessions from records |
| GET | `/parking/raw-events` | Raw ANPR events |

### WebSocket
| Path | Description |
|------|-------------|
| `/ws` | Real-time updates (active sessions, new entries, exits) |

## WebSocket Events

| Type | Trigger |
|------|---------|
| `active_sessions` | Full session list on connect/subscribe or after changes |
| `new_session` | New vehicle entry detected |
| `session_update` | Session status changes (exit, payment) |
| `raw_event` | Low-level ANPR event received |
| `raw_events` | Recent raw events on subscribe |

## Testing

```bash
npm test
```

Tests use `mongodb-memory-server` for an in-memory MongoDB instance.
