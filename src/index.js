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
const { startPassagewaySync } = require('./services/PassagewaySync')
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
  app.register(paymentRoutes, { prefix: '/public/payments' })
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

async function startStaleSessionCleanup() {
  const { VehicleSession } = require('./models/VehicleSession')
  const { ParkingLot } = require('./models/ParkingLot')
  const { HikCentralClient } = require('./services/HikCentralClient')
  const { isoLocal } = require('./utils/dateUtils')
  const hik = new HikCentralClient()
  let firstRun = true

  async function check() {
    try {
      const sessions = await VehicleSession.find({ status: 'active' }, { plate: 1 }).lean()
      if (!sessions.length) return

      const now = new Date()
      const lookbackMinutes = firstRun ? (now.getHours() * 60 + now.getMinutes()) : 10
      const startTime = isoLocal(new Date(now.getTime() - lookbackMinutes * 60000))
      const endTime = isoLocal(now)
      const lots = await ParkingLot.find().lean()

      let closedCount = 0
      for (const s of sessions) {
        for (const lot of lots) {
          try {
            const pr = await hik.getPassagewayRecords(lot.parkingLotIndexCode || lot.parkingLotId, startTime, endTime)
            const records = pr?.data?.list || []
            for (const rec of records) {
              const car = rec.carInfo || {}
              const lane = rec.laneInfo || {}
              const plate = (car.plateLicense || '').toUpperCase().replace(/\s+/g, '').trim()
              if (plate !== s.plate || lane.direction !== 2) continue

              await VehicleSession.updateOne(
                { _id: s._id, status: 'active' },
                {
                  $set: {
                    exitTime: new Date(car.ExitTime || now.toISOString()),
                    exitCamera: lane.laneIndexCode || s.entryCamera,
                    status: 'unpaid',
                  },
                },
              )
              closedCount++
              logger.info({ plate: s.plate }, 'Auto-closed stale active session from exit record')
            }
          } catch (_) {}
        }
      }

      if (firstRun) firstRun = false

      if (closedCount > 0) {
        const { broadcastActiveSessions } = require('./services/WebSocketManager')
        broadcastActiveSessions()
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'Stale session cleanup check failed')
    }
  }

  check()
  setInterval(check, config.reconciliation.cleanupIntervalMs)
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

    startStaleSessionCleanup()

    try {
      const { VehicleSession } = require('./models/VehicleSession')
      const { RegisteredVehicle } = require('./models/RegisteredVehicle')
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
      const registeredPlates = new Set(
        (await RegisteredVehicle.find({ isActive: true }, { plate: 1 }).lean()).map(r => r.plate),
      )

      logger.info({ lotsCount: lots.length, registeredCount: registeredPlates.size }, 'Running startup passageway reconciliation for today')

      const cameras = await Camera.find().lean()
      const cameraByIndexCode = Object.fromEntries(cameras.map(c => [c.indexCode, c]))
      const cameraById = Object.fromEntries(cameras.map(c => [c.cameraId, c]))
      const barriers = await Barrier.find().lean()
      const barrierByCameraId = Object.fromEntries(barriers.map(b => [b.cameraId, b]))

      const allPlates = new Set()
      const plateRecords = new Map()
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

            if (!plateRecords.has(plate)) {
              plateRecords.set(plate, { entry: null, exit: null })
            }
            const prData = plateRecords.get(plate)

            const cam = cameraByIndexCode[lane.laneIndexCode] || cameraById[lane.laneIndexCode] || null
            const barrier = cam ? barrierByCameraId[cam.cameraId] : null

            if (lane.direction === 1 && !prData.entry) {
              prData.entry = { enterTime: car.EnterTime, cameraId: cam?.cameraId || lane.laneIndexCode, barrierId: barrier?.barrierId || cam?.cameraId || lane.laneIndexCode }
            }
            if (lane.direction === 2 && !prData.exit) {
              prData.exit = { exitTime: car.ExitTime, cameraId: cam?.cameraId || lane.laneIndexCode }
            }
          }
        } catch (e) {
          logger.warn({ lotCode: lot.parkingLotIndexCode || lot.parkingLotId, err: e.message }, 'Startup sync: lot fetch failed')
        }
      }

      for (const [plate, pr] of plateRecords) {
        const existing = await VehicleSession.findOne({
          plate,
          status: { $in: ['active', 'unpaid', 'paid'] },
        }).sort({ entryTime: -1 })

        const hasActiveSession = existing?.status === 'active'
        const isKnown = registeredPlates.has(plate)

        if (!existing && pr.entry) {
          try {
            await VehicleSession.create({
              plate,
              entryTime: new Date(pr.entry.enterTime || now.toISOString()),
              entryCamera: pr.entry.cameraId || 'hikcentral',
              entryBarrier: pr.entry.barrierId || pr.entry.cameraId || 'hikcentral',
              isKnown,
              status: pr.exit ? 'unpaid' : 'active',
              exitTime: pr.exit ? new Date(pr.exit.exitTime) : undefined,
              exitCamera: pr.exit ? pr.exit.cameraId : undefined,
            })
            created++
            logger.info({ plate, isKnown, hasExit: !!pr.exit }, 'Startup sync: session created')
          } catch (e) {
            if (e.code !== 11000) {
              logger.warn({ plate, err: e.message }, 'Startup sync: session creation failed')
            }
          }
        }

        if (!existing && !pr.entry && pr.exit) {
          try {
            await VehicleSession.create({
              plate,
              entryTime: new Date(now.getTime() - 3600000),
              exitTime: new Date(pr.exit.exitTime || now.toISOString()),
              entryCamera: pr.exit.cameraId || 'hikcentral',
              exitCamera: pr.exit.cameraId || 'hikcentral',
              entryBarrier: pr.exit.cameraId || 'hikcentral',
              isKnown,
              status: 'unpaid',
              chargeAmount: 0,
            })
            created++
            logger.info({ plate }, 'Startup sync: exit-only session created as unpaid')
          } catch (e) {
            if (e.code !== 11000) {
              logger.warn({ plate, err: e.message }, 'Startup sync: exit-only creation failed')
            }
          }
        }

        if (pr.exit && hasActiveSession) {
          existing.exitTime = new Date(pr.exit.exitTime || now.toISOString())
          existing.exitCamera = pr.exit.cameraId || existing.entryCamera
          existing.status = 'unpaid'
          await existing.save()
          closed++
          logger.info({ plate, sessionId: existing._id }, 'Startup sync: active session closed as unpaid')
        }

        if (pr.exit && !hasActiveSession && existing) {
          const activeDuplicate = await VehicleSession.findOne({ plate, status: 'active' })
          if (activeDuplicate) {
            activeDuplicate.exitTime = new Date(pr.exit.exitTime || now.toISOString())
            activeDuplicate.exitCamera = pr.exit.cameraId || activeDuplicate.entryCamera
            activeDuplicate.status = 'unpaid'
            await activeDuplicate.save()
            closed++
            logger.info({ plate, sessionId: activeDuplicate._id }, 'Startup sync: orphaned active session closed as unpaid')
          }
        }
      }

      if (created > 0 || closed > 0) {
        broadcastActiveSessions()
      }
      logger.info({ created, closed, totalPlates: allPlates.size }, 'Startup passageway reconciliation complete')
    } catch (err) {
      logger.warn({ err: err.message }, 'Startup passageway reconciliation failed')
    }

    startPassagewaySync()
  } catch (err) {
    logger.error(err, 'Failed to start server')
    process.exit(1)
  }
}

if (require.main === module) {
  main()
}

module.exports = { createApp }
