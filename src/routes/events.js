const { processAnprEvent } = require('../services/EventProcessor')
const { EventLog } = require('../models/EventLog')
const { logger } = require('../utils/logger')

async function eventRoutes(app) {
  app.post('/eventsRCV', async (request, reply) => {
    try {
      let body = request.body

      // Handle plain text body (HikCentral sends combined alarm as string)
      if (typeof body === 'string') {
        const parsed = parseStringEvent(body)
        if (parsed) {
          body = parsed
        }
      }

      // Save raw event
      await EventLog.create({
        body: body,
        format: typeof request.body === 'string' ? 'string' : 'json',
        receivedAt: new Date(),
      })

      logger.info({ body }, 'Event received at /eventsRCV')

      // Parse JSON events
      if (typeof body === 'object') {
        const eventData = body.eventData || body.data || body

        if (body.list && Array.isArray(body.list)) {
          for (const evt of body.list) {
            const result = await processAnprEvent(evt)
            if (result) {
              await EventLog.findOneAndUpdate(
                { plate: result.plate, cameraId: result.cameraId, receivedAt: { $gte: new Date(Date.now() - 60000) } },
                { processed: true, plate: result.plate, cameraId: result.cameraId, direction: result.direction }
              )
            }
          }
        } else if (eventData && eventData.plateNumber && eventData.cameraId) {
          const result = await processAnprEvent(eventData)
          if (result) {
            await EventLog.findOneAndUpdate(
              { plate: result.plate, cameraId: result.cameraId, receivedAt: { $gte: new Date(Date.now() - 60000) } },
              { processed: true, plate: result.plate, cameraId: result.cameraId, direction: result.direction }
            )
          }
        } else if (Array.isArray(body.events)) {
          for (const evt of body.events) {
            const inner = evt.eventData || evt.data || evt
            if (inner.plateNumber && inner.cameraId) {
              const result = await processAnprEvent(inner)
              if (result) {
                await EventLog.findOneAndUpdate(
                  { plate: result.plate, cameraId: result.cameraId, receivedAt: { $gte: new Date(Date.now() - 60000) } },
                  { processed: true, plate: result.plate, cameraId: result.cameraId, direction: result.direction }
                )
              }
            }
          }
        } else {
          logger.warn('Unrecognized event payload structure — saved for inspection')
        }
      }

      return reply.status(200).send({ code: '0', msg: 'success' })
    } catch (err) {
      logger.error({ err: err.message }, 'Error processing event')
      return reply.status(200).send({ code: '0', msg: 'success' })
    }
  })
}

function parseStringEvent(str) {
  // Extract plate number (e.g., KXX 999Z or KDJ673J)
  const plateMatch = str.match(/\b([A-Z]{1,3}\s?\d{1,4}[A-Z]{0,1})\b/g)
  // Extract area/floor name
  const areaMatch = str.match(/(ANPR\s[\dA-Z\s]+?(?:ENTRY|EXIT))/i)
  if (plateMatch || areaMatch) {
    return {
      plateNumber: plateMatch?.[0] || '',
      cameraName: areaMatch?.[0] || '',
      rawString: str,
    }
  }
  return null
}

module.exports = { eventRoutes }
