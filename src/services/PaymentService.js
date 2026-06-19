const axios = require('axios')
const config = require('../config')
const { logger } = require('../utils/logger')

async function initiateStkPush(phoneNumber, amount, plate) {
  try {
    const token = await getMpesaToken()
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)
    const password = Buffer.from(
      `${config.mpesa.shortCode}${config.mpesa.passkey}${timestamp}`
    ).toString('base64')

    const payload = {
      BusinessShortCode: config.mpesa.shortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(amount),
      PartyA: phoneNumber,
      PartyB: config.mpesa.partyB,
      PhoneNumber: phoneNumber,
      CallBackURL: config.mpesa.callbackUrl,
      AccountReference: plate,
      TransactionDesc: `Parking payment for ${plate}`,
    }

    const res = await axios.post(
      'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    )

    return res.data
  } catch (err) {
    logger.error({ err: err.message, plate }, 'M-Pesa STK push failed')
    return null
  }
}

async function getMpesaToken() {
  const auth = Buffer.from(
    `${config.mpesa.consumerKey}:${config.mpesa.consumerSecret}`
  ).toString('base64')

  const res = await axios.get(
    'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
    { headers: { Authorization: `Basic ${auth}` } }
  )

  return res.data.access_token
}

module.exports = { initiateStkPush }
