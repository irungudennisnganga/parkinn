const { logger } = require('../utils/logger')
const { RegisteredVehicle } = require('../models/RegisteredVehicle')
const { VehicleSession } = require('../models/VehicleSession')
const { Camera } = require('../models/Camera')
const { openBarrierByCamera, findBarrierForCamera, getCameraDirection, isResidentialCamera } = require('./BarrierControl')
const { calculateCharge } = require('./ParkingLogic')
const { HikCentralClient } = require('./HikCentralClient')
const { broadcastNewSession, broadcastSessionUpdate, broadcastRawEvent } = require('./WebSocketManager')

function extractAnprData(event) {
  if (event.plateNumber) {
    return {
      plateNumber: event.plateNumber,
      cameraId: event.cameraId || event.sourceID || '',
      cameraName: event.cameraName || '',
      eventTime: event.eventTime || event.occurTime || new Date().toISOString(),
    }
  }
  if (event.vehicleInfo?.plateNumber) return { plateNumber: event.vehicleInfo.plateNumber, cameraId: event.sourceID || event.cameraId || event.eventSource?.sourceID, cameraName: event.cameraName || '', eventTime: event.occurTime }

  const intelliInfo = event.intelliInfo
  if (intelliInfo?.vehicleInfo?.plateNumber) return { plateNumber: intelliInfo.vehicleInfo.plateNumber, cameraId: event.sourceID || event.cameraId, cameraName: event.cameraName || '', eventTime: event.occurTime }

  const dataVehicleInfo = event.data?.vehicleRelatedInfo?.vehicleInfo
  if (dataVehicleInfo?.plateNumber) return { plateNumber: dataVehicleInfo.plateNumber, cameraId: event.sourceID || event.eventSource?.sourceID, cameraName: event.cameraName || event.eventSource?.name || '', eventTime: event.occurTime }

  const combineAnpr = event.evenData?.anprInfo
  if (combineAnpr?.licensePlate) return { plateNumber: combineAnpr.licensePlate, cameraId: event.basicInfo?.resourceInfo?.sourceID, cameraName: event.basicInfo?.resourceInfo?.name || '', eventTime: event.basicInfo?.occurrenceTime }

  const combineVehicle = event.evenData?.vehicleReletedInfo?.vehicleInfo
  if (combineVehicle?.plateNumber) return { plateNumber: combineVehicle.plateNumber, cameraId: event.basicInfo?.resourceInfo?.sourceID, cameraName: event.basicInfo?.resourceInfo?.name || '', eventTime: event.basicInfo?.occurrenceTime }

  return null
}

async function resolveCameraByName(cameraName) {
  if (!cameraName) return null
  const name = cameraName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').trim()

  let cam = await Camera.findOne({ name: { $regex: name, $options: 'i' } })
  if (cam) return cam

  const stripped = cameraName.replace(/^ANPR\s+/i, '').trim()
  if (stripped && stripped !== cameraName) {
    const strippedSafe = stripped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    cam = await Camera.findOne({ name: { $regex: strippedSafe, $options: 'i' } })
    if (cam) return cam
  }

  return null
}

function inferDirectionFromName(cameraName) {
  if (!cameraName) return null
  const upper = cameraName.toUpperCase()
  if (/EXIT/i.test(upper)) return 'exit'
  if (/ENTRY|ENTRANCE/i.test(upper)) return 'entry'
  return null
}

