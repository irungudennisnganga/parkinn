const { logger } = require('../utils/logger')
const { HikCentralClient } = require('./HikCentralClient')
const { Camera } = require('../models/Camera')
const { Barrier } = require('../models/Barrier')
const { Area } = require('../models/Area')

const hik = new HikCentralClient()

async function openBarrier(doorId, direction = 0, cameraId = null) {
  // 1) Try ACS door control (primary for physical barriers/gates)
  try {
    const dRes = await hik.controlDoor(doorId, 1, direction)
    const resultCode = dRes?.data?.controlResultCode
    const success = dRes?.code === '0' && (resultCode === undefined || resultCode === null || resultCode === 0)
    logger.info({ doorId, method: 'acsDoor', controlType: 1, direction, response: dRes, resultCode, success }, 'Barrier open')
    if (success) return { success: true, method: 'acsDoor', resultCode }
    logger.warn({ doorId, resultCode }, 'ACS door control failed, falling back')
  } catch (_) {}

  // 2) Try ANPR barrier gate control (camera-based, only if HCCGW available)
  if (cameraId) {
    try {
      const gRes = await hik.barrierGateControl(cameraId, 1)
      logger.info({ doorId, cameraId, method: 'anprGate', controlMode: 1, response: gRes }, 'Barrier open')
      if (gRes?.code === '0' || gRes?.errorCode === '0') return { success: true, method: 'anprGate' }
    } catch (_) {}
  }

  // 3) Fallback: alarm output control
  try {
    const aRes = await hik.controlAlarmOutput(doorId, 1)
    logger.info({ doorId, method: 'alarmOutput', action: 1, response: aRes }, 'Barrier open')
    if (aRes?.code === '0') return { success: true, method: 'alarmOutput' }
  } catch (_) {}

  logger.error({ doorId }, 'All barrier open methods failed')
  return { success: false }
}

async function closeBarrier(doorId, direction = 0) {
  try {
    const dRes = await hik.controlDoor(doorId, 2, direction)
    const resultCode = dRes?.data?.controlResultCode
    const success = dRes?.code === '0' && (resultCode === undefined || resultCode === null || resultCode === 0)
    logger.info({ doorId, method: 'acsDoor', controlType: 2, direction, response: dRes, resultCode, success }, 'Barrier close')
    if (success) return { success: true, method: 'acsDoor', resultCode }
    logger.warn({ doorId, resultCode }, 'ACS door close failed, falling back')
  } catch (_) {}

  try {
    const aRes = await hik.controlAlarmOutput(doorId, 0)
    logger.info({ doorId, method: 'alarmOutput', action: 0, response: aRes }, 'Barrier close')
    if (aRes?.code === '0') return { success: true, method: 'alarmOutput' }
  } catch (_) {}

  logger.error({ doorId }, 'All barrier close methods failed')
  return { success: false }
}

async function openBarrierByCamera(cameraId) {
  const barrier = await findBarrierForCamera(cameraId)
  const doorId = barrier?.barrierId || cameraId
  const dir = barrier?.direction === 'exit' ? 1 : 0
  return openBarrier(doorId, dir, cameraId)
}

async function closeBarrierByCamera(cameraId) {
  const barrier = await findBarrierForCamera(cameraId)
  if (!barrier) return { success: false }
  const dir = barrier?.direction === 'exit' ? 1 : 0
  return closeBarrier(barrier.barrierId, dir)
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
  openBarrier, closeBarrier,
  openBarrierByCamera, closeBarrierByCamera,
  findBarrierForCamera, resolveCameraByIndexCode,
  getCameraDirection, isResidentialCamera,
}
