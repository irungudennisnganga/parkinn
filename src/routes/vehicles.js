const { RegisteredVehicle } = require('../models/RegisteredVehicle')
const { VehicleSession } = require('../models/VehicleSession')

async function vehicleRoutes(app) {
  app.post('/register', async (request, reply) => {
    const { plate, ownerName, unitNumber, phoneNumber, floorAccess } = request.body

    const existing = await RegisteredVehicle.findOne({ plate: plate.toUpperCase() })
    if (existing) {
      return reply.status(409).send({ error: 'Vehicle already registered' })
    }

    const vehicle = await RegisteredVehicle.create({
      plate: plate.toUpperCase(),
      ownerName,
      unitNumber,
      phoneNumber,
      floorAccess: floorAccess || [1, 2, 3, 4, 5, 6, 7, 8, 9],
      isActive: true,
    })

    return reply.status(201).send(vehicle)
  })

  app.get('/:plate', async (request, reply) => {
    const plate = request.params.plate.toUpperCase()
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
    const plate = request.params.plate.toUpperCase()
    const vehicle = await RegisteredVehicle.findOneAndUpdate(
      { plate },
      { isActive: false },
      { new: true }
    )
    if (!vehicle) {
      return reply.status(404).send({ error: 'Vehicle not found' })
    }
    return reply.send({ message: 'Vehicle deactivated', plate: vehicle.plate })
  })
}

module.exports = { vehicleRoutes }
