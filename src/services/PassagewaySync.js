const { VehicleSession } = require('../models/VehicleSession')
const { ParkingLot } = require('../models/ParkingLot')
const { HikCentralClient } = require('./HikCentralClient')
const { logger } = require('../utils/logger')
const { isoLocal, hikNow, hikQueryEnd } = require('../utils/dateUtils')
const { processAnprEvent } = require('./EventProcessor')
const { broadcastActiveSessions, broadcastSessionUpdate } = require('./WebSocketManager')
const config = require('../config')

const RECONCILE_INTERVAL_MS = 1 * 60 * 1000
const LOOKBACK_MINUTES = 2

let timer = null
let running = false
let lastRun = null

async function reconcile() {
  if (running) return
  running = true

  try {
    const hik = new HikCentralClient()
    const now = hikNow()
    const queryEnd = hikQueryEnd()
    const localNow = new Date()
    const lookback = lastRun
      ? Math.max(LOOKBACK_MINUTES, (localNow - lastRun) / 60000 + 1)
      : (now.getHours() * 60 + now.getMinutes())
    const startTime = isoLocal(new Date(now.getTime() - lookback * 60000))
    const endTime = isoLocal(queryEnd)

    const lots = await ParkingLot.find().lean()
    if (!lots.length) return

    let created = 0
    let exited = 0
    let skipped = 0
    const seen = new Set()

    for (const lot of lots) {
      const code = lot.parkingLotIndexCode || lot.parkingLotId
      try {
        const pr = await hik.getPassagewayRecords(code, startTime, endTime)
        const records = pr?.data?.list || []

        for (const rec of records) {
          const car = rec.carInfo || {}
          const lane = rec.laneInfo || {}
          const plate = (car.plateLicense || '').toUpperCase().replace(/\s+/g, '').trim()
          if (!plate || plate === 'UNKNOWN' || seen.has(plate)) continue
          seen.add(plate)

          const isEntry = lane.direction === 1
          const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
          const existing = await VehicleSession.findOne({
            plate,
            entryTime: { $gte: startOfToday },
            status: 'active',
          })

          if (isEntry && !existing) {
            const eventTime = car.EnterTime || now.toISOString()
            const result = await processAnprEvent({
              plateNumber: plate,
              cameraId: lane.laneIndexCode || '',
              cameraName: rec.passagewayInfo?.passagewayName || '',
              eventTime,
            })
            if (result?.session) {
              created++
              logger.info({ plate, sessionId: result.session._id }, 'Reconciled: session created from missed entry')
            }
          } else if (!isEntry && existing && existing.status === 'active') {
            const exitTime = car.ExitTime || now.toISOString()
            existing.exitTime = new Date(exitTime)
            existing.exitCamera = lane.laneIndexCode || existing.entryCamera
            existing.status = 'exited'
            await existing.save()
            broadcastSessionUpdate(existing)
            exited++
            logger.info({ plate, sessionId: existing._id }, 'Reconciled: stale active session closed from exit record')
          } else {
            skipped++
          }
        }
      } catch (e) {
        logger.warn({ lotCode: code, err: e.message }, 'Reconcile: lot fetch failed')
      }
    }

    if (created > 0 || exited > 0) {
      logger.info({ created, exited, skipped, lookbackMinutes: Math.round(lookback), lotsChecked: lots.length },
        'Reconciliation complete')
      broadcastActiveSessions()
    }
  } catch (err) {
    logger.error({ err: err.message }, 'Reconciliation failed')
  } finally {
    lastRun = new Date()
    running = false
  }
}

function start() {
  if (timer) return
  logger.info({ intervalSec: RECONCILE_INTERVAL_MS / 1000, lookbackMin: LOOKBACK_MINUTES },
    'Starting HikCentral passageway reconciliation')

  reconcile()
  timer = setInterval(reconcile, RECONCILE_INTERVAL_MS)
}

function stop() {
  if (timer) { clearInterval(timer); timer = null }
}

module.exports = { startPassagewaySync: start, stopPassagewaySync: stop, syncPassagewayRecords: reconcile }
