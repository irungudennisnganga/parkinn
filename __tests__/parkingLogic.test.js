const { calculateCharge } = require('../src/services/ParkingLogic')
const { seedData, clearData } = require('./helpers')
const { startMongo, stopMongo } = require('./setup')
const config = require('../src/config')

beforeAll(async () => {
  await startMongo()
  await seedData()
})

afterAll(async () => {
  await clearData()
  await stopMongo()
})

describe('calculateCharge', () => {
  it('returns 0 within grace period', async () => {
    const entry = new Date(Date.now() - 600000)
    const exit = new Date()
    const result = await calculateCharge(entry, exit, 'cam-floor1-entry')
    expect(result.amount).toBe(0)
    expect(result.rateDescription).toContain('grace')
  })

  it('calculates hourly charge past grace period', async () => {
    const entry = new Date(Date.now() - 7200000)
    const exit = new Date()
    const result = await calculateCharge(entry, exit, 'cam-floor1-entry')
    expect(result.amount).toBe(200)
    expect(result.rateDescription).toContain('KES 100')
  })

  it('caps at maxDaily', async () => {
    const entry = new Date(Date.now() - 3600000 * 24)
    const exit = new Date()
    const result = await calculateCharge(entry, exit, 'cam-floor1-entry')
    expect(result.amount).toBe(1000)
  })

  it('uses default config rates when no ChargeRate exists for camera area', async () => {
    const entry = new Date(Date.now() - 3600000)
    const exit = new Date()
    const result = await calculateCharge(entry, exit, 'cam-floor5-entry')
    expect(result.amount).toBe(config.payment.defaultRatePerHour)
  })
})
