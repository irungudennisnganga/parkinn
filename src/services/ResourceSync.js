const { logger } = require('../utils/logger')
const { HikCentralClient } = require('./HikCentralClient')
const { Area } = require('../models/Area')
const { Camera } = require('../models/Camera')
const { Barrier } = require('../models/Barrier')
const { ParkingLot } = require('../models/ParkingLot')
const { HikCentralVersion } = require('../models/HikCentralVersion')
const { EventSubscription } = require('../models/EventSubscription')
const { VehicleRecord } = require('../models/VehicleRecord')
const config = require('../config')

const hik = new HikCentralClient()

function iso8601() {
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  const tz = now.toString().match(/([+-]\d{2}):?(\d{2})/) || ['+00:00', '+00', '00']
  const offset = `${tz[1]}:${tz[2]}`
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${offset}`
  return {
    beginTime: fmt(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0)),
    endTime: fmt(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59)),
  }
}

function monthAgo() {
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  const tz = now.toString().match(/([+-]\d{2}):?(\d{2})/) || ['+00:00', '+00', '00']
  const offset = `${tz[1]}:${tz[2]}`
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${offset}`
  return {
    beginTime: fmt(new Date(now.getFullYear(), now.getMonth()-1, now.getDate(), 0, 0, 0)),
    endTime: fmt(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59)),
  }
}

async function setupWebhook() {
  const callbackUrl = config.hikcentral.callbackUrl
  if (!callbackUrl) {
    logger.warn('HIKCENTRAL_CALLBACK_URL not set — skipping webhook registration')
    return false
  }
  const eventTypes = [131329, 131330, 131331]

  // Unsubscribe ALL previous subscriptions first
  try {
    await hik.unsubscribeEvents(eventTypes)
    logger.info('Previous event subscriptions cleared')
  } catch (_) {}

  // Check what's currently subscribed
  try {
    const viewRes = await hik.getEventSubscriptionView()
    logger.info({ view: viewRes }, 'Current subscriptions')
  } catch (_) {}

  // Subscribe fresh
  try {
    await hik.subscribeEvents(eventTypes, callbackUrl)
    await EventSubscription.updateOne(
      { eventDest: callbackUrl },
      { eventTypes, eventDest: callbackUrl, status: 'active', subscribedAt: new Date(), updatedAt: new Date() },
      { upsert: true }
    )
    logger.info({ callbackUrl, eventTypes }, 'Event subscription configured')
    return true
  } catch (err) {
    logger.warn({ err: err.message }, 'Webhook setup failed')
    return false
  }
}

