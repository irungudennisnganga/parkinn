const { createApp } = require('../src/index')
const { seedData, clearData } = require('./helpers')
const { startMongo, stopMongo } = require('./setup')
const mongoose = require('mongoose')

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

describe('GET /health', () => {
  it('returns status ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.status).toBe('ok')
    expect(body.timestamp).toBeDefined()
  })
})
