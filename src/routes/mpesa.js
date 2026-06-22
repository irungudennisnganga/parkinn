const { markAsPaid } = require('../services/ParkingLogic')
const { openBarrierByCamera } = require('../services/BarrierControl')
const { HikCentralClient } = require('../services/HikCentralClient')
const { VehicleSession } = require('../models/VehicleSession')
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

      // Step 1: Try parkingfee/confirm (HikCentral payment barrier open)
      try {
        const confirm = await hik.confirmParkingFee(plate.toUpperCase())
        logger.info({ plate, confirm }, 'Parking fee confirm after M-Pesa')
        if (confirm?.code === '0') {
          await VehicleSession.updateOne(
            { plate: plate.toUpperCase(), status: 'paid' },
            { exitTime: new Date(), status: 'exited' }
          )
          logger.info({ plate, amount }, 'Payment reconciled, barrier opened via confirm')
          return reply.status(200).send({ ResultCode: 0, ResultDesc: 'Success' })
        }
      } catch (err) {
        logger.warn({ plate, err: err.message }, 'Parking fee confirm failed, trying alarm output')
      }

      // Step 2: Fallback to camera-based barrier open
      const session = await VehicleSession.findOne({ plate: plate.toUpperCase(), status: 'paid' })
      if (session?.exitCamera) {
        await openBarrierByCamera(session.exitCamera)
        session.exitTime = new Date()
        session.status = 'exited'
        await session.save()
      }
      logger.info({ plate, amount }, 'Payment reconciled, barrier opened via alarm')

      return reply.status(200).send({ ResultCode: 0, ResultDesc: 'Success' })
    } catch (err) {
      logger.error({ err: err.message }, 'M-Pesa callback error')
      return reply.status(200).send({ ResultCode: 0, ResultDesc: 'Acknowledged' })
    }
  })
}

module.exports = { mpesaRoutes }
