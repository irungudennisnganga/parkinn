const { logger } = require('../utils/logger')
const { RegisteredVehicle } = require('../models/RegisteredVehicle')
const { VehicleSession } = require('../models/VehicleSession')
const { Camera } = require('../models/Camera')
const { openBarrierByCamera, findBarrierForCamera, getCameraDirection, isResidentialCamera } = require('./BarrierControl')
const { calculateCharge } = require('./ParkingLogic')
const { HikCentralClient } = require('./HikCentralClient')
const { broadcastNewSession, broadcastSessionUpdate } = require('./WebSocketManager')

function normalizePlate(plate) {
  return plate.toUpperCase().replace(/\s+/g, '').trim()
}

function extractAnprData(event) {
  if (event.plateNumber) {
    return {
      plateNumber: event.plateNumber,
      cameraId: event.cameraId || event.sourceID || '',
      cameraName: event.cameraName || '',
      eventTime: event.eventTime || event.occurTime || new Date().toISOString(),
    }
  }
  if (event.vehicleInfo && event.vehicleInfo.plateNumber) {
    return { plateNumber: event.vehicleInfo.plateNumber, cameraId: event.sourceID || event.cameraId || event.eventSource?.sourceID, cameraName: event.cameraName || '', eventTime: event.occurTime }
  }

  const intelliInfo = event.intelliInfo
  if (intelliInfo && intelliInfo.vehicleInfo && intelliInfo.vehicleInfo.plateNumber) {
    return { plateNumber: intelliInfo.vehicleInfo.plateNumber, cameraId: event.sourceID || event.cameraId, cameraName: event.cameraName || '', eventTime: event.occurTime }
  }

  const dataVehicleInfo = event.data && event.data.vehicleRelatedInfo && event.data.vehicleRelatedInfo.vehicleInfo
  if (dataVehicleInfo && dataVehicleInfo.plateNumber) {
    return { plateNumber: dataVehicleInfo.plateNumber, cameraId: event.sourceID || event.eventSource?.sourceID, cameraName: event.cameraName || event.eventSource?.name || '', eventTime: event.occurTime }
  }

  const combineAnpr = event.evenData && event.evenData.anprInfo
  if (combineAnpr && combineAnpr.licensePlate) {
    return { plateNumber: combineAnpr.licensePlate, cameraId: event.basicInfo?.resourceInfo?.sourceID, cameraName: event.basicInfo?.resourceInfo?.name || '', eventTime: event.basicInfo?.occurrenceTime }
  }

  const combineVehicle = event.evenData && event.evenData.vehicleReletedInfo && event.evenData.vehicleReletedInfo.vehicleInfo
  if (combineVehicle && combineVehicle.plateNumber) {
    return { plateNumber: combineVehicle.plateNumber, cameraId: event.basicInfo?.resourceInfo?.sourceID, cameraName: event.basicInfo?.resourceInfo?.name || '', eventTime: event.basicInfo?.occurrenceTime }
  }

  return null
}

async function resolveCamera(cameraId, cameraName) {
  if (cameraId) {
    let cam = await Camera.findOne({ cameraId })
    if (cam) return cam

    cam = await Camera.findOne({ indexCode: cameraId })
    if (cam) return cam
  }

  if (cameraName) {
    const safeName = cameraName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').trim()
    let cam = await Camera.findOne({ name: { $regex: safeName, $options: 'i' } })
    if (cam) return cam

    const stripped = cameraName.replace(/^ANPR\s+/i, '').trim()
    if (stripped && stripped !== cameraName) {
      const strippedSafe = stripped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      cam = await Camera.findOne({ name: { $regex: strippedSafe, $options: 'i' } })
      if (cam) return cam
    }
  }

  return null
}

function inferDirectionFromName(cameraName) {
  if (!cameraName) return null
  const upper = cameraName.toUpperCase()
  if (upper.includes('EXIT')) return 'exit'
  if (upper.includes('ENTRY') || upper.includes('ENTRANCE')) return 'entry'
  return null
}

async function resolveDirection(cameraId, cameraName) {
  if (cameraId) {
    const direction = await getCameraDirection(cameraId)
    if (direction && direction !== 'unknown') return direction
  }

  if (cameraName) {
    const inferred = inferDirectionFromName(cameraName)
    if (inferred) return inferred
  }

  return null
}

