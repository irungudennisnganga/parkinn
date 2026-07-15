const { markAsPaid } = require('../services/ParkingLogic')
const { openBarrierByCamera } = require('../services/BarrierControl')
const { HikCentralClient } = require('../services/HikCentralClient')
const { VehicleSession } = require('../models/VehicleSession')
const { broadcastSessionUpdate } = require('../services/WebSocketManager')
const { logger } = require('../utils/logger')

const hik = new HikCentralClient()

async function mpesaRoutes(app) {
  app.post('/callback', async (request, reply) => {
    try {
      const body = request.body
      const stkCallback = body?.Body?.stkCallback
      if (!stkCallback) {
        logger.warn({ body }, 'M-Pesa callback missing stkCallback')
        return reply.status(200).send({ ResultCode: 1, ResultDesc: 'Invalid payload' })
      }

      const resultCode = stkCallback.ResultCode
      if (resultCode !== 0) {
        logger.warn({ resultCode, resultDesc: stkCallback.ResultDesc }, 'M-Pesa payment failed')
        return reply.status(200).send({ ResultCode: 0, ResultDesc: 'Acknowledged' })
      }

      const metadata = stkCallback.CallbackMetadata?.Item || []
      const val = (key) => metadata.find(m => m.Name === key)?.Value
      const transactionId = val('MpesaReceiptNumber') || ''
      const amount = val('Amount') || 0
      const plate = stkCallback.AccountReference || ''

      if (!plate || !transactionId) {
        logger.warn({ plate, transactionId }, 'Missing plate or transaction ID')
        return reply.status(200).send({ ResultCode: 0, ResultDesc: 'Acknowledged' })
      }

      const marked = await markAsPaid(plate.toUpperCase(), transactionId)
      if (!marked) {
        return reply.status(200).send({ ResultCode: 0, ResultDesc: 'Success' })
      }

      const session = await VehicleSession.findOne({ plate: plate.toUpperCase(), status: 'paid' })
        .sort({ entryTime: -1 })
      const feeToConfirm = session?.chargeAmount || 0

      // Step 1: Confirm payment on HikCentral (don't open barrier — car drives to exit camera)
      try {
        const confirm = await hik.confirmParkingFee(plate.toUpperCase(), feeToConfirm, 0)
        logger.info({ plate, fee: feeToConfirm, confirm }, 'Parking fee confirm after M-Pesa')
        if (confirm?.code === '0') {
          session.status = 'paid'
          await session.save()
          broadcastSessionUpdate(session)
          logger.info({ plate, amount, fee: feeToConfirm }, 'Payment confirmed — car exits on next ANPR detection')
          return reply.status(200).send({ ResultCode: 0, ResultDesc: 'Success' })
        }
      } catch (err) {
        logger.warn({ plate, err: err.message }, 'Parking fee confirm failed, falling back to direct barrier control')
      }

      // Step 2: Fallback — open barrier directly
      const cameraId = session?.exitCamera || session?.entryCamera
      if (session && cameraId) {
        await openBarrierByCamera(cameraId)
        session.status = 'paid'
        await session.save()
        broadcastSessionUpdate(session)
        logger.info({ plate, amount, fee: feeToConfirm }, 'Payment confirmed, barrier opened via fallback')
      } else if (session) {
        session.status = 'paid'
        await session.save()
        broadcastSessionUpdate(session)
        logger.info({ plate, amount, fee: feeToConfirm }, 'Payment confirmed — exit on next ANPR detection')
      }

      return reply.status(200).send({ ResultCode: 0, ResultDesc: 'Success' })
    } catch (err) {
      logger.error({ err: err.message }, 'M-Pesa callback error')
      return reply.status(200).send({ ResultCode: 0, ResultDesc: 'Acknowledged' })
    }
  })
}

module.exports = { mpesaRoutes }