async function syncResources() {
  logger.info('Starting HikCentral resource sync...')

  // VERSION
  try {
    const v = await hik.getVersion()
    if (v.data) await HikCentralVersion.updateOne({ platform: 'hikcentral' }, { version: v.data.softVersion || JSON.stringify(v.data), platform: 'hikcentral', fetchedAt: new Date() }, { upsert: true })
    logger.info({ version: v.data }, 'Version')
  } catch (_) {}

  // AREAS
  if (await Area.countDocuments() === 0) {
    const rr = await hik.getRegions({ siteIndexCode: '0' })
    const regions = rr.data?.list || []
    for (const r of regions) {
      const name = r.name || ''
      const isRes = config.floors.residential.some(f => name.includes(`${f}`)) || name.includes('RESIDENTIAL')
      const isCom = config.floors.commercial.some(f => name.includes(`${f}`)) || name.includes('COMMERCIAL')
      await Area.updateOne({ areaId: r.indexCode }, { areaId: r.indexCode, name: r.name, parentId: r.parentIndexCode || '', areaType: isRes ? 'residential' : isCom ? 'commercial' : 'commercial' }, { upsert: true })
    }
  }

  // PARKING LOTS
  let lots = []
  if (await ParkingLot.countDocuments() === 0) {
    const pl = await hik.getParkingLotList()
    lots = pl.data?.list || []
    for (const lot of lots) {
      await ParkingLot.updateOne({ parkingLotId: lot.parkingLotIndexCode }, { parkingLotId: lot.parkingLotIndexCode, name: lot.parkingLotName, totalSpaces: lot.totalSpaceNum || 0, freeSpaces: lot.freeSpaceNum || 0, parentId: lot.parentParkingLotIndexCode || '' }, { upsert: true })
    }
  } else {
    lots = await ParkingLot.find().lean()
  }

  const seenCam = new Set()
  const seenBar = new Set()
  let cameraCount = 0
  let barrierCount = 0
  let vehicleCount = 0

  // ALARM OUTPUTS = real barriers
  for (const dt of [undefined, 'encodeDevice', 'acsDevice', 'mobileDevice', 'encodeDevice,acsDevice,mobileDevice']) {
    try {
      const aoRes = await hik.getAlarmOutputs(dt)
      const alarmOutputs = aoRes.data?.list || []
      const label = dt || 'default'
      logger.info({ deviceType: label, count: alarmOutputs.length, total: aoRes.data?.total, sample: alarmOutputs[0] }, 'Alarm outputs')
      for (const ao of alarmOutputs) {
        const aoId = ao.alarmOutputIndexCode || ao.indexCode
        if (!aoId || seenBar.has(aoId)) continue
        seenBar.add(aoId)
        await Barrier.updateOne({ barrierId: aoId }, { barrierId: aoId, name: ao.alarmOutputName || ao.name || aoId, areaId: ao.regionIndexCode || '', cameraId: '' }, { upsert: true })
        barrierCount++
      }
    } catch (_) {}
    if (barrierCount > 0) break
  }

  // PASSAGEWAY RECORDS → cameras + barriers + vehicles
  const timeframes = [{ label: 'today', ...iso8601() }, { label: 'month', ...monthAgo() }]
  for (const tf of timeframes) {
    for (const lot of lots) {
      const lotCode = lot.parkingLotIndexCode || lot.parkingLotId
      try {
        const pr = await hik.getPassagewayRecords(lotCode, tf.beginTime, tf.endTime)
        const records = pr.data?.list || []
        for (const rec of records) {
          const pw = rec.passagewayInfo
          const lane = rec.laneInfo
          if (pw) {
            const pid = pw.passagewayIndexCode
            if (pid && !seenBar.has(pid)) {
              seenBar.add(pid)
              await Barrier.updateOne({ barrierId: pid }, { barrierId: pid, name: pw.passagewayName || pid, areaId: lotCode, cameraId: lane?.laneIndexCode || '' }, { upsert: true })
              barrierCount++
            }
          }
          if (lane) {
            const lid = lane.laneIndexCode
            if (lid && !seenCam.has(lid)) { seenCam.add(lid); await Camera.updateOne({ cameraId: lid }, { cameraId: lid, name: lane.laneName || `Lane ${lid}`, areaId: lotCode, cameraType: 'ANPR', indexCode: lid, direction: lane.direction === 1 ? 'entry' : 'exit' }, { upsert: true }); cameraCount++ }
          }
          const car = rec.carInfo
          if (car?.plateLicense) {
            vehicleCount++
            await VehicleRecord.updateOne({ guid: rec.guid }, { guid: rec.guid, plate: car.plateLicense, vehicleType: car.carType || 0, parkingLotId: rec.parkingLotInfo?.parkingLotIndexCode || lotCode, parkingLotName: rec.parkingLotInfo?.parkingLotName || lot.parkingLotName || lot.name || '', passagewayId: pw?.passagewayIndexCode || '', passagewayName: pw?.passagewayName || '', laneId: lane?.laneIndexCode || '', laneName: lane?.laneName || '', direction: lane?.direction === 1 ? 'entry' : 'exit', enterTime: car.EnterTime ? new Date(car.EnterTime) : undefined, exitTime: car.ExitTime ? new Date(car.ExitTime) : undefined, imageUrl: car.ImageUrl || '', ownerName: rec.personInfo?.ownerName || '', ownerPhone: rec.personInfo?.ownerPhoneNum || '', allowed: rec.allowResult === 1, syncedAt: new Date() }, { upsert: true })
          }
        }
      } catch (_) {}
    }
  }

  const areaCount = await Area.countDocuments()
  const lotCount = await ParkingLot.countDocuments()
  logger.info({ areaCount, parkingLotCount: lotCount, cameraCount, barrierCount, vehicleRecordCount: vehicleCount }, 'Sync complete')
  return { areas: areaCount, parkingLots: lotCount, cameras: cameraCount, barriers: barrierCount, vehicleRecords: vehicleCount }
}

module.exports = { setupWebhook, syncResources }
