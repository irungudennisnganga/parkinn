const axios = require('axios')
const config = require('../config')
const { logger } = require('../utils/logger')
const { Token } = require('../models/Token')

class HikCentralClient {
  constructor() {
    this.client = axios.create({
      baseURL: config.hikcentral.baseUrl,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  async getToken() {
    const cached = await Token.findOne().sort({ expiresAt: -1 })
    const FIVE_MIN_MS = 5 * 60 * 1000
    if (cached && cached.expiresAt > new Date(Date.now() + FIVE_MIN_MS)) {
      return cached.token
    }

    const body = {
      appKey: config.hikcentral.accessKey,
      secretKey: config.hikcentral.secretKey,
    }

    try {
      const res = await this.client.post('/api/hccgw/platform/v1/token/get', body)
      const data = res.data?.data
      if (!data?.accessToken) throw new Error('No accessToken in response')

      const expireTimeMs = Number(data.expireTime) * 1000

      await Token.create({
        token: data.accessToken,
        expiresAt: new Date(expireTimeMs),
      })

      logger.info('HikCentral token refreshed')
      return data.accessToken
    } catch (err) {
      logger.error({ err: err.message }, 'Failed to get HikCentral token')
      throw err
    }
  }

  async request(method, url, data) {
    const token = await this.getToken()
    const res = await this.client.request({ method, url, data, headers: { Token: token } })
    return res.data
  }

  getAreas() {
    return this.request('POST', '/api/hccgw/resource/v1/areas/get', {
      pageNo: 1,
      pageSize: 200,
    })
  }

  getCameras(areaId) {
    return this.request('POST', '/api/hccgw/resource/v1/areas/cameras/get', {
      areaId,
      pageNo: 1,
      pageSize: 200,
    })
  }

  getDoors(areaId) {
    return this.request('POST', '/api/hccgw/resource/v1/areas/doors/get', {
      areaId,
      pageNo: 1,
      pageSize: 200,
    })
  }

  controlBarrier(cameraId, controlMode) {
    return this.request('POST', '/api/hccgw/bi/v1/anpr/barrierGate/control', {
      cameraId,
      controlMode,
    })
  }

  searchPassingRecords(params) {
    return this.request('POST', '/api/hccgw/bi/v1/anpr/passing/record/search', params)
  }

  // Webhook configuration (OpenAPI V2.15.0)
  configureWebhook(callbackUrl, signSecret, retryTimes = 3) {
    return this.request('POST', '/api/hccgw/webhook/v1/config/save', {
      callbackUrl,
      signSecret,
      retryTimes,
      retryDelay: 5000,
    })
  }

  // Subscribe to alarm messages
  subscribeAlarms(eventTypes = []) {
    return this.request('POST', '/api/hccgw/alarm/v1/mq/subscribe', {
      subscribeType: 1,
      subscribeMode: eventTypes.length > 0 ? 1 : 0,
      eventType: eventTypes,
    })
  }

  // Subscribe to raw messages (on-board device events)
  subscribeRawMessages(msgTypes = []) {
    return this.request('POST', '/api/hccgw/rawmsg/v1/mq/subscribe', {
      subscribeType: 1,
      msgType: msgTypes,
    })
  }

  // Subscribe to combined events (ANPR plate reads, custom events)
  subscribeCombineEvents(eventTypes = []) {
    return this.request('POST', '/api/hccgw/combine/v1/mq/subscribe', {
      subscribeType: 1,
      subscribeMode: eventTypes.length > 0 ? 1 : 0,
      eventType: eventTypes,
    })
  }
}

module.exports = { HikCentralClient }
