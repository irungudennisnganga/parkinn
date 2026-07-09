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

const hik = new HikCentralClient()

async function paymentRoutes(app) {
  app.get('/fee/:plate', async (request, reply) => {
    const plate = request.params.plate.toUpperCase()
    let session = await VehicleSession.findOne({ plate, status: { $in: ['active', 'unpaid'] } })
      .sort({ entryTime: -1 })

    if (!session) {
      const now = new Date()
      const startTime = isoLocal(new Date(now.getTime() - 24 * 3600000))
      const endTime = isoLocal(now)
      const lots = await ParkingLot.find().lean()
      for (const lot of lots) {
        try {
          const pr = await hik.getPassagewayRecords(lot.parkingLotIndexCode || lot.parkingLotId, startTime, endTime)
          const records = pr?.data?.list || []
          for (const rec of records) {
            const car = rec.carInfo || {}
            const recPlate = (car.plateLicense || '').toUpperCase().replace(/\s+/g, '').trim()
            if (recPlate !== plate) continue
            const lane = rec.laneInfo || {}
            if (lane.direction !== 1) continue
            const hikEntry = new Date(car.EnterTime || now.toISOString())
            const { amount, rateDescription } = await calculateCharge(hikEntry, now, lane.laneIndexCode || '')
            return reply.send({
              plate,
              entryTime: hikEntry,
              source: 'hikcentral',
              durationHours: Math.round(((now.getTime() - hikEntry.getTime()) / 3600000) * 100) / 100,
              chargeAmount: amount,
              rateDescription,
              status: 'unpaid',
              paymentRef: '',
            })
          }
        } catch (_) {}
      }
      return reply.status(404).send({ error: 'No active session found for this plate' })
    }

    const { amount, rateDescription } = await calculateCharge(session.entryTime, new Date(), session.entryCamera)

    return reply.send({
      plate,
      entryTime: session.entryTime,
      durationHours: Math.round(((Date.now() - session.entryTime.getTime()) / 3600000) * 100) / 100,
      chargeAmount: amount,
      rateDescription,
      status: session.status,
      paymentRef: session.paymentRef || '',
    })
  })

  app.post('/stkpush', async (request, reply) => {
    const { plate, phoneNumber } = request.body

    if (!plate) {
      return reply.status(400).send({ error: 'Plate number required' })
    }

    const session = await VehicleSession.findOne({ plate: plate.toUpperCase(), status: { $in: ['active', 'unpaid'] } })
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

    const session = await VehicleSession.findOne({ plate, status: { $in: ['active', 'unpaid'] } })
    if (!session) {
      return reply.status(404).send({ error: 'No active/unpaid session found for this plate' })
    }

    session.status = 'paid'
    session.paymentRef = ref
    let fee = session.chargeAmount || 0

    if (fee === 0) {
      const { amount } = await calculateCharge(session.entryTime, new Date(), session.entryCamera)
      fee = amount
      session.chargeAmount = amount
    }

    await session.save()
    broadcastSessionUpdate(session)

    try {
      const confirm = await hik.confirmParkingFee(plate, fee, 1)
      if (confirm?.code === '0') {
        session.status = 'exited'
        session.exitTime = new Date()
        await session.save()
        broadcastSessionUpdate(session)
        return reply.send({ success: true, plate, fee, message: 'Payment confirmed, barrier opened via HikCentral' })
      }
      logger.warn({ plate, code: confirm?.code }, 'HikCentral confirm returned non-zero code')
    } catch (err) {
      logger.warn({ plate, err: err.message }, 'HikCentral confirm failed, trying barrier fallback')
    }

    const cameraId = session.exitCamera || session.entryCamera
    if (cameraId) {
      const result = await openBarrierByCamera(cameraId)
      session.status = 'exited'
      session.exitTime = new Date()
      session.exitCamera = session.exitCamera || cameraId
      await session.save()
      broadcastSessionUpdate(session)
      return reply.send({ success: result.success, plate, method: result.method, message: 'Barrier opened via camera fallback' })
    }

    return reply.send({ success: true, plate, message: 'Marked as paid — exit on next ANPR detection' })
  })
}

module.exports = { paymentRoutes }
