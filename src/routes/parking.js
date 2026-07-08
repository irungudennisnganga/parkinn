const { VehicleSession } = require('../models/VehicleSession')
const { Camera } = require('../models/Camera')
const { Area } = require('../models/Area')
const { ParkingLot } = require('../models/ParkingLot')

async function parkingRoutes(app) {
  app.get('/payment-history', async (request) => {
    const page = parseInt(request.query.page) || 1
    const limit = Math.min(parseInt(request.query.limit) || 20, 100)
    const skip = (page - 1) * limit
    const search = request.query.search || ''
    const floor = request.query.floor || ''

    const filter = {
      status: { $in: ['paid', 'exited'] },
      chargeAmount: { $gt: 0 },
    }
    if (search) {
      filter.plate = { $regex: search.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }
    }

    const [sessions, total, areas, cameras] = await Promise.all([
      VehicleSession.find(filter)
        .sort({ exitTime: -1, entryTime: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      VehicleSession.countDocuments(filter),
      Area.find().lean(),
      Camera.find().lean(),
    ])

    const areaMap = Object.fromEntries(areas.map(a => [a.areaId, a]))
    const cameraMap = Object.fromEntries(cameras.map(c => [c.cameraId, c]))

    let enriched = sessions.map(s => {
      const cam = cameraMap[s.entryCamera] || cameraMap[s.exitCamera]
      const area = cam ? areaMap[cam.areaId] : null
      return {
        _id: s._id,
        plate: s.plate,
        entryTime: s.entryTime,
        exitTime: s.exitTime,
        chargeAmount: s.chargeAmount,
        paymentRef: s.paymentRef || '--',
        status: s.status,
        isKnown: s.isKnown,
        floor: area?.name || 'Unknown',
        floorType: area?.areaType || 'unknown',
      }
    })

    if (floor) {
      enriched = enriched.filter(s => s.floor.toLowerCase().includes(floor.toLowerCase()))
    }

    return {
      payments: enriched,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: skip + limit < total,
      },
    }
  })

  app.get('/lots', async () => {
    const lots = await ParkingLot.find().lean()
    return lots.map(l => ({
      id: l.parkingLotId,
      name: l.name,
      totalSpaces: l.totalSpaces,
      freeSpaces: l.freeSpaces,
      occupiedSpaces: l.totalSpaces - l.freeSpaces,
      occupancyPercent: l.totalSpaces > 0
        ? Math.round(((l.totalSpaces - l.freeSpaces) / l.totalSpaces) * 100)
        : 0,
    }))
  })

  app.get('/active-by-floor', async () => {
    const [sessions, cameras, areas] = await Promise.all([
      VehicleSession.find({ status: { $in: ['active', 'unpaid'] } })
        .sort({ entryTime: -1 })
        .lean(),
      Camera.find().lean(),
      Area.find().lean(),
    ])

    const cameraMap = Object.fromEntries(cameras.map(c => [c.cameraId, c]))
    const areaMap = Object.fromEntries(areas.map(a => [a.areaId, a]))

    const floorGroups = {}
    for (const s of sessions) {
      const cam = cameraMap[s.entryCamera]
      const area = cam ? areaMap[cam.areaId] : null
      const floorName = area?.name || 'Unknown'
      const floorType = area?.areaType || 'unknown'

      if (!floorGroups[floorName]) {
        floorGroups[floorName] = {
          floor: floorName,
          floorType,
          active: 0,
          unpaid: 0,
          vehicles: [],
        }
      }

      if (s.status === 'active') floorGroups[floorName].active++
      if (s.status === 'unpaid') floorGroups[floorName].unpaid++

      floorGroups[floorName].vehicles.push({
        _id: s._id,
        plate: s.plate,
        entryTime: s.entryTime,
        status: s.status,
        isKnown: s.isKnown,
        chargeAmount: s.chargeAmount,
        cameraName: cam?.name || '',
      })
    }

    return {
      floors: Object.values(floorGroups).sort((a, b) => b.vehicles.length - a.vehicles.length),
      totalActive: sessions.length,
    }
  })
}

module.exports = { parkingRoutes }
