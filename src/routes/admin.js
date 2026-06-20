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

  // Open by camera (lane) ID
  app.post('/camera/:id/open', async (req) => {
    const { id } = req.params
    // Try both entry (0) and exit (1) directions
    const cam = await Camera.findOne({ cameraId: id })
    const dir = cam?.direction === 'exit' ? 1 : 0
    const result = await openBarrier(id, dir)
    return { id, direction: dir, action: 'camera-open', ...result }
  })

  // Event subscription status
  app.get('/subscription', async () => {
    const res = await hik.getEventSubscriptionView()
    const sub = await EventSubscription.findOne().sort({ subscribedAt: -1 }).lean()
    return { hikcentral: res, local: sub }
  })
  app.post('/barrier/pay', async (req) => {
    const { plate } = req.body
    if (!plate) return { success: false, error: 'plate required' }
    const calc = await hik.calculateParkingFee(plate)
    logger.info({ plate, calc }, 'Fee calculate')
    const res = await hik.confirmParkingFee(plate)
    logger.info({ plate, response: res }, 'Fee confirm')
    return { success: res?.code === '0', plate, calc: calc?.data, confirm: res }
  })
}

module.exports = { adminRoutes }
