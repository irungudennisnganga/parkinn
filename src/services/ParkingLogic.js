const { logger } = require('../utils/logger')
const { VehicleSession } = require('../models/VehicleSession')
const { ChargeRate } = require('../models/ChargeRate')
const { Camera } = require('../models/Camera')
const config = require('../config')
const { hoursBetween, minutesBetween } = require('../utils/dateUtils')

async function calculateCharge(entryTime, exitTime, cameraId) {
  const durationMinutes = minutesBetween(entryTime, exitTime)
  const durationHours = Math.ceil(hoursBetween(entryTime, exitTime))

  const camera = await Camera.findOne({ cameraId })
  const dbRate = await ChargeRate.findOne({ floorId: camera?.areaId })
  const rate = dbRate ?? {
    gracePeriod: config.payment.defaultGraceMinutes,
    ratePerHr: config.payment.defaultRatePerHour,
    maxDaily: 1000,
  }

  if (durationMinutes <= rate.gracePeriod) {
    return { amount: 0, rateDescription: 'Within grace period' }
  }

  const amount = Math.min(durationHours * rate.ratePerHr, rate.maxDaily)
  return {
    amount,
    rateDescription: `${durationHours}h × KES ${rate.ratePerHr}/hr (max ${rate.maxDaily})`,
  }
}

async function markAsPaid(plate, paymentRef) {
  const session = await VehicleSession.findOne({ plate, status: 'unpaid' })
  if (!session) {
    logger.warn({ plate }, 'No unpaid session found for payment')
    return false
  }

  session.paymentRef = paymentRef
  session.status = 'paid'
  await session.save()
  logger.info({ plate, paymentRef }, 'Vehicle marked as paid')
  return true
}

module.exports = { calculateCharge, markAsPaid }
