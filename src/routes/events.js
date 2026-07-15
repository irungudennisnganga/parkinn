const { processAnprEvent } = require('../services/EventProcessor')
const { EventLog } = require('../models/EventLog')
const { RawEvent } = require('../models/RawEvent')
const { HikCentralClient } = require('../services/HikCentralClient')
const { Camera } = require('../models/Camera')
const { ParkingLot } = require('../models/ParkingLot')
const { logger } = require('../utils/logger')
const { isoLocal, hikNow } = require('../utils/dateUtils')
const { broadcastNewEvent, broadcastActiveSessions, broadcastRawEvent, broadcastSessionUpdate } = require('../services/WebSocketManager')

const hik = new HikCentralClient()

async function eventRoutes(app) {
  app.post('/eventsRCV', async (request, reply) => {
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

    reply.status(200).send({ code: '0', msg: 'success' })

    setImmediate(async () => {
      let processedCount = 0
      for (const evt of events) {
        if (evt.plateNumber) {
          const result = await processAnprEvent(evt)
          if (result) updateLog(result, rawBody)
          processedCount++

          const needsFallback = !result?.session &&
            !(result?.action === 'skip' && result?.reason?.includes('already has active session')) &&
            !(result?.action === 'skip' && result?.reason?.includes('30 seconds')) &&
            result?.action !== 'blocked'

          if (needsFallback) {
            await createSessionFromPassageway(evt.plateNumber)
          }
          continue
        }

        if (evt.needsFallback && evt.cameraName) {
          const fallbackVehicles = await fetchPassagewayRecords(evt.cameraName, evt.eventTime || new Date().toISOString())
          logger.info({ cameraName: evt.cameraName, found: fallbackVehicles.length }, 'Fallback passageway records')

          for (const veh of fallbackVehicles) {
            if (!veh.plateNumber) continue
            const vehEvent = {
              plateNumber: veh.plateNumber,
              cameraId: veh.cameraId || '',
              cameraName: evt.cameraName,
              eventTime: veh.eventTime || evt.eventTime || new Date().toISOString(),
            }
            const result = await processAnprEvent(vehEvent)
            if (result) updateLog(result, rawBody)
            processedCount++
          }
          continue
        }

        logger.warn({ evt }, 'Event has no plate and no fallback available, skipped')
        await saveDroppedEvent(rawBody, evt.plateNumber || '', 'Event has no plate number', evt.cameraId || '', evt.cameraName || '')
      }

      if (processedCount === 0) {
        logger.warn({ count: events.length }, 'No events were processed')
        await saveDroppedEvent(rawBody, '', 'All events skipped — no plates found', '', '')
      }
    })
  })
}

function extractEvents(rawBody) {
  if (rawBody && rawBody.params && rawBody.params.events && Array.isArray(rawBody.params.events)) {
    const results = []
    for (const evt of rawBody.params.events) {
      const data = evt.data || evt
      results.push({
        plateNumber: data.plateNo || data.plateNumber || data.plateLicense || '',
        cameraId: evt.srcIndex || data.srcIndex || evt.sourceID || '',
        cameraName: evt.srcName || data.srcName || '',
        eventTime: evt.eventTime || data.eventTime || rawBody.params.sendTime || evt.occurTime || new Date().toISOString(),
        needsFallback: false,
      })
    }
    return results
  }

  const eventData = rawBody && (rawBody.eventData || rawBody.data)
  if (eventData && eventData.plateNumber && eventData.cameraId) {
    return [eventData]
  }

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

  if (rawBody && rawBody.list && Array.isArray(rawBody.list)) {
    return rawBody.list
  }

  if (typeof rawBody === 'string') {
    return extractFromStringEvent(rawBody)
  }

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
    needsFallback: !plate,
  }]
}

