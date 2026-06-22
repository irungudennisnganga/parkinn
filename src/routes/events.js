const { processAnprEvent } = require('../services/EventProcessor')
const { EventLog } = require('../models/EventLog')
const { HikCentralClient } = require('../services/HikCentralClient')
const { Camera } = require('../models/Camera')
const { ParkingLot } = require('../models/ParkingLot')
const { logger } = require('../utils/logger')
const { isoLocal } = require('../utils/dateUtils')

const hik = new HikCentralClient()
const ANPR_EVENT_TYPES = [131329, 131330, 131331]

async function eventRoutes(app) {
  app.post('/eventsRCV', async (request, reply) => {
    try {
      const contentType = request.headers['content-type'] || ''
      const rawBody = request.body

      logger.info({ contentType, bodyType: typeof rawBody }, 'Event received at /eventsRCV')

      // Save raw event to DB for inspection
      await EventLog.create({ body: rawBody, format: typeof rawBody, receivedAt: new Date() })

      // Handle string body (HikCentral combined alarm notification)
      if (typeof rawBody === 'string') {
        const parsed = parseStringEvent(rawBody)
        if (parsed) {
          logger.info({ parsed }, 'Combined alarm notification — pulling event data')
          const now = new Date()
          const windowMinsAgo = new Date(now - 15 * 60000)
          const startTime = isoLocal(windowMinsAgo)
          const endTime = isoLocal(now)
          logger.info({ startTime, endTime }, 'Time window for event records search')
          try {
            let records = await hik.searchEventRecords(startTime, endTime, ANPR_EVENT_TYPES)
            let events = records?.data?.list || []
            logger.info({ count: events.length, code: records?.code, total: records?.data?.total }, 'Pulled ANPR event records')

            if (events.length === 0) {
              logger.info('No ANPR events found, trying without event type filter')
              records = await hik.searchEventRecords(startTime, endTime)
              events = records?.data?.list || []
              logger.info({ count: events.length, code: records?.code }, 'Pulled all event records (no filter)')
            }

            if (events.length === 0) {
              logger.info('No event records found, falling back to passageway records')
              const lots = await ParkingLot.find().lean()
              for (const lot of lots) {
                const lotCode = lot.parkingLotIndexCode || lot.parkingLotId
                try {
                  const pr = await hik.getPassagewayRecords(lotCode, startTime, endTime)
                  const passRecords = pr?.data?.list || []
                  logger.info({ lotCode, count: passRecords.length }, 'Pulled passageway records')
                  for (const rec of passRecords) {
                    const car = rec.carInfo
                    const lane = rec.laneInfo
                    if (car?.plateLicense) {
                      const plateNumber = car.plateLicense
                      const cameraId = lane?.laneIndexCode || ''
                      const eventTime = car.EnterTime || rec.basicInfo?.occurrenceTime || now.toISOString()
                      const result = await processAnprEvent({ plateNumber, cameraId, eventTime })
                      if (result) updateLog(result)
                    }
                  }
                } catch (e) {
                  logger.warn({ lotCode, err: e.message }, 'Failed to pull passageway records')
                }
              }
            }

            for (const evt of events) {
              const data = evt.data || evt.eventData || evt
              const plateNumber = data.plateNo || data.plateNumber || data.plateLicense || ''
              const cameraId = evt.srcIndex || data.srcIndex || evt.sourceID || ''
              if (plateNumber) {
                const result = await processAnprEvent({ plateNumber, cameraId, eventTime: evt.sendTime || evt.eventTime || now.toISOString() })
                if (result) updateLog(result)
              }
            }
          } catch (err) {
            logger.warn({ err: err.message }, 'Failed to pull event records')
          }
        }
        return reply.status(200).send({ code: '0', msg: 'success' })
      }

      // Handle JSON body
      if (typeof rawBody === 'object' && rawBody !== null) {
        // Real ANPR event format: { method: "OnEventNotify", params: { ability: "event_veh", events: [...] } }
        if (rawBody.params && rawBody.params.events && Array.isArray(rawBody.params.events)) {
          for (const evt of rawBody.params.events) {
            const data = evt.data || evt
            const event = {
              plateNumber: data.plateNo || '',
              cameraId: evt.srcIndex || data.srcIndex || '',
              eventTime: rawBody.params.sendTime || new Date().toISOString(),
            }
            if (event.plateNumber) {
              const result = await processAnprEvent(event)
              if (result) updateLog(result)
            }
          }
          return reply.status(200).send({ code: '0', msg: 'success' })
        }

        // Simplified format: { eventData: { plateNumber, cameraId } }
        const eventData = rawBody.eventData || rawBody.data || rawBody
        if (eventData.plateNumber && eventData.cameraId) {
          const result = await processAnprEvent(eventData)
          if (result) updateLog(result)
          return reply.status(200).send({ code: '0', msg: 'success' })
        }

        // Array format: { events: [...] }
        if (Array.isArray(rawBody.events)) {
          for (const evt of rawBody.events) {
            const inner = evt.eventData || evt.data || evt
            if (inner.plateNumber && inner.cameraId) {
              const result = await processAnprEvent(inner)
              if (result) updateLog(result)
            }
          }
          return reply.status(200).send({ code: '0', msg: 'success' })
        }

        // List format: { list: [...] }
        if (rawBody.list && Array.isArray(rawBody.list)) {
          for (const evt of rawBody.list) {
            const result = await processAnprEvent(evt)
            if (result) updateLog(result)
          }
          return reply.status(200).send({ code: '0', msg: 'success' })
        }

        logger.warn({ body: rawBody }, 'Unrecognized JSON event')
      }

      return reply.status(200).send({ code: '0', msg: 'success' })
    } catch (err) {
      logger.error({ err: err.message }, 'Error processing event')
      return reply.status(200).send({ code: '0', msg: 'success' })
    }
  })
}

async function updateLog(result) {
  if (!result) return
  await EventLog.findOneAndUpdate(
    { plate: result.plate, cameraId: result.cameraId, receivedAt: { $gte: new Date(Date.now() - 60000) } },
    { processed: true, plate: result.plate, cameraId: result.cameraId, direction: result.direction }
  )
}

function parseStringEvent(str) {
  const plateMatch = str.match(/\b([A-Z]{1,3}\s?\d{1,4}[A-Z]{0,1})\b/g)
  const areaMatch = str.match(/(ANPR\s[\dA-Z\s]+?(?:ENTRY|EXIT))/i)
  if (plateMatch || areaMatch) {
    return { plateNumber: plateMatch?.[0] || '', cameraName: areaMatch?.[0] || '', rawString: str }
  }
  return null
}

module.exports = { eventRoutes }
