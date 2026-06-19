const { processAnprEvent } = require('../services/EventProcessor')
const { logger } = require('../utils/logger')

async function eventRoutes(app) {
  app.post('/eventsRCV', async (request, reply) => {
    try {
      const body = request.body
      logger.info({ body }, 'Event received at /eventsRCV')

      const eventData = body.eventData || body.data || body

      if (body.list && Array.isArray(body.list)) {
        for (const evt of body.list) {
          await processAnprEvent(evt)
        }
      } else if (eventData && eventData.plateNumber && eventData.cameraId) {
        await processAnprEvent(eventData)
      } else if (Array.isArray(body.events)) {
        for (const evt of body.events) {
          const inner = evt.eventData || evt.data || evt
          if (inner.plateNumber && inner.cameraId) {
            await processAnprEvent(inner)
          }
        }
      } else {
        logger.warn({ body }, 'Unrecognized event payload structure')
      }

      return reply.status(200).send({ code: '0', msg: 'success' })
    } catch (err) {
      logger.error({ err: err.message }, 'Error processing event')
      return reply.status(200).send({ code: '0', msg: 'success' })
    }
  })
}

module.exports = { eventRoutes }
