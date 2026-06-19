const mongoose = require('mongoose')
const { Area } = require('../src/models/Area')
const { Camera } = require('../src/models/Camera')
const { Barrier } = require('../src/models/Barrier')
const { RegisteredVehicle } = require('../src/models/RegisteredVehicle')
const { ChargeRate } = require('../src/models/ChargeRate')

async function seedData() {
  await Area.insertMany([
    { areaId: 'area-floor-1', name: 'Floor 1', parentId: '', areaType: 'commercial' },
    { areaId: 'area-floor-5', name: 'Floor 5', parentId: '', areaType: 'residential' },
  ])

  await Camera.insertMany([
    { cameraId: 'cam-floor1-entry', name: 'Floor 1 Entry', areaId: 'area-floor-1', cameraType: 'ANPR', direction: 'entry' },
    { cameraId: 'cam-floor1-exit',  name: 'Floor 1 Exit',  areaId: 'area-floor-1', cameraType: 'ANPR', direction: 'exit' },
    { cameraId: 'cam-floor5-entry', name: 'Floor 5 Entry', areaId: 'area-floor-5', cameraType: 'ANPR', direction: 'entry' },
    { cameraId: 'cam-floor5-exit',  name: 'Floor 5 Exit',  areaId: 'area-floor-5', cameraType: 'ANPR', direction: 'exit' },
  ])

  await Barrier.insertMany([
    { barrierId: 'barrier-floor1-entry', name: 'Floor 1 Entry Barrier', areaId: 'area-floor-1', cameraId: 'cam-floor1-entry', direction: 'entry' },
    { barrierId: 'barrier-floor1-exit',  name: 'Floor 1 Exit Barrier',  areaId: 'area-floor-1', cameraId: 'cam-floor1-exit',  direction: 'exit' },
    { barrierId: 'barrier-floor5-entry', name: 'Floor 5 Entry Barrier', areaId: 'area-floor-5', cameraId: 'cam-floor5-entry', direction: 'entry' },
    { barrierId: 'barrier-floor5-exit',  name: 'Floor 5 Exit Barrier',  areaId: 'area-floor-5', cameraId: 'cam-floor5-exit',  direction: 'exit' },
  ])

  await RegisteredVehicle.create({
    plate: 'KCA 123A',
    ownerName: 'John Doe',
    unitNumber: '5B',
    phoneNumber: '254712345678',
    floorAccess: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    isActive: true,
  })

  await ChargeRate.create({
    floorId: 'area-floor-1',
    ratePerHr: 100,
    flatRate: 0,
    gracePeriod: 15,
    maxDaily: 1000,
  })
}

async function clearData() {
  const collections = mongoose.connection.collections
  for (const key in collections) {
    await collections[key].deleteMany({})
  }
}

module.exports = { seedData, clearData }