async function processAnprEvent(event) {
  const extracted = extractAnprData(event) || event
  const plate = (extracted.plateNumber || event.plateNumber)?.toUpperCase()
  if (!plate) {
    logger.warn({ event }, 'ANPR event missing plate number')
    return { plate: '', cameraId: 'unknown', cameraName: '', direction: 'unknown', action: 'skipped', reason: 'No plate number in event data', session: null }
  }

  let cameraId = extracted.cameraId || event.cameraId
  let cameraName = extracted.cameraName || event.cameraName || ''
  let resolvedBy = 'direct'

  if (!cameraId && cameraName) {
    const cam = await resolveCameraByName(cameraName)
    if (cam) {
      cameraId = cam.cameraId
      resolvedBy = 'cameraName'
      logger.info({ plate, cameraName, cameraId }, 'Camera resolved by name')
    }
  }

  let direction = 'unknown'

  if (cameraId) {
    direction = await getCameraDirection(cameraId)
  }

  if (!cameraId || direction === 'unknown') {
    const inferred = inferDirectionFromName(cameraName)
    if (inferred) {
      direction = inferred
      logger.info({ plate, cameraName, inferredDirection: inferred }, 'Direction inferred from camera name')
    }
  }

  const eventTime = extracted.eventTime || event.eventTime || new Date().toISOString()

  if (direction === 'unknown') {
    logger.warn({ plate, cameraId, cameraName, event }, 'Could not determine camera direction — event dropped')
    return { plate, cameraId: cameraId || 'unknown', cameraName, direction: 'unknown', action: 'skipped', reason: `Cannot resolve camera direction. cameraId=${cameraId}, cameraName=${cameraName}`, session: null }
  }

  logger.info({ plate, cameraId, cameraName, direction, resolvedBy }, 'Processing ANPR event')

  if (direction === 'entry') {
    const result = await handleEntry(event, plate, cameraId, eventTime)
    return { plate, cameraId, cameraName, direction, action: result.action, reason: result.reason || '', session: result.session }
  } else if (direction === 'exit') {
    const result = await handleExit(event, plate, cameraId, eventTime)
    return { plate, cameraId, cameraName, direction, action: result.action, reason: result.reason || '', session: result.session }
  }

  return { plate, cameraId: cameraId || 'unknown', cameraName, direction, action: 'unknown', reason: `Unhandled direction: ${direction}`, session: null }
}

async function handleEntry(event, plate, cameraId, eventTime) {
  const entryDate = new Date(eventTime)

  const activeSession = await VehicleSession.findOne({ plate, status: 'active' })
  if (activeSession) {
    if (activeSession.entryCamera === cameraId) {
      logger.info({ plate, cameraId, sessionId: activeSession._id }, 'Vehicle already has active session on this camera, skipping')
      return { action: 'skip', reason: 'Active session already exists on same camera', session: null }
    }
    logger.info({ plate, cameraId, sessionId: activeSession._id, prevCamera: activeSession.entryCamera }, 'Vehicle has active session on different camera, opening barrier only')
    await openBarrierByCamera(cameraId)
    return { action: 'skip', reason: 'Active session on different camera — barrier opened but no new session', session: activeSession }
  }

  const recentDuplicate = await VehicleSession.findOne({
    plate,
    entryTime: { $gte: new Date(entryDate.getTime() - 5 * 60000), $lte: new Date(entryDate.getTime() + 5 * 60000) },
  })
  if (recentDuplicate) {
    logger.info({ plate, cameraId, existingId: recentDuplicate._id, existingStatus: recentDuplicate.status },
      'Recent session already exists for this plate, skipping duplicate entry')
    return { action: 'skip', reason: `Duplicate entry within 5min window (existing status: ${recentDuplicate.status})`, session: null }
  }

  const registered = await RegisteredVehicle.findOne({ plate, isActive: true })
  const isKnown = !!registered

  const residential = await isResidentialCamera(cameraId)

  if (residential && !isKnown) {
    logger.warn({ plate, cameraId }, 'Unknown vehicle blocked at residential entry')
    return { action: 'blocked', reason: 'Unknown vehicle at residential entry — barrier not opened', session: null }
  }

  await openBarrierByCamera(cameraId)

  const barrier = await findBarrierForCamera(cameraId)
  const barrierId = barrier?.barrierId || cameraId

  try {
    const session = await VehicleSession.create({
      plate,
      entryTime: entryDate,
      entryCamera: cameraId,
      entryBarrier: barrierId,
      isKnown,
      status: 'active',
    })
    logger.info({ plate, cameraId, sessionId: session._id, barrierId }, 'Vehicle entry session created')
    broadcastNewSession(session)
    return { action: 'entry', reason: `New ${isKnown ? 'known' : 'unknown'} session created`, session }
  } catch (err) {
    logger.error({ plate, cameraId, err: err.message }, 'Failed to create vehicle entry session')
    return { action: 'error', reason: `Session creation failed: ${err.message}`, session: null }
  }
}

