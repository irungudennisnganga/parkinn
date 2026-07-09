const { processAnprEvent } = require('../services/EventProcessor')
const { EventLog } = require('../models/EventLog')
const { RawEvent } = require('../models/RawEvent')
const { logger } = require('../utils/logger')
const { broadcastNewEvent, broadcastActiveSessions, broadcastRawEvent } = require('../services/WebSocketManager')

async function eventRoutes(app) {
  app.post('/eventsRCV', async (request, reply) => {
    try {
      const rawBody = request.body

      logger.info({ contentType: request.headers['content-type'] || '', bodyType: typeof rawBody }, 'Event received at /eventsRCV')

      try {
        await RawEvent.create({
          body: rawBody,
          format: typeof rawBody === 'string' ? 'string' : 'json',
          receivedAt: new Date(),
        })
      } catch (er) {
        logger.warn({ err: er.message }, 'Failed to save initial RawEvent')
      }

      try {
        await EventLog.create({ body: rawBody, format: typeof rawBody, receivedAt: new Date() })
      } catch (er) {
        logger.warn({ err: er.message }, 'Failed to save EventLog')
      }

      const events = extractEvents(rawBody)

      if (events.length === 0) {
        logger.warn({ bodyPreview: JSON.stringify(rawBody).slice(0, 500) }, 'No events extracted from payload')
        await saveDroppedEvent(rawBody, '', 'No events extracted from webhook payload', '', '')
        return reply.status(200).send({ code: '0', msg: 'success' })
      }

      logger.info({ count: events.length, first: events[0] }, 'Processing events')
      for (const evt of events) {
        if (!evt.plateNumber) continue
        const result = await processAnprEvent(evt)
        if (result) updateLog(result, rawBody)
      }

      return reply.status(200).send({ code: '0', msg: 'success' })
    } catch (err) {
      logger.error({ err: err.message, stack: err.stack }, 'Error processing event')
      return reply.status(200).send({ code: '0', msg: 'success' })
    }
  })
}

function extractEvents(rawBody) {
  // Format 1: HikCentral OnEventNotify with params.events
  // { method: "OnEventNotify", params: { ability: "event_veh", events: [...], sendTime: "..." } }
  if (rawBody && rawBody.params && rawBody.params.events && Array.isArray(rawBody.params.events)) {
    const results = []
    for (const evt of rawBody.params.events) {
      const data = evt.data || evt
      results.push({
        plateNumber: data.plateNo || data.plateNumber || data.plateLicense || '',
        cameraId: evt.srcIndex || data.srcIndex || evt.sourceID || '',
        cameraName: evt.srcName || data.srcName || '',
        eventTime: rawBody.params.sendTime || evt.eventTime || new Date().toISOString(),
      })
    }
    return results
  }

  // Format 2: Simplified { eventData: { plateNumber, cameraId } }
  const eventData = rawBody && (rawBody.eventData || rawBody.data)
  if (eventData && eventData.plateNumber && eventData.cameraId) {
    return [eventData]
  }

  // Format 3: Array of events { events: [...] }
  if (rawBody && rawBody.events && Array.isArray(rawBody.events)) {
    const results = []
    for (const evt of rawBody.events) {
      const inner = evt.eventData || evt.data || evt
      if (inner.plateNumber && inner.cameraId) {
        results.push(inner)
      }
    }
    return results
  }

  // Format 4: List { list: [...] }
  if (rawBody && rawBody.list && Array.isArray(rawBody.list)) {
    return rawBody.list
  }

  // Format 5: String body (combined alarm notification from HikCentral)
  if (typeof rawBody === 'string') {
    return extractFromStringEvent(rawBody)
  }

  // Format 6: Single event object with plateNumber + cameraId at top level
  if (rawBody && rawBody.plateNumber && rawBody.cameraId) {
    return [rawBody]
  }

  return []
}

function extractFromStringEvent(rawString) {
  const plateMatch = rawString.match(/\b([A-Z]{1,3}\s?\d{1,4}[A-Z]{0,1})\b/gi)
  const areaMatch = rawString.match(/(ANPR\s[\dA-Z\s]+?(?:ENTRY|EXIT))/i)

  if (!plateMatch && !areaMatch) return []

  const plate = plateMatch ? plateMatch[0].toUpperCase().replace(/\s+/g, ' ').trim() : ''
  const cameraName = areaMatch ? areaMatch[0] : ''

  return [{
    plateNumber: plate,
    cameraName,
    eventTime: new Date().toISOString(),
    rawString,
  }]
}

async function updateLog(result, rawBody) {
  if (!result) return
  await EventLog.findOneAndUpdate(
    { plate: result.plate, cameraId: result.cameraId, receivedAt: { $gte: new Date(Date.now() - 60000) } },
    { processed: true, plate: result.plate, cameraId: result.cameraId, direction: result.direction },
  )

  await RawEvent.create({
    body: rawBody || {},
    format: 'processed',
    plate: result.plate || '',
    cameraId: result.cameraId || '',
    cameraName: result.cameraName || '',
    direction: result.direction || '',
    eventTime: result.eventTime || new Date().toISOString(),
    action: result.action || '',
    reason: result.reason || '',
    sessionId: result.session?._id?.toString() || '',
    processed: true,
    receivedAt: new Date(),
  })

  broadcastNewEvent(result)
  broadcastRawEvent(result)
  broadcastActiveSessions()
}

async function saveDroppedEvent(rawBody, plate, reason, cameraId, cameraName) {
  const doc = await RawEvent.create({
    body: rawBody || {},
    format: typeof rawBody === 'string' ? 'string' : 'json',
    plate: plate || '',
    cameraId: cameraId || 'unknown',
    cameraName: cameraName || '',
    direction: 'unknown',
    eventTime: new Date().toISOString(),
    action: 'dropped',
    reason: reason || 'Unknown reason',
    processed: false,
    receivedAt: new Date(),
  })
  broadcastRawEvent(doc)
}

module.exports = { eventRoutes }
