const { createApp } = require('../src/index')
const { seedData, clearData } = require('./helpers')
const { startMongo, stopMongo } = require('./setup')
const mongoose = require('mongoose')
const { VehicleSession } = require('../src/models/VehicleSession')
const { mockControlDoor, mockCalculateParkingFee } = require('../src/services/HikCentralClient')

jest.mock('../src/services/HikCentralClient')

let app

beforeAll(async () => {
  await startMongo()
  app = await createApp()
  await seedData()
})

  beforeEach(async () => {
    mockControlDoor.mockClear()
    mockCalculateParkingFee.mockClear()
    await VehicleSession.deleteMany({})
  })

afterAll(async () => {
  await clearData()
  await app.close()
  await stopMongo()
})

function sendEvent(overrides = {}) {
  const payload = {
    eventData: {
      eventType: 'ANPR_VEHICLE_DETECTED',
      eventTime: new Date().toISOString(),
      plateNumber: 'KXX 999Z',
      cameraId: 'cam-floor1-entry',
      cameraName: 'Floor 1 Entry',
      direction: 'entry',
      ...overrides,
    },
  }
  return app.inject({ method: 'POST', url: '/eventsRCV', payload })
}

describe('POST /eventsRCV', () => {
  describe('Entry scenarios', () => {
    it('opens barrier and creates session for unknown vehicle on commercial floor', async () => {
      const res = await sendEvent({ plateNumber: 'UNK 001' })
      expect(res.statusCode).toBe(200)
      expect(mockControlDoor).toHaveBeenCalledWith('barrier-floor1-entry', 1, 0)

      const session = await VehicleSession.findOne({ plate: 'UNK 001' })
      expect(session).not.toBeNull()
      expect(session.status).toBe('active')
      expect(session.isKnown).toBe(false)
    })

    it('opens barrier and creates session for known vehicle on commercial floor', async () => {
      const res = await sendEvent({ plateNumber: 'KCA 123A' })
      expect(res.statusCode).toBe(200)
      expect(mockControlDoor).toHaveBeenCalledWith('barrier-floor1-entry', 1, 0)

      const session = await VehicleSession.findOne({ plate: 'KCA 123A' })
      expect(session).not.toBeNull()
      expect(session.status).toBe('active')
      expect(session.isKnown).toBe(true)
    })

    it('opens barrier for known vehicle on residential (floor 5) entry', async () => {
      const res = await sendEvent({
        plateNumber: 'KCA 123A',
        cameraId: 'cam-floor5-entry',
      })
      expect(res.statusCode).toBe(200)
      expect(mockControlDoor).toHaveBeenCalledWith('barrier-floor5-entry', 1, 0)

      const session = await VehicleSession.findOne({ plate: 'KCA 123A' })
      expect(session).not.toBeNull()
    })

    it('BLOCKS unknown vehicle at residential (floor 5) entry — no barrier, no session', async () => {
      const res = await sendEvent({
        plateNumber: 'UNK 002',
        cameraId: 'cam-floor5-entry',
      })
      expect(res.statusCode).toBe(200)
      expect(mockControlDoor).not.toHaveBeenCalled()

      const session = await VehicleSession.findOne({ plate: 'UNK 002' })
      expect(session).toBeNull()
    })
  })

  describe('Exit scenarios', () => {
    it('opens barrier for known vehicle exit', async () => {
      await VehicleSession.create({
        plate: 'KCA 123A',
        entryTime: new Date(Date.now() - 3600000),
        entryCamera: 'cam-floor1-entry',
        entryBarrier: 'barrier-floor1-entry',
        isKnown: true,
        status: 'active',
      })

      const res = await sendEvent({
        plateNumber: 'KCA 123A',
        cameraId: 'cam-floor1-exit',
        direction: 'exit',
      })
      expect(res.statusCode).toBe(200)
      expect(mockControlDoor).toHaveBeenCalledWith('barrier-floor1-exit', 1, 1)

      const session = await VehicleSession.findOne({ plate: 'KCA 123A' })
      expect(session.status).toBe('exited')
      expect(session.exitTime).not.toBeNull()
    })

    it('opens barrier and exits for unpaid vehicle within grace period', async () => {
      mockCalculateParkingFee.mockResolvedValueOnce({
        code: '0',
        msg: 'Success',
        data: {
          plateLicense: 'UNK 003',
          parkingDuration: 600,
          feeRuleType: 0,
          feeRuleIndexCode: '1',
          feeRuleName: 'default',
          fee: '0',
        },
      })

      await VehicleSession.create({
        plate: 'UNK 003',
        entryTime: new Date(Date.now() - 600000),
        entryCamera: 'cam-floor1-entry',
        entryBarrier: 'barrier-floor1-entry',
        isKnown: false,
        status: 'active',
      })

      const res = await sendEvent({
        plateNumber: 'UNK 003',
        cameraId: 'cam-floor1-exit',
        direction: 'exit',
      })
      expect(res.statusCode).toBe(200)
      expect(mockControlDoor).toHaveBeenCalledWith('barrier-floor1-exit', 1, 1)

      const session = await VehicleSession.findOne({ plate: 'UNK 003' })
      expect(session.status).toBe('exited')
      expect(session.chargeAmount).toBe(0)
    })

    it('BLOCKS exit for unpaid vehicle past grace period', async () => {
      await VehicleSession.create({
        plate: 'UNK 004',
        entryTime: new Date(Date.now() - 7200000),
        entryCamera: 'cam-floor1-entry',
        entryBarrier: 'barrier-floor1-entry',
        isKnown: false,
        status: 'active',
      })

      const res = await sendEvent({
        plateNumber: 'UNK 004',
        cameraId: 'cam-floor1-exit',
        direction: 'exit',
      })
      expect(res.statusCode).toBe(200)
      expect(mockControlDoor).not.toHaveBeenCalled()

      const session = await VehicleSession.findOne({ plate: 'UNK 004' })
      expect(session.status).toBe('unpaid')
      expect(session.chargeAmount).toBeGreaterThan(0)
    })
  })

  describe('Edge cases', () => {
    it('handles HikCentral array format', async () => {
      const payload = {
        events: [{
          eventData: {
            eventType: 'ANPR_VEHICLE_DETECTED',
            eventTime: new Date().toISOString(),
            plateNumber: 'ARR 001',
            cameraId: 'cam-floor1-entry',
            direction: 'entry',
          },
        }],
      }

      const res = await app.inject({ method: 'POST', url: '/eventsRCV', payload })
      expect(res.statusCode).toBe(200)

      const session = await VehicleSession.findOne({ plate: 'ARR 001' })
      expect(session).not.toBeNull()
    })

    it('returns ack even for missing plate number', async () => {
      const res = await sendEvent({ plateNumber: '' })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ code: '0', msg: 'success' })
    })
  })
})
