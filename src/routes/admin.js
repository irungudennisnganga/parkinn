const { syncResources } = require('../services/ResourceSync')
const { Area } = require('../models/Area')
const { Camera } = require('../models/Camera')
const { Barrier } = require('../models/Barrier')
const { logger } = require('../utils/logger')

async function adminRoutes(app) {
  app.post('/resources', async () => {
    const result = await syncResources()
    logger.info(result, 'Manual resource sync triggered')
    return { success: true, ...result }
  })

  app.get('/status', async () => {
    const [areas, cameras, barriers] = await Promise.all([
      Area.countDocuments(),
      Camera.countDocuments(),
      Barrier.countDocuments(),
    ])
    return { areas, cameras, barriers }
  })
}

module.exports = { adminRoutes }
