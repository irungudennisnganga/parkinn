const { logger } = require('../utils/logger')
const { HikCentralClient } = require('./HikCentralClient')
const { Camera } = require('../models/Camera')
const { Barrier } = require('../models/Barrier')
const { Area } = require('../models/Area')
const config = require('../config')

const hik = new HikCentralClient()

async function openBarrierByCamera(cameraId) {
  try {
    await hik.controlBarrier(cameraId, 1)
    logger.info({ cameraId }, 'Barrier opened')
    return true
  } catch (err) {
    logger.error({ err: err.message, cameraId }, 'Failed to open barrier')
    return false
  }
}

async function closeBarrier(cameraId) {
  try {
    await hik.controlBarrier(cameraId, 2)
    return true
  } catch (err) {
    logger.error({ err: err.message, cameraId }, 'Failed to close barrier')
    return false
  }
}

async function findBarrierForCamera(cameraId) {
  return Barrier.findOne({ cameraId })
}

async function resolveCameraByIndexCode(indexCode) {
  return Camera.findOne({ indexCode })
}

async function getCameraDirection(cameraId) {
  const cam = await Camera.findOne({ cameraId })
  if (!cam) return 'entry'
  if (cam.direction === 'both') return 'entry'
  return cam.direction || 'entry'
}

async function isResidentialCamera(cameraId) {
  const cam = await Camera.findOne({ cameraId })
  if (!cam) return false
  const area = await Area.findOne({ areaId: cam.areaId })
  return area?.areaType === 'residential'
}

module.exports = {
  openBarrierByCamera,
  closeBarrier,
  findBarrierForCamera,
  resolveCameraByIndexCode,
  getCameraDirection,
  isResidentialCamera,
}