async function processAnprEvent(event) {
  const extracted = extractAnprData(event) || event
  const plate = normalizePlate(extracted.plateNumber || event.plateNumber || '')
  if (!plate) {
    logger.warn({ event }, 'ANPR event missing plate number')
    return { plate: '', cameraId: 'unknown', cameraName: '', direction: 'unknown', action: 'skipped', reason: 'No plate number in event data', session: null }
  }

  let cameraId = extracted.cameraId || event.cameraId || ''
  let cameraName = extracted.cameraName || event.cameraName || ''
  const eventTime = extracted.eventTime || event.eventTime || new Date().toISOString()

  const cam = await resolveCamera(cameraId, cameraName)
  if (cam) {
    cameraId = cam.cameraId || cameraId
    cameraName = cam.name || cameraName
    logger.info({ plate, cameraId, cameraName, resolvedCamera: true }, 'Camera resolved from database')
  } else {
    logger.warn({ plate, originalCameraId: cameraId, cameraName }, 'Camera not found in database, trying to infer direction')
  }

  let direction = await resolveDirection(cameraId, cameraName)

  if (!direction) {
    logger.warn({ plate, cameraId, cameraName, event }, 'Cannot determine camera direction — treating as unknown, event skipped')
    return { plate, cameraId: cameraId || 'unknown', cameraName, direction: 'unknown', action: 'skipped', reason: `Cannot resolve camera direction for cameraId=${cameraId}, cameraName=${cameraName}. Camera may not be synced. Run /sync/resources.`, session: null }
  }

  logger.info({ plate, cameraId, cameraName, direction }, 'Processing ANPR event')

  if (direction === 'entry') {
    const result = await handleEntry(event, plate, cameraId, eventTime)
    return { plate, cameraId, cameraName, direction, action: result.action, reason: result.reason || '', session: result.session }
  }

  if (direction === 'exit') {
    const result = await handleExit(event, plate, cameraId, eventTime)
    return { plate, cameraId, cameraName, direction, action: result.action, reason: result.reason || '', session: result.session }
  }

  return { plate, cameraId: cameraId || 'unknown', cameraName, direction, action: 'unknown', reason: `Unhandled direction: ${direction}`, session: null }
}

async function handleEntry(event, plate, cameraId, eventTime) {
  const entryDate = new Date(eventTime)

  const activeSession = await VehicleSession.findOne({ plate, status: 'active' })
  if (activeSession) {
    const hoursSinceEntry = (entryDate.getTime() - activeSession.entryTime.getTime()) / 3600000

    if (hoursSinceEntry > 2) {
      logger.info({ plate, sessionId: activeSession._id, hoursSinceEntry: Math.round(hoursSinceEntry), entryTime: activeSession.entryTime },
        'Stale active session — auto-closing as exited and creating new session')
      activeSession.status = 'exited'
      activeSession.exitTime = new Date(activeSession.entryTime.getTime() + 3600000)
      activeSession.exitCamera = activeSession.entryCamera
      await activeSession.save()
      broadcastSessionUpdate(activeSession)
    } else {
      if (activeSession.entryCamera === cameraId) {
        logger.info({ plate, cameraId, sessionId: activeSession._id }, 'Vehicle already has active session on this camera, skipping duplicate')
        return { action: 'skip', reason: 'Active session already exists on same camera', session: null }
      }
      logger.info({ plate, cameraId, sessionId: activeSession._id, prevCamera: activeSession.entryCamera }, 'Vehicle has active session on different camera, opening barrier only')
      try { await openBarrierByCamera(cameraId) } catch (_) {}
      return { action: 'skip', reason: 'Active session on different camera — barrier opened but no new session', session: activeSession }
    }
  }

  const registered = await RegisteredVehicle.findOne({ plate, isActive: true })
  const isKnown = !!registered

  const residential = await isResidentialCamera(cameraId)

  if (residential && !isKnown) {
    logger.warn({ plate, cameraId }, 'Unknown vehicle blocked at residential entry')
    return { action: 'blocked', reason: 'Unknown vehicle at residential entry — barrier not opened', session: null }
  }

  try { await openBarrierByCamera(cameraId) } catch (_) {}

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
    if (err.code === 11000) {
      logger.warn({ plate, cameraId }, 'Duplicate active session prevented by database constraint')
      const existing = await VehicleSession.findOne({ plate, status: 'active' })
      return { action: 'skip', reason: 'Active session already exists (DB constraint)', session: existing }
    }
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
      try { await openBarrierByCamera(cameraId) } catch (_) {}
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
    try { await openBarrierByCamera(cameraId) } catch (_) {}
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
    if (hikFee && hikFee.code === '0' && hikFee.data) {
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
    try { await openBarrierByCamera(cameraId) } catch (_) {}
    session.exitTime = exitDate
    session.exitCamera = cameraId
    session.status = 'exited'
    await session.save()
    logger.info({ plate }, 'Zero charge (grace period) — barrier opened for exit')
    broadcastSessionUpdate(session)
    return { action: 'exit', reason: 'Zero charge — free exit via grace period', session }
  }

  session.status = 'unpaid'
  session.exitTime = exitDate
  session.exitCamera = cameraId
  await session.save()
  logger.info({ plate, charge: charge.amount, source: charge.source || 'local' }, 'Unpaid vehicle — barrier stays closed, payment required')
  broadcastSessionUpdate(session)
  return { action: 'unpaid', reason: `Charge KES ${charge.amount} — payment required before exit`, session }
}

module.exports = { processAnprEvent }
