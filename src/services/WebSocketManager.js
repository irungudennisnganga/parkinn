const { VehicleSession } = require('../models/VehicleSession')
const { EventLog } = require('../models/EventLog')
const { RawEvent } = require('../models/RawEvent')
const { logger } = require('../utils/logger')
const cache = require('../utils/cache')

const clients = new Map()

function setupWebSocket(fastify) {
  logger.info('Registering WebSocket route /ws')

  fastify.get('/ws', { websocket: true }, (socket, req) => {
    const clientId = Date.now().toString(36) + Math.random().toString(36).slice(2)
    clients.set(clientId, { socket, connectedAt: new Date() })

    logger.info({ clientId, remoteAddress: req.socket?.remoteAddress }, 'WebSocket client connected')

    sendActiveSessions(clientId)

    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw)
        if (msg.type === 'subscribe_active') {
          sendActiveSessions(clientId)
        }
        if (msg.type === 'subscribe_raw_events') {
          sendRecentRawEvents(clientId)
        }
      } catch {}
    })

    socket.on('close', () => {
      clients.delete(clientId)
      logger.info({ clientId }, 'WebSocket client disconnected')
    })
  })

  return {
    broadcastActiveSessions,
    broadcastNewSession,
    broadcastSessionUpdate,
    broadcastNewEvent,
  }
}

async function sendActiveSessions(clientId) {
  const client = clients.get(clientId)
  if (!client) return

  try {
    const sessions = await VehicleSession.find({ status: { $in: ['active', 'unpaid'] } })
      .sort({ entryTime: -1 })
      .limit(500)
      .lean()

    const seen = new Set()
    const deduped = sessions.filter(s => {
      const key = `${s.plate}_${s.status}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    client.socket.send(JSON.stringify({
      type: 'active_sessions',
      data: deduped,
      timestamp: new Date().toISOString(),
    }))
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to send active sessions')
  }
}

async function broadcastActiveSessions() {
  await cache.del(cache.CACHE_KEYS.ACTIVE_SESSIONS)
  await cache.del(cache.CACHE_KEYS.DASHBOARD_STATS)
  await cache.delPattern('cache:daily_analytics*')

  const sessions = await VehicleSession.find({ status: { $in: ['active', 'unpaid'] } })
    .sort({ entryTime: -1 })
    .limit(500)
    .lean()

  const seen = new Set()
  const deduped = sessions.filter(s => {
    const key = `${s.plate}_${s.status}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const payload = JSON.stringify({
    type: 'active_sessions',
    data: deduped,
    timestamp: new Date().toISOString(),
  })

  for (const [, client] of clients) {
    try { client.socket.send(payload) } catch {}
  }
}

function broadcastNewSession(session) {
  cache.del(cache.CACHE_KEYS.ACTIVE_SESSIONS).catch(() => {})

  const payload = JSON.stringify({
    type: 'new_session',
    data: session,
    timestamp: new Date().toISOString(),
  })

  for (const [, client] of clients) {
    try { client.socket.send(payload) } catch {}
  }
}

function broadcastSessionUpdate(session) {
  cache.del(cache.CACHE_KEYS.ACTIVE_SESSIONS).catch(() => {})
  cache.del(cache.CACHE_KEYS.DASHBOARD_STATS).catch(() => {})

  const payload = JSON.stringify({
    type: 'session_update',
    data: session,
    timestamp: new Date().toISOString(),
  })

  for (const [, client] of clients) {
    try { client.socket.send(payload) } catch {}
  }
}

function broadcastNewEvent(event) {
  const payload = JSON.stringify({
    type: 'new_event',
    data: {
      plate: event.plate,
      direction: event.direction,
      cameraId: event.cameraId,
      eventTime: event.eventTime || new Date().toISOString(),
    },
    timestamp: new Date().toISOString(),
  })

  for (const [, client] of clients) {
    try { client.socket.send(payload) } catch {}
  }
}

function broadcastRawEvent(event) {
  const payload = JSON.stringify({
    type: 'raw_event',
    data: {
      plate: event.plate || event.data?.plate || '',
      direction: event.direction || event.data?.direction || '',
      cameraId: event.cameraId || event.data?.cameraId || '',
      cameraName: event.cameraName || event.data?.cameraName || '',
      action: event.action || event.data?.action || '',
      reason: event.reason || event.data?.reason || '',
      sessionId: event.sessionId || event.data?.sessionId || (event.session?._id?.toString()) || '',
      eventTime: event.eventTime || new Date().toISOString(),
      receivedAt: event.receivedAt || new Date().toISOString(),
    },
    timestamp: new Date().toISOString(),
  })

  for (const [, client] of clients) {
    try { client.socket.send(payload) } catch {}
  }
}

async function sendRecentRawEvents(clientId) {
  const client = clients.get(clientId)
  if (!client) return

  try {
    const events = await RawEvent.find({})
      .sort({ receivedAt: -1 })
      .limit(50)
      .lean()

    client.socket.send(JSON.stringify({
      type: 'raw_events',
      data: events,
      timestamp: new Date().toISOString(),
    }))
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to send raw events')
  }
}

module.exports = { setupWebSocket, broadcastActiveSessions, broadcastNewSession, broadcastSessionUpdate, broadcastNewEvent, broadcastRawEvent }
