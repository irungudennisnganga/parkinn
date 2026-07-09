const { VehicleSession } = require('../models/VehicleSession')
const { RegisteredVehicle } = require('../models/RegisteredVehicle')
const { Camera } = require('../models/Camera')
const { ParkingLot } = require('../models/ParkingLot')
const { initiateStkPush } = require('../services/PaymentService')
const { calculateCharge } = require('../services/ParkingLogic')
const { openBarrierByCamera, findBarrierForCamera } = require('../services/BarrierControl')
const { HikCentralClient } = require('../services/HikCentralClient')
const { broadcastSessionUpdate } = require('../services/WebSocketManager')
const { logger } = require('../utils/logger')
const { isoLocal } = require('../utils/dateUtils')
const { Area } = require('../models/Area')

const hik = new HikCentralClient()

async function paymentRoutes(app) {
  app.get('/fee/:plate', async (request, reply) => {
    const plate = request.params.plate.toUpperCase()

    let session = await VehicleSession.findOne({ plate, status: 'active' })
      .sort({ entryTime: -1 })
    if (!session) {
      session = await VehicleSession.findOne({ plate, status: 'unpaid' })
        .sort({ entryTime: -1 })
    }
    if (!session) {
      session = await VehicleSession.findOne({ plate, status: 'paid' })
        .sort({ entryTime: -1 })
    }

    if (!session) {
      const now = new Date()
      const hikEntry = await findLatestHikEntryForPlate(plate)
      if (hikEntry) {
        const { amount, rateDescription } = await calculateCharge(hikEntry.enterTime, now, hikEntry.cameraId || '')
        return reply.send({
          plate,
          entryTime: hikEntry.enterTime,
          calculatedAt: now,
          source: 'hikcentral',
          durationHours: Math.round(((now.getTime() - new Date(hikEntry.enterTime).getTime()) / 3600000) * 100) / 100,
          chargeAmount: amount,
          rateDescription,
          status: 'unpaid',
          paymentRef: '',
        })
      }
      return reply.status(404).send({ error: 'No active session found for this plate' })
    }

    const now = new Date()
    let currentFloor = null
    if (session.entryCamera) {
      const cam = await Camera.findOne({
        $or: [{ cameraId: session.entryCamera }, { indexCode: session.entryCamera }],
      })
      if (cam && cam.areaId) {
        const area = await Area.findOne({ areaId: cam.areaId })
        if (area) {
          currentFloor = { name: area.name, type: area.areaType, cameraName: cam.name || session.entryCamera }
        }
      }
    }

    if (session.status === 'paid') {
      return reply.send({
        plate,
        entryTime: session.entryTime,
        exitTime: session.exitTime,
        calculatedAt: now,
        durationHours: session.exitTime
          ? Math.round(((new Date(session.exitTime).getTime() - session.entryTime.getTime()) / 3600000) * 100) / 100
          : Math.round(((now.getTime() - session.entryTime.getTime()) / 3600000) * 100) / 100,
        chargeAmount: session.chargeAmount,
        rateDescription: session.chargeRate || 'Manual payment',
        status: 'paid',
        paymentRef: session.paymentRef || '',
        currentFloor,
      })
    }

    const { amount, rateDescription } = await calculateCharge(session.entryTime, now, session.entryCamera)

    return reply.send({
      plate,
      entryTime: session.entryTime,
      calculatedAt: now,
      durationHours: Math.round(((now.getTime() - session.entryTime.getTime()) / 3600000) * 100) / 100,
      chargeAmount: amount,
      rateDescription,
      status: session.status,
      paymentRef: session.paymentRef || '',
      currentFloor,
    })
  })

  app.post('/stkpush', async (request, reply) => {
    const { plate, phoneNumber } = request.body

    if (!plate) {
      return reply.status(400).send({ error: 'Plate number required' })
    }

    let session = await VehicleSession.findOne({ plate: plate.toUpperCase(), status: 'active' })
      .sort({ entryTime: -1 })
    if (!session) {
      session = await VehicleSession.findOne({ plate: plate.toUpperCase(), status: 'unpaid' })
        .sort({ entryTime: -1 })
    }
    if (!session) {
      const hikEntry = await findLatestHikEntryForPlate(plate.toUpperCase())
      if (hikEntry) {
        session = await VehicleSession.create({
          plate: plate.toUpperCase(),
          entryTime: hikEntry.enterTime,
          entryCamera: hikEntry.cameraId || 'hikcentral',
          entryBarrier: hikEntry.cameraId || 'hikcentral',
          isKnown: false,
          status: 'unpaid',
          chargeAmount: 0,
          floorLog: [{
            cameraId: hikEntry.cameraId || 'hikcentral',
            cameraName: 'HikCentral',
            floor: 'Unknown',
            floorType: 'unknown',
            timestamp: hikEntry.enterTime,
            action: 'entry',
          }],
        })
        logger.info({ plate, sessionId: session._id }, 'Created session from HikCentral fallback for STK push')
      }
    }

    if (!session) {
      return reply.status(404).send({ error: 'No active session found for this plate' })
    }

    const { amount, rateDescription } = await calculateCharge(session.entryTime, new Date(), session.entryCamera)
    const hours = (Date.now() - session.entryTime.getTime()) / 3600000

    session.status = 'unpaid'
    session.chargeAmount = amount
    await session.save()

    broadcastSessionUpdate(session)

    let phone = phoneNumber
    if (!phone) {
      const reg = await RegisteredVehicle.findOne({ plate: plate.toUpperCase() })
      phone = reg?.phoneNumber || ''
    }

    if (!phone) {
      return reply.status(400).send({
        success: false,
        error: 'Phone number required for STK push. Provide phoneNumber.',
        plate,
        amount,
        rateDescription,
        durationHours: Math.round(hours * 100) / 100,
      })
    }

    const formattedPhone = phone.startsWith('254') ? phone :
      phone.startsWith('0') ? `254${phone.slice(1)}` :
      phone.startsWith('+254') ? phone.slice(1) : `254${phone}`

    logger.info({ plate: plate.toUpperCase(), amount, phone: formattedPhone }, 'Initiating STK push')

    const result = await initiateStkPush(formattedPhone, amount, plate.toUpperCase())

    if (result && result.ResponseCode === '0') {
      return reply.send({
        success: true,
        message: 'STK push sent. Check your phone to complete payment.',
        plate: plate.toUpperCase(),
        amount,
        rateDescription,
        durationHours: Math.round(hours * 100) / 100,
        merchantRequestId: result.MerchantRequestID,
        checkoutRequestId: result.CheckoutRequestID,
      })
    }

    return reply.status(500).send({
      success: false,
      error: result?.ResponseDescription || result?.errorMessage || 'Failed to initiate payment',
      plate: plate.toUpperCase(),
      amount,
    })
  })

  app.post('/confirm', async (request, reply) => {
    const plate = (request.body?.plate || '').toUpperCase()
    const ref = request.body?.ref || 'manual'

    if (!plate) {
      return reply.status(400).send({ error: 'plate required' })
    }

    const session = await VehicleSession.findOne({
      plate,
      status: { $in: ['active', 'unpaid', 'paid'] },
    }).sort({ entryTime: -1 })

    if (!session) {
      return reply.status(404).send({ error: 'No active/unpaid/paid session found for this plate' })
    }

    if (session.status !== 'paid') {
      session.status = 'paid'
      session.paymentRef = ref
      await session.save()
    } else {
      session.paymentRef = ref
      await session.save()
    }

    broadcastSessionUpdate(session)

    const fee = session.chargeAmount || 0
    const cameraId = session.exitCamera || session.entryCamera

    if (cameraId) {
      const result = await openBarrierByCamera(cameraId)
      try {
        const confirm = await hik.confirmParkingFee(plate, fee, 1)
        logger.info({ plate, fee, hikResponse: confirm?.code }, 'HikCentral confirmParkingFee result')
      } catch (err) {
        logger.warn({ plate, err: err.message }, 'HikCentral confirmParkingFee failed')
      }
      session.status = 'exited'
      session.exitTime = new Date()
      session.exitCamera = cameraId
      await session.save()
      broadcastSessionUpdate(session)
      return reply.send({ success: result.success, plate, method: result.method, message: 'Payment confirmed, barrier opened' })
    }

    return reply.send({ success: true, plate, message: 'Marked as paid. Barrier will open on next ANPR detection.' })
  })
}

async function findLatestHikEntryForPlate(plate) {
  try {
    const now = new Date()
    const startTime = isoLocal(new Date(now.getTime() - 7 * 24 * 3600000))
    const endTime = isoLocal(now)

    const lots = await ParkingLot.find().lean()
    for (const lot of lots) {
      const lotCode = lot.parkingLotIndexCode || lot.parkingLotId
      try {
        const pr = await hik.getPassagewayRecords(lotCode, startTime, endTime)
        const records = pr?.data?.list || []
        for (const rec of records) {
          const car = rec.carInfo || {}
          const recPlate = (car.plateLicense || '').toUpperCase().replace(/\s+/g, '').trim()
          if (recPlate !== plate) continue
          const lane = rec.laneInfo || {}
          if (lane.direction !== 1) continue
          return {
            enterTime: new Date(car.EnterTime || now.toISOString()),
            cameraId: lane.laneIndexCode || '',
          }
        }
      } catch (e) {
        logger.warn({ lotCode, err: e.message }, 'HikCentral fallback: failed to fetch passageway records')
      }
    }
  } catch (e) {
    logger.warn({ plate, err: e.message }, 'HikCentral fallback failed')
  }
  return null
}

module.exports = { paymentRoutes }
