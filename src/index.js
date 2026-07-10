require('dotenv').config()

const Fastify = require('fastify')
const cors = require('@fastify/cors')
const websocketPlugin = require('@fastify/websocket')
const config = require('./config')
const { logger } = require('./utils/logger')
const { connectMongo } = require('./config/database')
const { eventRoutes } = require('./routes/events')
const { vehicleRoutes } = require('./routes/vehicles')
const { adminRoutes } = require('./routes/admin')
const { mpesaRoutes } = require('./routes/mpesa')
const { authRoutes } = require('./routes/auth')
const { paymentRoutes } = require('./routes/payments')
const { recordRoutes } = require('./routes/records')
const { parkingRoutes } = require('./routes/parking')
const { syncResources, setupWebhook } = require('./services/ResourceSync')
const { setupWebSocket } = require('./services/WebSocketManager')
const { jwtAuth } = require('./middleware/jwtAuth')

async function createApp() {
  const app = Fastify({
    logger: {
      transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' } },
    },
  })

  await app.register(cors, {
    origin: (origin, cb) => {
      cb(null, true)
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
  await app.register(websocketPlugin)
  await connectMongo()

  const wsManager = setupWebSocket(app)

  app.register(authRoutes, { prefix: '/auth' })
  app.register(mpesaRoutes, { prefix: '/mpesa' })
  app.register(eventRoutes, { prefix: '/' })

  app.register(async function protectedRoutes(scope) {
    scope.addHook('preHandler', jwtAuth)

    scope.register(vehicleRoutes, { prefix: '/vehicles' })
    scope.register(adminRoutes, { prefix: '/sync' })
    scope.register(paymentRoutes, { prefix: '/payments' })
    scope.register(recordRoutes, { prefix: '/records' })
    scope.register(parkingRoutes, { prefix: '/parking' })
  })

  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }))

  return { app, wsManager }
}

async function main() {
  const { app } = await createApp()

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' })
    logger.info(`Server running on port ${config.port}`)

    try {
      const [webhookSetup, resourcesSynced] = await Promise.allSettled([
        setupWebhook(),
        syncResources(),
      ])
      if (webhookSetup.status === 'fulfilled') logger.info({ result: webhookSetup.value }, 'Webhook setup')
      else logger.warn({ err: webhookSetup.reason?.message }, 'Webhook setup skipped')
      if (resourcesSynced.status === 'fulfilled') logger.info({ result: resourcesSynced.value }, 'Resource sync complete')
      else logger.warn({ err: resourcesSynced.reason?.message }, 'Resource sync failed')
    } catch (err) {
      logger.warn({ err: err.message }, 'Startup initialization had issues')
    }

    setImmediate(async () => {
      try {
        const { VehicleSession } = require('./models/VehicleSession')
        const { Camera } = require('./models/Camera')
        const { Barrier } = require('./models/Barrier')
        const { ParkingLot } = require('./models/ParkingLot')
        const { HikCentralClient } = require('./services/HikCentralClient')
        const { isoLocal } = require('./utils/dateUtils')
        const { broadcastActiveSessions } = require('./services/WebSocketManager')
        const hik = new HikCentralClient()
        const now = new Date()
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        const startTime = isoLocal(startOfToday)
        const endTime = isoLocal(now)
        const lots = await ParkingLot.find().lean()

        logger.info({ lotsCount: lots.length }, 'Running startup passageway reconciliation for today')

        const cameras = await Camera.find().lean()
        const cameraByIndexCode = Object.fromEntries(cameras.map(c => [c.indexCode, c]))
        const cameraById = Object.fromEntries(cameras.map(c => [c.cameraId, c]))
        const barriers = await Barrier.find().lean()
        const barrierByCameraId = Object.fromEntries(barriers.map(b => [b.cameraId, b]))

        const seenPlates = new Set()
        const allPlates = new Set()
        let created = 0
        let closed = 0

        for (const lot of lots) {
          try {
            const pr = await hik.getPassagewayRecords(lot.parkingLotIndexCode || lot.parkingLotId, startTime, endTime)
            const records = pr?.data?.list || []

            for (const rec of records) {
              const car = rec.carInfo || {}
              const lane = rec.laneInfo || {}
              const plate = (car.plateLicense || '').toUpperCase().replace(/\s+/g, '').trim()
              if (!plate || plate === 'UNKNOWN') continue
              allPlates.add(plate)

              const existing = await VehicleSession.findOne({
                plate,
                status: { $in: ['active', 'unpaid', 'paid'] },
              })

              const cam = cameraByIndexCode[lane.laneIndexCode] || cameraById[lane.laneIndexCode] || null
              const barrier = cam ? barrierByCameraId[cam.cameraId] : null

              if (!existing && lane.direction === 1 && !seenPlates.has(plate)) {
                seenPlates.add(plate)
                try {
                  const session = await VehicleSession.create({
                    plate,
                    entryTime: new Date(car.EnterTime || now.toISOString()),
                    entryCamera: cam?.cameraId || lane.laneIndexCode || 'hikcentral',
                    entryBarrier: barrier?.barrierId || cam?.cameraId || lane.laneIndexCode || 'hikcentral',
                    isKnown: false,
                    status: 'active',
                  })
                  created++
                  logger.info({ plate, sessionId: session._id }, 'Startup sync: session created')
                } catch (e) {
                  if (e.code !== 11000) {
                    logger.warn({ plate, err: e.message }, 'Startup sync: session creation failed')
                  }
                }
              }

              if (existing && existing.status === 'active' && lane.direction === 2) {
                const exitTime = car.ExitTime
                existing.exitTime = exitTime ? new Date(exitTime) : new Date()
                existing.exitCamera = cam?.cameraId || lane.laneIndexCode || existing.entryCamera
                existing.status = 'unpaid'
                await existing.save()
                closed++
                logger.info({ plate, sessionId: existing._id }, 'Startup sync: stale session closed as unpaid')
              }
            }
          } catch (e) {
            logger.warn({ lotCode: lot.parkingLotIndexCode || lot.parkingLotId, err: e.message }, 'Startup sync: lot fetch failed')
          }
        }

        if (created > 0 || closed > 0) {
          broadcastActiveSessions()
        }
        logger.info({ created, closed, totalPlates: allPlates.size }, 'Startup passageway reconciliation complete')
      } catch (err) {
        logger.warn({ err: err.message }, 'Startup passageway reconciliation failed')
      }
    })
  } catch (err) {
    logger.error(err, 'Failed to start server')
    process.exit(1)
  }
}

if (require.main === module) {
  main()
}

module.exports = { createApp }
