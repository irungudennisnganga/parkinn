const { RegisteredVehicle } = require('../models/RegisteredVehicle')
const { VehicleSession } = require('../models/VehicleSession')
const { broadcastActiveSessions } = require('../services/WebSocketManager')

function normalizePlate(plate) {
  return plate.toUpperCase().replace(/\s+/g, '').trim()
}

async function vehicleRoutes(app) {
  app.post('/register', async (request, reply) => {
    const { plate, ownerName, unitNumber, phoneNumber, floorAccess } = request.body
    const normalized = normalizePlate(plate)

    const existing = await RegisteredVehicle.findOne({ plate: normalized })
    if (existing) {
      return reply.status(409).send({ error: 'Vehicle already registered' })
    }

    const vehicle = await RegisteredVehicle.create({
      plate: normalized,
      ownerName,
      unitNumber,
      phoneNumber,
      floorAccess: floorAccess || [1, 2, 3, 4, 5, 6, 7, 8, 9],
      isActive: true,
    })

    return reply.status(201).send(vehicle)
  })

  app.get('/:plate', async (request, reply) => {
    const plate = normalizePlate(request.params.plate)
    const vehicle = await RegisteredVehicle.findOne({ plate })
    if (!vehicle) {
      return reply.status(404).send({ error: 'Vehicle not found' })
    }
    const activeSession = await VehicleSession.findOne({ plate, status: { $in: ['active', 'unpaid'] } })
    return reply.send({ vehicle, activeSession })
  })

  app.get('/active', async () => {
    const sessions = await VehicleSession.find({ status: { $in: ['active', 'unpaid'] } })
      .sort({ entryTime: -1 })
      .limit(100)
    return { sessions }
  })

  app.delete('/:plate', async (request, reply) => {
    const plate = normalizePlate(request.params.plate || request.body?.plate || '')
    if (!plate) {
      return reply.status(400).send({ error: 'Plate number required' })
    }
    const vehicle = await RegisteredVehicle.findOneAndDelete({ plate })
    if (!vehicle) {
      return reply.status(404).send({ error: 'Vehicle not found' })
    }
    return reply.send({ message: 'Vehicle deleted', plate: vehicle.plate })
  })
}

module.exports = { vehicleRoutes }
