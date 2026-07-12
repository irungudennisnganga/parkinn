const { VehicleSession } = require('../models/VehicleSession')
const { VehicleRecord } = require('../models/VehicleRecord')
const { Camera } = require('../models/Camera')
const { Area } = require('../models/Area')
const { ParkingLot } = require('../models/ParkingLot')

  async function parkingRoutes(app) {
  app.get('/daily-analytics', async (request) => {
    const { DailySummary } = require('../models/DailySummary')
    const { VehicleSession } = require('../models/VehicleSession')
    const { Camera } = require('../models/Camera')
    const { Area } = require('../models/Area')

    const dateFrom = request.query.from || ''
    const dateTo = request.query.to || ''
    const daysBack = parseInt(request.query.days) || 14

    const todayUTC = new Date().toISOString().slice(0, 10)

    let startDate, endDate
    if (dateFrom) {
      startDate = new Date(dateFrom + 'T00:00:00.000Z')
      endDate = dateTo ? new Date(dateTo + 'T23:59:59.999Z') : new Date(todayUTC + 'T23:59:59.999Z')
    } else {
      endDate = new Date(todayUTC + 'T23:59:59.999Z')
      startDate = new Date(todayUTC + 'T00:00:00.000Z')
      startDate.setUTCDate(startDate.getUTCDate() - daysBack + 1)
    }

    const [savedSummaries, sessions, cameras, areas] = await Promise.all([
      DailySummary.find({
        date: {
          $gte: startDate.toISOString().slice(0, 10),
          $lte: endDate.toISOString().slice(0, 10),
        },
      }).sort({ date: 1 }).lean(),
      VehicleSession.find({
        entryTime: { $gte: startDate, $lte: endDate },
      }).lean(),
      Camera.find().lean(),
      Area.find().lean(),
    ])

    const cameraMap = Object.fromEntries(cameras.map(c => [c.cameraId, c]))
    const areaMap = Object.fromEntries(areas.map(a => [a.areaId, a]))

    const dailyMap = {}
    const savedMap = Object.fromEntries(savedSummaries.map(s => [s.date, s]))

    const dateLabels = []
    const cursor = new Date(startDate)
    while (cursor <= endDate) {
      dateLabels.push(cursor.toISOString().slice(0, 10))
      cursor.setDate(cursor.getDate() + 1)
    }

    for (const label of dateLabels) {
      if (savedMap[label]) {
        dailyMap[label] = { ...savedMap[label], fromSaved: true }
      } else {
        dailyMap[label] = {
          date: label,
          totalEntries: 0,
          totalExits: 0,
          totalRevenue: 0,
          totalPaid: 0,
          totalUnpaid: 0,
          knownEntries: 0,
          unknownEntries: 0,
          peakHour: 0,
          hourlyBreakdown: Array.from({ length: 24 }, (_, i) => ({ hour: i, entries: 0, exits: 0, revenue: 0 })),
          floorBreakdown: [],
          fromSaved: false,
        }
      }
    }

    const floorCountMap = {}
    for (const s of sessions) {
      const entryDate = new Date(s.entryTime).toISOString().slice(0, 10)
      if (!dailyMap[entryDate]) continue

      const day = dailyMap[entryDate]
      if (day.fromSaved) continue

      day.totalEntries++
      if (s.isKnown) day.knownEntries++
      else day.unknownEntries++

      const entryHour = new Date(s.entryTime).getHours()
      day.hourlyBreakdown[entryHour].entries++

      if (s.status === 'paid' || s.status === 'exited') {
        day.totalExits++
        const exitHour = s.exitTime ? new Date(s.exitTime).getHours() : entryHour
        day.hourlyBreakdown[exitHour].exits++
      }
      if (s.status === 'paid') {
        day.totalPaid++
        day.totalRevenue += s.chargeAmount || 0
        const exitHour = s.exitTime ? new Date(s.exitTime).getHours() : entryHour
        day.hourlyBreakdown[exitHour].revenue += s.chargeAmount || 0
      }
      if (s.status === 'unpaid') {
        day.totalUnpaid++
      }

      const cam = cameraMap[s.entryCamera]
      const area = cam ? areaMap[cam.areaId] : null
      const floor = area?.name || 'Unknown'
      if (!floorCountMap[entryDate]) floorCountMap[entryDate] = {}
      if (!floorCountMap[entryDate][floor]) {
        floorCountMap[entryDate][floor] = { floor, floorType: area?.areaType || 'unknown', entries: 0, exits: 0 }
      }
      floorCountMap[entryDate][floor].entries++
      if (s.status === 'paid' || s.status === 'exited') {
        floorCountMap[entryDate][floor].exits++
      }
    }

    for (const [dateKey, day] of Object.entries(dailyMap)) {
      if (!day.fromSaved && floorCountMap[dateKey]) {
        day.floorBreakdown = Object.values(floorCountMap[dateKey]).sort((a, b) => b.entries - a.entries)
      }
      if (!day.fromSaved) {
        let maxEntries = 0
        let peak = 0
        for (const h of day.hourlyBreakdown) {
          if (h.entries > maxEntries) {
            maxEntries = h.entries
            peak = h.hour
          }
        }
        day.peakHour = peak
      }
    }

    const days = Object.values(dailyMap)
    const totals = {
      totalEntries: days.reduce((s, d) => s + d.totalEntries, 0),
      totalExits: days.reduce((s, d) => s + d.totalExits, 0),
      totalRevenue: days.reduce((s, d) => s + d.totalRevenue, 0),
      totalPaid: days.reduce((s, d) => s + d.totalPaid, 0),
      totalUnpaid: days.reduce((s, d) => s + d.totalUnpaid, 0),
      knownEntries: days.reduce((s, d) => s + d.knownEntries, 0),
      unknownEntries: days.reduce((s, d) => s + d.unknownEntries, 0),
    }

    return { days, totals, range: { from: dateLabels[0], to: dateLabels[dateLabels.length - 1] } }
  })

  app.post('/daily-analytics/save', async (request) => {
    const { DailySummary } = require('../models/DailySummary')
    const { VehicleSession } = require('../models/VehicleSession')
    const { Camera } = require('../models/Camera')
    const { Area } = require('../models/Area')

    const targetDate = request.body?.date || new Date().toISOString().slice(0, 10)
    const startOfDay = new Date(targetDate + 'T00:00:00.000Z')
    const endOfDay = new Date(targetDate + 'T23:59:59.999Z')

    const [sessions, cameras, areas] = await Promise.all([
      VehicleSession.find({ entryTime: { $gte: startOfDay, $lte: endOfDay } }).lean(),
      Camera.find().lean(),
      Area.find().lean(),
    ])

    const cameraMap = Object.fromEntries(cameras.map(c => [c.cameraId, c]))
    const areaMap = Object.fromEntries(areas.map(a => [a.areaId, a]))

    const hourly = Array.from({ length: 24 }, (_, i) => ({ hour: i, entries: 0, exits: 0, revenue: 0 }))
    const floorMap = {}
    let totalEntries = 0, totalExits = 0, totalRevenue = 0, totalPaid = 0, totalUnpaid = 0
    let knownEntries = 0, unknownEntries = 0

    for (const s of sessions) {
      totalEntries++
      if (s.isKnown) knownEntries++
      else unknownEntries++

      const entryHour = new Date(s.entryTime).getHours()
      hourly[entryHour].entries++

      if (s.status === 'paid' || s.status === 'exited') {
        totalExits++
        const exitHour = s.exitTime ? new Date(s.exitTime).getHours() : entryHour
        hourly[exitHour].exits++
      }
      if (s.status === 'paid') {
        totalPaid++
        totalRevenue += s.chargeAmount || 0
        const exitHour = s.exitTime ? new Date(s.exitTime).getHours() : entryHour
        hourly[exitHour].revenue += s.chargeAmount || 0
      }
      if (s.status === 'unpaid') totalUnpaid++

      const cam = cameraMap[s.entryCamera]
      const area = cam ? areaMap[cam.areaId] : null
      const floor = area?.name || 'Unknown'
      if (!floorMap[floor]) floorMap[floor] = { floor, floorType: area?.areaType || 'unknown', entries: 0, exits: 0 }
      floorMap[floor].entries++
      if (s.status === 'paid' || s.status === 'exited') floorMap[floor].exits++
    }

    let peakHour = 0, maxEntries = 0
    for (const h of hourly) {
      if (h.entries > maxEntries) { maxEntries = h.entries; peakHour = h.hour }
    }

    const summary = await DailySummary.findOneAndUpdate(
      { date: targetDate },
      {
        date: targetDate,
        totalEntries, totalExits, totalRevenue, totalPaid, totalUnpaid,
        knownEntries, unknownEntries, peakHour,
        hourlyBreakdown: hourly,
        floorBreakdown: Object.values(floorMap).sort((a, b) => b.entries - a.entries),
        snapshotAt: new Date(),
      },
      { upsert: true, new: true },
    )

    return { success: true, summary }
  })

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

  app.get('/passageway-records', async (request, reply) => {
    const { HikCentralClient } = require('../services/HikCentralClient')
    const { isoLocal } = require('../utils/dateUtils')
    const hik = new HikCentralClient()

    const page = parseInt(request.query.page) || 1
    const limit = Math.min(parseInt(request.query.limit) || 50, 200)
    const search = request.query.search || ''
    const direction = request.query.direction || ''
    const lotCode = request.query.parkingLot || ''
    const hoursBack = parseInt(request.query.hours) || 1

    const now = new Date()
    const startDate = new Date(now.getTime() - hoursBack * 3600000)
    const startTime = isoLocal(startDate)
    const endTime = isoLocal(now)

    const lots = lotCode
      ? [{ parkingLotIndexCode: lotCode }]
      : await ParkingLot.find().lean()

    const allRecords = []
    const seenGuids = new Set()

    for (const lot of lots) {
      const code = lot.parkingLotIndexCode || lot.parkingLotId
      try {
        const pr = await hik.getPassagewayRecords(code, startTime, endTime)
        const records = pr?.data?.list || []
        for (const rec of records) {
          if (seenGuids.has(rec.guid)) continue
          seenGuids.add(rec.guid)

          const car = rec.carInfo || {}
          const lane = rec.laneInfo || {}
          const plate = (car.plateLicense || '').toUpperCase().replace(/\s+/g, '').trim()

          if (search && !plate.includes(search.toUpperCase().replace(/\s+/g, ''))) continue
          if (direction && lane.direction !== (direction === 'entry' ? 1 : 2)) continue

          const existingSession = await VehicleSession.findOne({
            plate,
            status: { $in: ['active', 'unpaid'] },
          })

          allRecords.push({
            guid: rec.guid,
            plate: plate || 'Unknown',
            parkingLotName: rec.parkingLotInfo?.parkingLotName || '',
            passagewayName: rec.passagewayInfo?.passagewayName || '',
            laneName: lane.laneName || '',
            laneIndexCode: lane.laneIndexCode || '',
            direction: lane.direction === 1 ? 'entry' : 'exit',
            enterTime: car.EnterTime || null,
            exitTime: car.ExitTime || null,
            imageUrl: car.ImageUrl || '',
            allowType: rec.allowType,
            allowResult: rec.allowResult,
            hasActiveSession: !!existingSession,
            sessionId: existingSession?._id?.toString() || '',
            sessionStatus: existingSession?.status || '',
          })
        }
      } catch (e) {
        req.log.warn({ lotCode: code, err: e.message }, 'Failed to fetch passageway records')
      }
    }

    const total = allRecords.length
    const paginated = allRecords.slice((page - 1) * limit, page * limit)

    return reply.send({
      success: true,
      records: paginated,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      query: { startTime, endTime, lotCount: lots.length, hoursBack },
    })
  })

  app.post('/create-sessions-from-passageway', async (request, reply) => {
    const { HikCentralClient } = require('../services/HikCentralClient')
    const { isoLocal } = require('../utils/dateUtils')
    const { processAnprEvent } = require('../services/EventProcessor')
    const { broadcastActiveSessions } = require('../services/WebSocketManager')
    const hik = new HikCentralClient()

    const { parkingLot, hours = 1, direction: dirFilter, createOnlyNew = true } = request.body || {}
    const hoursBack = parseInt(hours) || 1

    const now = new Date()
    const startDate = new Date(now.getTime() - hoursBack * 3600000)
    const startTime = isoLocal(startDate)
    const endTime = isoLocal(now)

    const lots = parkingLot
      ? [{ parkingLotIndexCode: parkingLot }]
      : await ParkingLot.find().lean()

    const created = []
    const skipped = []
    const errors = []
    const seenPlates = new Set()

    for (const lot of lots) {
      const code = lot.parkingLotIndexCode || lot.parkingLotId
      try {
        const pr = await hik.getPassagewayRecords(code, startTime, endTime)
        const records = pr?.data?.list || []
        for (const rec of records) {
          const car = rec.carInfo || {}
          const lane = rec.laneInfo || {}
          const plate = (car.plateLicense || '').toUpperCase().replace(/\s+/g, '').trim()
          if (!plate || plate === 'UNKNOWN' || seenPlates.has(plate)) continue
          seenPlates.add(plate)

          if (dirFilter) {
            const recDir = lane.direction === 1 ? 'entry' : 'exit'
            if (recDir !== dirFilter) {
              skipped.push({ plate, reason: `Direction mismatch: ${recDir}` })
              continue
            }
          }

          if (createOnlyNew) {
            const existing = await VehicleSession.findOne({ plate, status: { $in: ['active', 'unpaid'] } })
            if (existing) {
              skipped.push({ plate, reason: 'Already has active/unpaid session', sessionId: existing._id })
              continue
            }
          }

          const eventTime = lane.direction === 2 && car.ExitTime
            ? car.ExitTime
            : (car.EnterTime || now.toISOString())

          const result = await processAnprEvent({
            plateNumber: plate,
            cameraId: lane.laneIndexCode || '',
            eventTime,
          })

          if (result && result.session) {
            created.push({ plate, action: result.action, sessionId: result.session._id })
          } else if (result) {
            skipped.push({ plate, reason: result.reason || result.action })
          } else {
            errors.push({ plate, reason: 'processAnprEvent returned null' })
          }
        }
      } catch (e) {
        errors.push({ lotCode: code, reason: e.message })
      }
    }

    broadcastActiveSessions()

    return reply.send({
      success: true,
      summary: { created: created.length, skipped: skipped.length, errors: errors.length },
      created,
      skipped,
      errors,
      query: { startTime, endTime, lotCount: lots.length, hoursBack },
    })
  })

}

module.exports = { parkingRoutes }
