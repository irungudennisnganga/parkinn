const { logger } = require('../utils/logger')
const { HikCentralClient } = require('./HikCentralClient')
const { Area } = require('../models/Area')
const { Camera } = require('../models/Camera')
const { Barrier } = require('../models/Barrier')
const config = require('../config')

const hik = new HikCentralClient()

async function setupWebhook() {
  const callbackUrl = config.hikcentral.callbackUrl
  if (!callbackUrl) {
    logger.warn('HIKCENTRAL_CALLBACK_URL not set — skipping webhook registration')
    return false
  }
  try {
    await hik.configureWebhook(callbackUrl, config.hikcentral.secretKey)
    logger.info({ callbackUrl }, 'HikCentral webhook configured')

    await hik.subscribeCombineEvents([])
    logger.info('Subscribed to all HikCentral combined events')
    return true
  } catch (err) {
    logger.warn({ err: err.message }, 'HikCentral webhook setup failed (may already be configured)')
    return false
  }
}

async function syncResources() {
  logger.info('Starting HikCentral resource sync...')

  const areasRes = await hik.getAreas()
  const areas = areasRes.data?.list || []
  let areaCount = 0
  for (const a of areas) {
    const areaType = config.floors.residential.some(f => a.name?.includes(`Floor ${f}`))
      ? 'residential'
      : 'commercial'
    await Area.updateOne(
      { areaId: a.areaId },
      { areaId: a.areaId, name: a.name, parentId: a.parentId || '', areaType },
      { upsert: true }
    )
    areaCount++
  }

  let cameraCount = 0
  let barrierCount = 0

  for (const area of areas) {
    const camerasRes = await hik.getCameras(area.areaId)
    const cameras = camerasRes.data?.list || []
    for (const c of cameras) {
      await Camera.updateOne(
        { cameraId: c.cameraId || c.resourceId },
        {
          cameraId: c.cameraId || c.resourceId,
          name: c.name,
          areaId: area.areaId,
          cameraType: c.cameraType || 'ANPR',
          indexCode: c.indexCode,
        },
        { upsert: true }
      )
      cameraCount++
    }

    const doorsRes = await hik.getDoors(area.areaId)
    const doors = doorsRes.data?.list || []
    for (const d of doors) {
      const camerasInArea = await Camera.find({ areaId: area.areaId })
      const linkedCameraId = camerasInArea.length > 0 ? camerasInArea[0].cameraId : ''
      await Barrier.updateOne(
        { barrierId: d.doorId || d.resourceId },
        {
          barrierId: d.doorId || d.resourceId,
          name: d.name,
          areaId: area.areaId,
          cameraId: linkedCameraId,
        },
        { upsert: true }
      )
      barrierCount++
    }
  }

  logger.info({ areaCount, cameraCount, barrierCount }, 'HikCentral resource sync complete')
  return { areas: areaCount, cameras: cameraCount, barriers: barrierCount }
}

module.exports = { setupWebhook, syncResources }
