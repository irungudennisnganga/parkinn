const { syncResources } = require('../services/ResourceSync')
const { Area } = require('../models/Area')
const { Camera } = require('../models/Camera')
const { Barrier } = require('../models/Barrier')
const { VehicleRecord } = require('../models/VehicleRecord')
const { openBarrier, closeBarrier } = require('../services/BarrierControl')
const { HikCentralClient } = require('../services/HikCentralClient')
const { EventSubscription } = require('../models/EventSubscription')
const { logger } = require('../utils/logger')

const hik = new HikCentralClient()

async function adminRoutes(app) {
  app.post('/resources', async () => {
    const result = await syncResources()
    logger.info(result, 'Manual resource sync triggered')
    return { success: true, ...result }
  })

  app.get('/status', async () => {
    const [areas, cameras, barriers, vehicleRecords] = await Promise.all([
      Area.countDocuments(),
      Camera.countDocuments(),
      Barrier.countDocuments(),
      VehicleRecord.countDocuments(),
    ])
    return { areas, cameras, barriers, vehicleRecords }
  })

  app.get('/barriers', async () => {
    const barriers = await Barrier.find().lean()
    return barriers.map(b => ({ id: b.barrierId, name: b.name, cameraId: b.cameraId }))
  })

  app.get('/cameras', async () => {
    const cameras = await Camera.find().lean()
    return cameras.map(c => ({ id: c.cameraId, name: c.name, direction: c.direction }))
  })

  // Open/close by ID — tries alarmOutput first, then ACS door control
  app.post('/barrier/:id/open', async (req) => {
    const { id } = req.params
    const dir = parseInt(req.query.direction || '0')
    const result = await openBarrier(id, dir)
    return { id, direction: dir, action: 'open', ...result }
  })

  app.post('/barrier/:id/close', async (req) => {
    const { id } = req.params
    const dir = parseInt(req.query.direction || '0')
    const result = await closeBarrier(id, dir)
    return { id, direction: dir, action: 'close', ...result }
  })

  // Open by camera (lane) ID — tries ANPR gate control first, then alarm output, then ACS door
  app.post('/camera/:id/open', async (req) => {
    const { id } = req.params
    const cam = await Camera.findOne({ cameraId: id })
    const dir = cam?.direction === 'exit' ? 1 : 0
    const result = await openBarrier(id, dir, id)
    return { id, direction: dir, action: 'camera-open', ...result }
  })

  // Direct barrier gate control (camera-based) — tries alarmOutput → ACS door (HCCGW also if available)
  // POST /gate/control  body: { cameraId, controlMode }
  app.post('/gate/control', async (req) => {
    const { openBarrier: gateOpen, closeBarrier: gateClose } = require('../services/BarrierControl')
    const { cameraId, controlMode } = req.body
    if (!cameraId) return { success: false, error: 'cameraId required' }

    if (controlMode === 2) {
      const result = await gateClose(cameraId, 0)
      return { success: result.success, cameraId, action: 'close', method: result.method }
    }

    const result = await gateOpen(cameraId, 0, cameraId)
    return { success: result.success, cameraId, action: 'open', method: result.method }
  })

  // Event subscription status
  app.get('/subscription', async () => {
    const res = await hik.getEventSubscriptionView()
    const sub = await EventSubscription.findOne().sort({ subscribedAt: -1 }).lean()
    return { hikcentral: res, local: sub }
  })
  app.get('/vehicles', async (req) => {
    const filter = req.query.plate ? { plate: req.query.plate.toUpperCase() } : {}
    const records = await VehicleRecord.find(filter).sort({ enterTime: -1 }).limit(50).lean()
    return records.map(r => ({
      plate: r.plate,
      direction: r.direction,
      parkingLot: r.parkingLotName,
      passageway: r.passagewayName,
      lane: r.laneName,
      enterTime: fmtNairobi(r.enterTime),
      exitTime: fmtNairobi(r.exitTime),
      duration: formatDuration(r.durationSeconds),
      allowed: r.allowed,
      vehicleType: r.vehicleType,
    }))
  })
  app.post('/barrier/pay', async (req) => {
    const { plate } = req.body
    if (!plate) return { success: false, error: 'plate required' }
    const calc = await hik.calculateParkingFee(plate)
    const fee = calc?.data?.fee || '0'
    logger.info({ plate, fee, calc }, 'Fee calculate')
    const res = await hik.confirmParkingFee(plate, parseFloat(fee), 1)
    logger.info({ plate, fee, response: res }, 'Fee confirm')
    return { success: res?.code === '0', plate, calc: calc?.data, confirm: res }
  })
}

function fmtNairobi(d) {
  if (!d) return ''
  const n = new Date(d.getTime() + 3 * 3600000) // UTC+3 Nairobi
  return n.toISOString().replace('Z', '+03:00')
}

function formatDuration(seconds) {
  if (!seconds) return 'N/A'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const parts = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0) parts.push(`${h}h`)
  parts.push(`${m}m`)
  return parts.join(' ')
}

module.exports = { adminRoutes }
