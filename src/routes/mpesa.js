const { markAsPaid } = require('../services/ParkingLogic')
const { openBarrierByCamera } = require('../services/BarrierControl')
const { VehicleSession } = require('../models/VehicleSession')
const { logger } = require('../utils/logger')

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
      const extractValue = (key) => {
        const item = metadata.find(m => m.Name === key)
        return item?.Value
      }

      const transactionId = extractValue('MpesaReceiptNumber') || ''
      const amount = extractValue('Amount') || 0
      const plate = stkCallback.AccountReference || ''

      if (!plate || !transactionId) {
        logger.warn({ plate, transactionId }, 'M-Pesa callback missing plate or transaction ID')
        return reply.status(200).send({ ResultCode: 0, ResultDesc: 'Acknowledged' })
      }

      const marked = await markAsPaid(plate.toUpperCase(), transactionId)
      if (marked) {
        const session = await VehicleSession.findOne({ plate: plate.toUpperCase(), status: 'paid' })
        if (session?.exitCamera) {
          await openBarrierByCamera(session.exitCamera)
          session.exitTime = new Date()
          session.status = 'exited'
          await session.save()
        }
        logger.info({ plate, transactionId, amount }, 'Payment reconciled, barrier opened')
      }

      return reply.status(200).send({ ResultCode: 0, ResultDesc: 'Success' })
    } catch (err) {
      logger.error({ err: err.message }, 'M-Pesa callback error')
      return reply.status(200).send({ ResultCode: 0, ResultDesc: 'Acknowledged' })
    }
  })
}

module.exports = { mpesaRoutes }
