const { logger } = require('../utils/logger')
const { RegisteredVehicle } = require('../models/RegisteredVehicle')
const { VehicleSession } = require('../models/VehicleSession')
const { Camera } = require('../models/Camera')
const { openBarrierByCamera, findBarrierForCamera, getCameraDirection, isResidentialCamera } = require('./BarrierControl')
const { calculateCharge } = require('./ParkingLogic')

function extractAnprData(event) {
  if (event.plateNumber) {
    return {
      plateNumber: event.plateNumber,
      cameraId: event.cameraId || event.sourceID || '',
      cameraName: event.cameraName || '',
      eventTime: event.eventTime || event.occurTime || new Date().toISOString(),
    }
  }
  if (event.vehicleInfo?.plateNumber) return { plateNumber: event.vehicleInfo.plateNumber, cameraId: event.sourceID || event.cameraId || event.eventSource?.sourceID, eventTime: event.occurTime }

  const intelliInfo = event.intelliInfo
  if (intelliInfo?.vehicleInfo?.plateNumber) return { plateNumber: intelliInfo.vehicleInfo.plateNumber, cameraId: event.sourceID || event.cameraId, eventTime: event.occurTime }

  const dataVehicleInfo = event.data?.vehicleRelatedInfo?.vehicleInfo
  if (dataVehicleInfo?.plateNumber) return { plateNumber: dataVehicleInfo.plateNumber, cameraId: event.sourceID || event.eventSource?.sourceID, eventTime: event.occurTime }

  const combineAnpr = event.evenData?.anprInfo
  if (combineAnpr?.licensePlate) return { plateNumber: combineAnpr.licensePlate, cameraId: event.basicInfo?.resourceInfo?.sourceID, eventTime: event.basicInfo?.occurrenceTime }

  const combineVehicle = event.evenData?.vehicleReletedInfo?.vehicleInfo
  if (combineVehicle?.plateNumber) return { plateNumber: combineVehicle.plateNumber, cameraId: event.basicInfo?.resourceInfo?.sourceID, eventTime: event.basicInfo?.occurrenceTime }

  return null
}

async function processAnprEvent(event) {
  const extracted = extractAnprData(event) || event
  const plate = (extracted.plateNumber || event.plateNumber)?.toUpperCase()
  if (!plate) {
    logger.warn({ event }, 'ANPR event missing plate number')
    return null
  }

  let cameraId = extracted.cameraId || event.cameraId

  // If no cameraId, try to resolve from camera name
  if (!cameraId && (extracted.cameraName || event.cameraName)) {
    const camByName = await Camera.findOne({ name: { $regex: (extracted.cameraName || event.cameraName).trim(), $options: 'i' } })
    if (camByName) cameraId = camByName.cameraId
  }

  if (!cameraId) {
    logger.warn({ plate, event }, 'Could not determine cameraId')
    return { plate, cameraId: 'unknown', direction: 'unknown' }
  }

  const eventTime = extracted.eventTime || event.eventTime
  const direction = await getCameraDirection(cameraId)

  logger.info({ plate, cameraId, direction, eventType: event.eventType }, 'Processing ANPR event')

  if (direction === 'entry') {
    await handleEntry(event, plate, cameraId, eventTime)
  } else if (direction === 'exit') {
    await handleExit(event, plate, cameraId, eventTime)
  }

  return { plate, cameraId, direction }
}

async function handleEntry(event, plate, cameraId, eventTime) {
  const activeSession = await VehicleSession.findOne({ plate, status: 'active' })
  if (activeSession) {
    logger.info({ plate, cameraId, sessionId: activeSession._id }, 'Vehicle already has active session, skipping entry')
    return
  }

  const registered = await RegisteredVehicle.findOne({ plate, isActive: true })
  const isKnown = !!registered

  const residential = await isResidentialCamera(cameraId)

  if (residential && !isKnown) {
    logger.warn({ plate, cameraId }, 'Unknown vehicle blocked at residential entry')
    return
  }

  await openBarrierByCamera(cameraId)

  const barrier = await findBarrierForCamera(cameraId)
  const barrierId = barrier?.barrierId || cameraId

  try {
    const session = await VehicleSession.create({
      plate,
      entryTime: new Date(eventTime),
      entryCamera: cameraId,
      entryBarrier: barrierId,
      isKnown,
      status: 'active',
    })
    logger.info({ plate, cameraId, sessionId: session._id, barrierId }, 'Vehicle entry session created')
  } catch (err) {
    logger.error({ plate, cameraId, err: err.message }, 'Failed to create vehicle entry session')
  }
}

async function handleExit(event, plate, cameraId, eventTime) {
  let session = await VehicleSession.findOne({ plate, status: 'active' })

  if (!session) {
    session = await VehicleSession.findOne({ plate, status: 'paid' })
    if (session) {
      await openBarrierByCamera(cameraId)
      session.exitTime = new Date(eventTime)
      session.exitCamera = cameraId
      session.status = 'exited'
      await session.save()
      logger.info({ plate }, 'Paid vehicle re-detected at exit — barrier opened automatically')
      return
    }
    logger.warn({ plate }, 'Exit event but no active or paid session found')
    return
  }

  const registered = await RegisteredVehicle.findOne({ plate, isActive: true })
  const isKnown = !!registered

  if (isKnown) {
    await openBarrierByCamera(cameraId)
    session.exitTime = new Date(eventTime)
    session.exitCamera = cameraId
    session.status = 'exited'
    await session.save()
    logger.info({ plate }, 'Known vehicle — barrier opened for exit')
    return
  }

  const charge = await calculateCharge(
    session.entryTime,
    new Date(eventTime),
    session.entryCamera
  )

  session.chargeAmount = charge.amount
  session.chargeRate = charge.rateDescription

  if (charge.amount === 0) {
    await openBarrierByCamera(cameraId)
    session.exitTime = new Date(eventTime)
    session.exitCamera = cameraId
    session.status = 'exited'
    await session.save()
    logger.info({ plate }, 'Zero charge (grace period) — barrier opened for exit')
    return
  }

  session.status = 'unpaid'
  await session.save()
  logger.info({ plate, charge: charge.amount }, 'Unpaid vehicle — barrier stays closed, payment required')
}

module.exports = { processAnprEvent }
