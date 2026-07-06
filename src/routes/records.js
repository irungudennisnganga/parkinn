const { VehicleRecord } = require('../models/VehicleRecord')
const { VehicleSession } = require('../models/VehicleSession')
const { RegisteredVehicle } = require('../models/RegisteredVehicle')
const { logger } = require('../utils/logger')

async function recordRoutes(app) {
  app.get('/', async (request) => {
    const page = parseInt(request.query.page) || 1
    const limit = Math.min(parseInt(request.query.limit) || 20, 100)
    const skip = (page - 1) * limit
    const search = request.query.search || ''
    const direction = request.query.direction || ''

    const filter = {}
    if (search) {
      filter.plate = { $regex: search.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }
    }
    if (direction && ['entry', 'exit'].includes(direction)) {
      filter.direction = direction
    }

    const [records, total] = await Promise.all([
      VehicleRecord.find(filter)
        .sort({ enterTime: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      VehicleRecord.countDocuments(filter),
    ])

    const formatted = records.map(r => ({
      plate: r.plate,
      direction: r.direction,
      parkingLot: r.parkingLotName,
      passageway: r.passagewayName,
      lane: r.laneName,
      enterTime: r.enterTime,
      exitTime: r.exitTime,
      duration: formatDuration(r.durationSeconds),
      durationSeconds: r.durationSeconds,
      allowed: r.allowed,
      vehicleType: r.vehicleType,
    }))

    return {
      records: formatted,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: skip + limit < total,
      },
    }
  })

  app.get('/:plate', async (request, reply) => {
    const plate = request.params.plate.toUpperCase()

    const [records, sessions, registered] = await Promise.all([
      VehicleRecord.find({ plate }).sort({ enterTime: -1 }).limit(50).lean(),
      VehicleSession.find({ plate }).sort({ entryTime: -1 }).limit(20).lean(),
      RegisteredVehicle.findOne({ plate }),
    ])

    const recent = records.map(r => ({
      plate: r.plate,
      direction: r.direction,
      parkingLot: r.parkingLotName,
      passageway: r.passagewayName,
      lane: r.laneName,
      enterTime: r.enterTime,
      exitTime: r.exitTime,
      duration: formatDuration(r.durationSeconds),
      allowed: r.allowed,
    }))

    return reply.send({
      plate,
      isRegistered: !!registered,
      registeredVehicle: registered ? {
        plate: registered.plate,
        ownerName: registered.ownerName,
        unitNumber: registered.unitNumber,
        phoneNumber: registered.phoneNumber,
        floorAccess: registered.floorAccess,
        isActive: registered.isActive,
      } : null,
      sessions: sessions.map(s => ({
        plate: s.plate,
        entryTime: s.entryTime,
        exitTime: s.exitTime,
        chargeAmount: s.chargeAmount,
        paymentRef: s.paymentRef,
        status: s.status,
        isKnown: s.isKnown,
      })),
      recentRecords: recent,
    })
  })
}

function formatDuration(seconds) {
  if (!seconds) return 'N/A'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const parts = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0) parts.push(`${h}h`)
  if (m > 0) parts.push(`${m}m`)
  return parts.join(' ') || '<1m'
}

module.exports = { recordRoutes }
