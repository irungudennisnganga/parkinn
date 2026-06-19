const { createApp } = require('../src/index')
const { seedData, clearData } = require('./helpers')
const { startMongo, stopMongo } = require('./setup')
const mongoose = require('mongoose')
const { RegisteredVehicle } = require('../src/models/RegisteredVehicle')

jest.mock('../src/services/HikCentralClient')

let app

beforeAll(async () => {
  await startMongo()
  app = await createApp()
  await seedData()
})

afterAll(async () => {
  await clearData()
  await app.close()
  await stopMongo()
})

describe('Vehicles API', () => {
  describe('POST /vehicles/register', () => {
    afterEach(async () => {
      await RegisteredVehicle.deleteMany({ plate: { $ne: 'KCA 123A' } })
    })

    it('registers a new vehicle', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/vehicles/register',
        payload: {
          plate: 'KBB 456B',
          ownerName: 'Jane Doe',
          unitNumber: '3A',
          phoneNumber: '254798765432',
        },
      })
      expect(res.statusCode).toBe(201)
      const body = JSON.parse(res.body)
      expect(body.plate).toBe('KBB 456B')
      expect(body.isActive).toBe(true)
    })

    it('rejects duplicate plate', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/vehicles/register',
        payload: {
          plate: 'KCA 123A',
          ownerName: 'Duplicate',
          unitNumber: '1A',
          phoneNumber: '254700000000',
        },
      })
      expect(res.statusCode).toBe(409)
    })
  })

  describe('GET /vehicles/:plate', () => {
    it('returns vehicle and active session', async () => {
      const res = await app.inject({ method: 'GET', url: '/vehicles/KCA%20123A' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.vehicle.plate).toBe('KCA 123A')
      expect(body.vehicle.ownerName).toBe('John Doe')
    })

    it('returns 404 for unknown plate', async () => {
      const res = await app.inject({ method: 'GET', url: '/vehicles/NONEXISTENT' })
      expect(res.statusCode).toBe(404)
    })
  })

  describe('GET /vehicles/active', () => {
    it('returns empty array when no active sessions', async () => {
      const res = await app.inject({ method: 'GET', url: '/vehicles/active' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.sessions).toEqual([])
    })
  })
})
