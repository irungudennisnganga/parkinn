require('dotenv').config()

const Fastify = require('fastify')
const cors = require('@fastify/cors')
const config = require('./config')
const { logger } = require('./utils/logger')
const { connectMongo } = require('./config/database')
const { eventRoutes } = require('./routes/events')
const { vehicleRoutes } = require('./routes/vehicles')
const { adminRoutes } = require('./routes/admin')
const { mpesaRoutes } = require('./routes/mpesa')
const { syncResources, setupWebhook } = require('./services/ResourceSync')

async function createApp() {
  const app = Fastify({
    logger: {
      transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' } },
    },
  })

  await app.register(cors, { origin: true })
  await connectMongo()

  app.register(eventRoutes, { prefix: '/' })
  app.register(vehicleRoutes, { prefix: '/vehicles' })
  app.register(adminRoutes, { prefix: '/sync' })
  app.register(mpesaRoutes, { prefix: '/mpesa' })
  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }))

  app.post('/payments/confirm', async (req, reply) => {
    const { VehicleSession } = require('./models/VehicleSession')
    const { openBarrierByCamera } = require('./services/BarrierControl')
    const { HikCentralClient } = require('./services/HikCentralClient')
    const hik = new HikCentralClient()

    const plate = (req.body?.plate || '').toUpperCase()
    if (!plate) return reply.status(400).send({ error: 'plate required' })

    const session = await VehicleSession.findOne({ plate, status: 'unpaid' })
    if (!session) return reply.status(404).send({ error: 'No unpaid session found for this plate' })

    session.status = 'paid'
    session.paymentRef = req.body.ref || 'manual'
    await session.save()

    try {
      const confirm = await hik.confirmParkingFee(plate)
      logger.info({ plate, confirm }, 'Parking fee confirmed in HikCentral')
      if (confirm?.code === '0') {
        session.status = 'exited'
        session.exitTime = new Date()
        await session.save()
        return reply.send({ success: true, plate, message: 'Payment confirmed, fee cleared in HikCentral' })
      }
    } catch (err) {
      logger.warn({ plate, err: err.message }, 'Parking fee confirm failed, opening barrier directly')
    }

    if (session.exitCamera) {
      const result = await openBarrierByCamera(session.exitCamera)
      return reply.send({ success: result.success, plate, method: result.method, message: 'Barrier opened' })
    }

    return reply.send({ success: true, plate, message: 'Marked as paid, no exit camera recorded' })
  })

  // Direct ANPR barrier gate control — tries alarmOutput → ACS door (HCCGW path also attempted if available)
  app.post('/gate/control', async (req) => {
    const { openBarrier: gateOpen, closeBarrier: gateClose } = require('./services/BarrierControl')
    const { cameraId, controlMode } = req.body
    if (!cameraId) return { success: false, error: 'cameraId required' }

    if (controlMode === 2) {
      const result = await gateClose(cameraId, 0)
      return { success: result.success, cameraId, action: 'close', method: result.method, result }
    }

    const result = await gateOpen(cameraId, 0, cameraId)
    return { success: result.success, cameraId, action: 'open', method: result.method, result }
  })

  return app
}

async function main() {
  const app = await createApp()

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
  } catch (err) {
    logger.error(err, 'Failed to start server')
    process.exit(1)
  }
}

if (require.main === module) {
  main()
}

module.exports = { createApp }
