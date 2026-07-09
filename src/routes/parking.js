const { VehicleSession } = require('../models/VehicleSession')
const { VehicleRecord } = require('../models/VehicleRecord')
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

  app.get('/exited-unpaid', async (request) => {
    const page = parseInt(request.query.page) || 1
    const limit = Math.min(parseInt(request.query.limit) || 20, 100)
    const skip = (page - 1) * limit
    const search = request.query.search || ''

    const filter = { status: 'unpaid' }
    if (search) {
      filter.plate = { $regex: search.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }
    }

    const [sessions, total, cameras, areas] = await Promise.all([
      VehicleSession.find(filter)
        .sort({ exitTime: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      VehicleSession.countDocuments(filter),
      Camera.find().lean(),
      Area.find().lean(),
    ])

    const cameraMap = Object.fromEntries(cameras.map(c => [c.cameraId, c]))
    const areaMap = Object.fromEntries(areas.map(a => [a.areaId, a]))

    const enriched = sessions.map(s => {
      const cam = cameraMap[s.entryCamera] || cameraMap[s.exitCamera]
      const area = cam ? areaMap[cam.areaId] : null
      return {
        _id: s._id,
        plate: s.plate,
        entryTime: s.entryTime,
        exitTime: s.exitTime,
        chargeAmount: s.chargeAmount,
        chargeRate: s.chargeRate,
        status: s.status,
        isKnown: s.isKnown,
        floor: area?.name || 'Unknown',
        floorType: area?.areaType || 'unknown',
        entryCamera: cam?.name || '',
      }
    })

    return {
      sessions: enriched,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasMore: skip + limit < total },
    }
  })

  app.get('/dashboard-stats', async () => {
    const now = new Date()
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const startOfWeek = new Date(now)
    startOfWeek.setDate(now.getDate() - now.getDay())
    startOfWeek.setHours(0, 0, 0, 0)
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)

    const sevenDaysAgo = new Date(now)
    sevenDaysAgo.setDate(now.getDate() - 6)
    sevenDaysAgo.setHours(0, 0, 0, 0)

    const [
      activeSessions,
      unpaidSessions,
      todayEntries,
      todayRevenue,
      todayPaid,
      weekRevenue,
      monthRevenue,
      totalRegistered,
      dailyStats,
      floorDistribution,
      parkingLots,
    ] = await Promise.all([
      VehicleSession.countDocuments({ status: { $in: ['active', 'unpaid'] } }),
      VehicleSession.countDocuments({ status: 'unpaid' }),
      VehicleSession.countDocuments({ entryTime: { $gte: startOfToday } }),
      VehicleSession.aggregate([
        { $match: { status: 'paid', exitTime: { $gte: startOfToday } } },
        { $group: { _id: null, total: { $sum: '$chargeAmount' } } },
      ]),
      VehicleSession.countDocuments({ status: 'paid', exitTime: { $gte: startOfToday } }),
      VehicleSession.aggregate([
        { $match: { status: 'paid', exitTime: { $gte: startOfWeek } } },
        { $group: { _id: null, total: { $sum: '$chargeAmount' } } },
      ]),
      VehicleSession.aggregate([
        { $match: { status: 'paid', exitTime: { $gte: startOfMonth } } },
        { $group: { _id: null, total: { $sum: '$chargeAmount' } } },
      ]),
      require('../models/RegisteredVehicle').RegisteredVehicle.countDocuments({ isActive: true }),
      VehicleSession.aggregate([
        { $match: { status: { $in: ['paid', 'exited'] }, entryTime: { $gte: sevenDaysAgo } } },
        {
          $group: {
            _id: {
              date: {
                $dateToString: { format: '%Y-%m-%d', date: '$entryTime', timezone: 'Africa/Nairobi' },
              },
              status: '$status',
            },
            count: { $sum: 1 },
            revenue: { $sum: '$chargeAmount' },
          },
        },
        { $sort: { '_id.date': 1 } },
      ]),
      VehicleSession.aggregate([
        { $match: { status: { $in: ['active', 'unpaid'] } } },
        {
          $lookup: {
            from: 'cameras',
            localField: 'entryCamera',
            foreignField: 'cameraId',
            as: 'cam',
          },
        },
        { $unwind: { path: '$cam', preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: 'areas',
            localField: 'cam.areaId',
            foreignField: 'areaId',
            as: 'area',
          },
        },
        { $unwind: { path: '$area', preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: { floor: '$area.name', type: '$area.areaType' },
            count: { $sum: 1 },
            chargeTotal: { $sum: '$chargeAmount' },
          },
        },
      ]),
      ParkingLot.find().lean(),
    ])

    const todayRev = todayRevenue.length > 0 ? todayRevenue[0].total : 0
    const weekRev = weekRevenue.length > 0 ? weekRevenue[0].total : 0
    const monthRev = monthRevenue.length > 0 ? monthRevenue[0].total : 0

    const dateLabels = []
    const temp = new Date(sevenDaysAgo)
    while (temp <= now) {
      dateLabels.push(temp.toISOString().slice(0, 10))
      temp.setDate(temp.getDate() + 1)
    }

    const dailyEntries = new Array(dateLabels.length).fill(0)
    const dailyRevenue = new Array(dateLabels.length).fill(0)
    const dailyPaid = new Array(dateLabels.length).fill(0)
    const dailyExited = new Array(dateLabels.length).fill(0)

    for (const stat of dailyStats) {
      const idx = dateLabels.indexOf(stat._id.date)
      if (idx !== -1) {
        if (stat._id.status === 'paid') {
          dailyPaid[idx] = stat.count
          dailyRevenue[idx] = stat.revenue
        } else if (stat._id.status === 'exited') {
          dailyExited[idx] = stat.count
        }
      }
    }

    for (let i = 0; i < dateLabels.length; i++) {
      dailyEntries[i] = dailyPaid[i] + dailyExited[i]
    }

    const floorData = floorDistribution.map(f => ({
      floor: f._id.floor || 'Unknown',
      type: f._id.type || 'unknown',
      count: f.count,
      chargeTotal: f.chargeTotal || 0,
    }))

    const lotStats = parkingLots.map(l => ({
      id: l.parkingLotId,
      name: l.name,
      totalSpaces: l.totalSpaces,
      freeSpaces: l.freeSpaces,
      occupied: l.totalSpaces - l.freeSpaces,
    }))

    return {
      overview: {
        activeSessions,
        unpaidSessions,
        todayEntries,
        todayPaid,
        todayRevenue: todayRev,
        weekRevenue: weekRev,
        monthRevenue: monthRev,
        registeredVehicles: totalRegistered,
        totalLotSpaces: lotStats.reduce((s, l) => s + l.totalSpaces, 0),
        totalFreeSpaces: lotStats.reduce((s, l) => s + l.freeSpaces, 0),
      },
      charts: {
        daily: {
          labels: dateLabels,
          entries: dailyEntries,
          revenue: dailyRevenue,
          paid: dailyPaid,
          exited: dailyExited,
        },
        floorDistribution: floorData,
        paymentStatus: {
          active: activeSessions,
          unpaid: unpaidSessions,
          paid: todayPaid,
        },
      },
      lots: lotStats,
    }
  })

  app.get('/system-payments', async (request) => {
    const page = parseInt(request.query.page) || 1
    const limit = Math.min(parseInt(request.query.limit) || 20, 100)
    const skip = (page - 1) * limit
    const search = request.query.search || ''
    const dateFrom = request.query.dateFrom || ''
    const dateTo = request.query.dateTo || ''

    const filter = { status: 'paid' }
    if (search) {
      filter.plate = { $regex: search.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }
    }
    if (dateFrom || dateTo) {
      filter.exitTime = {}
      if (dateFrom) filter.exitTime.$gte = new Date(dateFrom)
      if (dateTo) filter.exitTime.$lte = new Date(dateTo + 'T23:59:59.999Z')
    }

    const [sessions, total, totalRevenue, cameras, areas] = await Promise.all([
      VehicleSession.find(filter)
        .sort({ exitTime: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      VehicleSession.countDocuments(filter),
      VehicleSession.aggregate([
        { $match: filter },
        { $group: { _id: null, total: { $sum: '$chargeAmount' } } },
      ]),
      Camera.find().lean(),
      Area.find().lean(),
    ])

    const cameraMap = Object.fromEntries(cameras.map(c => [c.cameraId, c]))
    const areaMap = Object.fromEntries(areas.map(a => [a.areaId, a]))

    const payments = sessions.map(s => {
      const cam = cameraMap[s.entryCamera] || cameraMap[s.exitCamera]
      const area = cam ? areaMap[cam.areaId] : null
      return {
        _id: s._id,
        plate: s.plate,
        entryTime: s.entryTime,
        exitTime: s.exitTime,
        chargeAmount: s.chargeAmount,
        paymentRef: s.paymentRef || '--',
        paymentMethod: (s.paymentRef || '').startsWith('manual') ? 'Manual/Cash' : 'M-Pesa',
        status: s.status,
        isKnown: s.isKnown,
        floor: area?.name || 'Unknown',
        floorType: area?.areaType || 'unknown',
      }
    })

    return {
      payments,
      summary: {
        totalRevenue: totalRevenue.length > 0 ? totalRevenue[0].total : 0,
        totalTransactions: total,
      },
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasMore: skip + limit < total },
    }
  })

  app.get('/hikcentral-records', async (request) => {
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
      _id: r._id,
      plate: r.plate,
      direction: r.direction,
      parkingLot: r.parkingLotName || 'N/A',
      passageway: r.passagewayName || 'N/A',
      lane: r.laneName || 'N/A',
      enterTime: r.enterTime,
      exitTime: r.exitTime,
      durationSeconds: r.durationSeconds || 0,
      duration: formatDuration(r.durationSeconds),
      allowed: r.allowed,
      imageUrl: r.imageUrl || '',
      ownerName: r.ownerName || '',
      ownerPhone: r.ownerPhone || '',
    }))

    return {
      records: formatted,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasMore: skip + limit < total },
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
  app.get('/raw-events', async (request, reply) => {
    const { RawEvent } = require('../models/RawEvent')
    const page = parseInt(request.query.page) || 1
    const limit = Math.min(parseInt(request.query.limit) || 50, 200)
    const skip = (page - 1) * limit

    const filter = {}
    if (request.query.plate) filter.plate = { $regex: request.query.plate, $options: 'i' }
    if (request.query.action) filter.action = request.query.action
    if (request.query.direction) filter.direction = request.query.direction

    const [events, total] = await Promise.all([
      RawEvent.find(filter).sort({ receivedAt: -1 }).skip(skip).limit(limit).lean(),
      RawEvent.countDocuments(filter),
    ])

    return reply.send({ success: true, events, total, page, totalPages: Math.ceil(total / limit) })
  })

  app.post('/raw-events/cleanup', async (request, reply) => {
    const { RawEvent } = require('../models/RawEvent')
    const daysOld = parseInt(request.query.days) || 7
    const cutoff = new Date(Date.now() - daysOld * 86400000)
    const result = await RawEvent.deleteMany({ receivedAt: { $lt: cutoff } })
    return reply.send({ success: true, deleted: result.deletedCount, message: `Deleted ${result.deletedCount} events older than ${daysOld} days` })
  })

}

module.exports = { parkingRoutes }