async function handleExit(event, plate, cameraId, eventTime) {
  const exitDate = new Date(eventTime)

  let session = await VehicleSession.findOne({ plate, status: 'active' })

  if (!session) {
    session = await VehicleSession.findOne({ plate, status: 'paid' })
    if (session) {
      await openBarrierByCamera(cameraId)
      session.exitTime = exitDate
      session.exitCamera = cameraId
      session.status = 'exited'
      await session.save()
      logger.info({ plate }, 'Paid vehicle re-detected at exit — barrier opened automatically')
      broadcastSessionUpdate(session)
      return { action: 'exit', reason: 'Paid session found — exit completed automatically', session }
    }
    const unpaidSession = await VehicleSession.findOne({ plate, status: 'unpaid' })
    if (unpaidSession) {
      logger.warn({ plate, sessionId: unpaidSession._id, chargeAmount: unpaidSession.chargeAmount }, 'Exit event for unpaid session — vehicle exiting without pay')
    }
    logger.warn({ plate }, 'Exit event but no active or paid session found')
    return { action: 'skip', reason: `No active/paid session found for ${plate}. unpaid=${!!unpaidSession}`, session: null }
  }

  if (session.entryTime && exitDate.getTime() - session.entryTime.getTime() < 30000) {
    logger.info({ plate, entryTime: session.entryTime, exitTime: exitDate },
      'Exit event within 30 seconds of entry — likely duplicate processing, skipping')
    return { action: 'skip', reason: 'Exit within 30 seconds of entry — skipped as duplicate', session: null }
  }

  const registered = await RegisteredVehicle.findOne({ plate, isActive: true })
  const isKnown = !!registered

  if (isKnown) {
    await openBarrierByCamera(cameraId)
    session.exitTime = exitDate
    session.exitCamera = cameraId
    session.status = 'exited'
    await session.save()
    logger.info({ plate }, 'Known vehicle — barrier opened for exit')
    broadcastSessionUpdate(session)
    return { action: 'exit', reason: 'Known vehicle — free exit', session }
  }

  let charge = { amount: 0, rateDescription: '' }

  try {
    const hik = new HikCentralClient()
    const hikFee = await hik.calculateParkingFee(plate)
    if (hikFee?.code === '0' && hikFee?.data) {
      const data = hikFee.data
      const feeAmount = parseFloat(data.fee) || 0
      charge = {
        amount: feeAmount,
        rateDescription: `HikCentral: ${data.feeRuleName || 'default'} (type ${data.feeRuleType})`,
        source: 'hikcentral',
        hikData: {
          fee: data.fee,
          feeRuleType: data.feeRuleType,
          feeRuleIndexCode: data.feeRuleIndexCode,
          feeRuleName: data.feeRuleName,
          parkingDuration: data.parkingDuration,
          parkingInTime: data.parkingInTime,
        },
      }
      logger.info({ plate, hikFee: data }, 'Parking fee from HikCentral')
    }
  } catch (err) {
    logger.warn({ plate, err: err.message }, 'HikCentral calculate failed, falling back to local calculation')
  }

  if (charge.source !== 'hikcentral') {
    charge = await calculateCharge(session.entryTime, exitDate, session.entryCamera)
  }

  session.chargeAmount = charge.amount
  session.chargeRate = charge.rateDescription
  if (charge.hikData) {
    session.hikCentralFeeData = charge.hikData
  }

  if (charge.amount === 0) {
    await openBarrierByCamera(cameraId)
    session.exitTime = exitDate
    session.exitCamera = cameraId
    session.status = 'exited'
    await session.save()
    logger.info({ plate }, 'Zero charge (grace period) — barrier opened for exit')
    broadcastSessionUpdate(session)
    return { action: 'exit', reason: 'Zero charge — free exit via grace period', session }
  }

  session.status = 'unpaid'
  await session.save()
  logger.info({ plate, charge: charge.amount, source: charge.source || 'local' }, 'Unpaid vehicle — barrier stays closed, payment required')
  broadcastSessionUpdate(session)
  return { action: 'unpaid', reason: `Charge KES ${charge.amount} — payment required before exit`, session }
}

module.exports = { processAnprEvent }
