const { createApp } = require('../src/index')
const { seedData, clearData } = require('./helpers')
const { startMongo, stopMongo } = require('./setup')
const mongoose = require('mongoose')
const { VehicleSession } = require('../src/models/VehicleSession')
const { mockControlBarrier } = require('../src/services/HikCentralClient')

jest.mock('../src/services/HikCentralClient')

let app

beforeAll(async () => {
  await startMongo()
  app = await createApp()
  await seedData()
})

beforeEach(async () => {
  mockControlBarrier.mockClear()
  await VehicleSession.deleteMany({})
})

afterAll(async () => {
  await clearData()
  await app.close()
  await stopMongo()
})

describe('POST /mpesa/callback', () => {
  beforeEach(async () => {
    await VehicleSession.create({
      plate: 'KXX 999Z',
      entryTime: new Date(Date.now() - 7200000),
      entryCamera: 'cam-floor1-entry',
      entryBarrier: 'barrier-floor1-entry',
      exitCamera: 'cam-floor1-exit',
      isKnown: false,
      chargeAmount: 200,
      status: 'unpaid',
    })
  })

  it('reconciles payment and opens exit barrier on successful callback', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mpesa/callback',
      payload: {
        Body: {
          stkCallback: {
            MerchantRequestID: 'MR-001',
            CheckoutRequestID: 'CR-001',
            ResultCode: 0,
            ResultDesc: 'Success',
            CallbackMetadata: {
              Item: [
                { Name: 'Amount', Value: 200 },
                { Name: 'MpesaReceiptNumber', Value: 'NLA1234567' },
                { Name: 'TransactionDate', Value: 20260616123000 },
                { Name: 'PhoneNumber', Value: 254712345678 },
              ],
            },
            AccountReference: 'KXX 999Z',
          },
        },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).ResultCode).toBe(0)

    const session = await VehicleSession.findOne({ plate: 'KXX 999Z' })
    expect(session.status).toBe('exited')
    expect(session.paymentRef).toBe('NLA1234567')
    expect(mockControlBarrier).toHaveBeenCalled()
  })

  it('does nothing on failed payment callback', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mpesa/callback',
      payload: {
        Body: {
          stkCallback: {
            MerchantRequestID: 'MR-002',
            CheckoutRequestID: 'CR-002',
            ResultCode: 1,
            ResultDesc: 'Insufficient balance',
            CallbackMetadata: { Item: [] },
            AccountReference: 'KXX 999Z',
          },
        },
      },
    })

    expect(res.statusCode).toBe(200)
    const session = await VehicleSession.findOne({ plate: 'KXX 999Z' })
    expect(session.status).toBe('unpaid')
    expect(mockControlBarrier).not.toHaveBeenCalled()
  })

  it('handles callback with no matching session gracefully', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mpesa/callback',
      payload: {
        Body: {
          stkCallback: {
            MerchantRequestID: 'MR-003',
            CheckoutRequestID: 'CR-003',
            ResultCode: 0,
            ResultDesc: 'Success',
            CallbackMetadata: {
              Item: [
                { Name: 'Amount', Value: 100 },
                { Name: 'MpesaReceiptNumber', Value: 'NLA9999999' },
              ],
            },
            AccountReference: 'NONEXISTENT',
          },
        },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).ResultCode).toBe(0)
  })
})
