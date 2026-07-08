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

  await app.register(cors, { origin: true })
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
  } catch (err) {
    logger.error(err, 'Failed to start server')
    process.exit(1)
  }
}

if (require.main === module) {
  main()
}

module.exports = { createApp }
