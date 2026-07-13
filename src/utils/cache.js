const { getRedis } = require('../config/redis')

async function get(key) {
  const r = getRedis()
  if (!r) return null
  try {
    const raw = await r.get(key)
    return raw ? JSON.parse(raw) : null
  } catch (_) {
    return null
  }
}

async function set(key, value, ttlSeconds = 60) {
  const r = getRedis()
  if (!r) return
  try {
    const data = JSON.stringify({ v: value, ts: Date.now() })
    await r.setex(key, ttlSeconds, data)
  } catch (_) {}
}

async function del(key) {
  const r = getRedis()
  if (!r) return
  try { await r.del(key) } catch (_) {}
}

async function delPattern(pattern) {
  const r = getRedis()
  if (!r) return
  try {
    let cursor = '0'
    do {
      const [next, keys] = await r.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
      cursor = next
      if (keys.length) await r.del(...keys)
    } while (cursor !== '0')
  } catch (_) {}
}

const CACHE_KEYS = {
  ACTIVE_SESSIONS: 'cache:active_sessions',
  DASHBOARD_STATS: 'cache:dashboard_stats',
  PARKING_LOTS: 'cache:parking_lots',
  ACTIVE_BY_FLOOR: 'cache:active_by_floor',
  DAILY_ANALYTICS: 'cache:daily_analytics',
}

async function invalidateAll() {
  await delPattern('cache:*')
}

module.exports = { get, set, del, delPattern, invalidateAll, CACHE_KEYS }