async function fetchPassagewayRecords(cameraName, eventTime) {
  const results = []
  const now = hikNow()
  const windowStart = new Date(now.getTime() - 15 * 60000)
  const windowEnd = new Date(now.getTime() + 5 * 60000)
  const startTime = isoLocal(windowStart)
  const endTime = isoLocal(windowEnd)

  logger.info({ cameraName, startTime, endTime, serverTime: isoLocal(now) }, 'Fetching passageway records — wide window for clock skew')

  let targetLots = []

  const strippedName = cameraName.replace(/^ANPR\s+/i, '').trim()
  const safeName = cameraName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const safeStripped = strippedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  let cam = await Camera.findOne({
    name: { $regex: safeName, $options: 'i' },
  })
  if (!cam) {
    cam = await Camera.findOne({
      name: { $regex: safeStripped, $options: 'i' },
    })
  }

  if (cam && cam.areaId) {
    targetLots = await ParkingLot.find({ parkingLotId: cam.areaId }).lean()
  }

  if (targetLots.length === 0) {
    targetLots = await ParkingLot.find().lean()
  }

  logger.info({ cameraName, lotCount: targetLots.length, startTime, endTime }, 'Fetching passageway records for fallback')

  const seenPlates = new Set()

  for (const lot of targetLots) {
    const lotCode = lot.parkingLotIndexCode || lot.parkingLotId
    try {
      const pr = await hik.getPassagewayRecords(lotCode, startTime, endTime)
      const records = pr?.data?.list || []

      for (const rec of records) {
        const car = rec.carInfo
        if (!car || !car.plateLicense || car.plateLicense === 'Unknown') continue
        const plate = car.plateLicense.toUpperCase().replace(/\s+/g, '').trim()
        if (seenPlates.has(plate)) continue
        seenPlates.add(plate)

        const laneDir = rec.laneInfo?.direction
        const eventTime = laneDir === 2 && car.ExitTime
          ? car.ExitTime
          : (car.EnterTime || now.toISOString())

        results.push({
          plateNumber: plate,
          cameraId: rec.laneInfo?.laneIndexCode || '',
          eventTime,
        })
      }
    } catch (e) {
      logger.warn({ lotCode, err: e.message }, 'Failed to fetch passageway records')
    }
  }

  return results
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

async function createSessionFromPassageway(plate) {
  try {
    const { VehicleSession } = require('../models/VehicleSession')
    const { Camera } = require('../models/Camera')
    const { Barrier } = require('../models/Barrier')

    const now = hikNow()
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())

    const existing = await VehicleSession.findOne({
      plate,
      entryTime: { $gte: startOfToday },
      status: 'active',
    })
    if (existing) return

    const startTime = isoLocal(startOfToday)
    const endTime = isoLocal(now)
    const lots = await ParkingLot.find().lean()

    const cameras = await Camera.find().lean()
    const cameraByIndexCode = Object.fromEntries(cameras.map(c => [c.indexCode, c]))
    const cameraById = Object.fromEntries(cameras.map(c => [c.cameraId, c]))
    const barriers = await Barrier.find().lean()
    const barrierByCameraId = Object.fromEntries(barriers.map(b => [b.cameraId, b]))

    let created = false

    for (const lot of lots) {
      try {
        const pr = await hik.getPassagewayRecords(lot.parkingLotIndexCode || lot.parkingLotId, startTime, endTime)
        const records = pr?.data?.list || []
        for (const rec of records) {
          const car = rec.carInfo || {}
          const lane = rec.laneInfo || {}
          const recPlate = (car.plateLicense || '').toUpperCase().replace(/\s+/g, '').trim()
          if (recPlate !== plate) continue

          const cam = cameraByIndexCode[lane.laneIndexCode] || cameraById[lane.laneIndexCode] || null
          const barrier = cam ? barrierByCameraId[cam.cameraId] : null

          if (lane.direction === 1 && !created) {
            await VehicleSession.create({
              plate,
              entryTime: new Date(car.EnterTime || now.toISOString()),
              entryCamera: cam?.cameraId || lane.laneIndexCode || 'hikcentral',
              entryBarrier: barrier?.barrierId || cam?.cameraId || lane.laneIndexCode || 'hikcentral',
              isKnown: false,
              status: 'active',
            })
            created = true
            logger.info({ plate, cameraId: cam?.cameraId }, 'Reactive: session created from passageway')
          }

          if (lane.direction === 2 && !created) {
            const alreadyExists = await VehicleSession.findOne({ plate, entryTime: { $gte: startOfToday }, status: 'active' })
            if (!alreadyExists) {
              const entryFromRecord = car.EnterTime || null
              await VehicleSession.create({
                plate,
                entryTime: entryFromRecord ? new Date(entryFromRecord) : new Date(now.getTime() - 3600000),
                exitTime: new Date(car.ExitTime || now.toISOString()),
                entryCamera: cam?.cameraId || lane.laneIndexCode || 'hikcentral',
                exitCamera: cam?.cameraId || lane.laneIndexCode || 'hikcentral',
                entryBarrier: barrier?.barrierId || cam?.cameraId || lane.laneIndexCode || 'hikcentral',
                isKnown: false,
                status: 'unpaid',
                chargeAmount: 0,
              })
              created = true
              logger.info({ plate }, 'Reactive: exited-without-session created as unpaid')
            }
          }

          if (lane.direction === 2 && created) {
            const session = await VehicleSession.findOne({ plate, status: 'active' })
            if (session) {
              session.exitTime = new Date(car.ExitTime || now.toISOString())
              session.exitCamera = cam?.cameraId || lane.laneIndexCode || session.entryCamera
              session.status = 'unpaid'
              await session.save()
              broadcastSessionUpdate(session)
              logger.info({ plate, sessionId: session._id }, 'Reactive: session auto-closed as unpaid from passageway exit')
            }
          }
        }
      } catch (_) {}
    }

    if (created) {
      broadcastActiveSessions()
    }
  } catch (err) {
    logger.warn({ plate, err: err.message }, 'Reactive passageway fallback failed')
  }
}

module.exports = { eventRoutes }
