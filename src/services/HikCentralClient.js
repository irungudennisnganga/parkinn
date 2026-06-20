const crypto = require('crypto')
const axios = require('axios')
const config = require('../config')
const { logger } = require('../utils/logger')

class HikCentralClient {
  constructor() {
    this.accessKey = config.hikcentral.accessKey
    this.secretKey = config.hikcentral.secretKey
    this.client = axios.create({
      baseURL: config.hikcentral.baseUrl,
      timeout: 30000,
    })
  }

  async request(tag, method, urlPath, data) {
    const signature = crypto
      .createHmac('sha256', this.secretKey)
      .update(method + '\n' + 'application/json' + '\n' + 'application/json;charset=UTF-8' + '\n' + urlPath)
      .digest('base64')

    const headers = {
      'Content-Type': 'application/json;charset=UTF-8',
      'Accept': 'application/json',
      'X-Ca-Key': this.accessKey,
      'X-Ca-Signature': signature,
    }

    logger.info({ tag, method, url: urlPath, body: data }, 'HikCentral API request')
    try {
      const res = await this.client.request({ method, url: urlPath, data, headers })
      const d = res.data
      const list = d?.data?.list
      logger.info({ tag, code: d?.code, total: d?.data?.total, listCount: list?.length, sample: list?.[0] }, 'HikCentral ok')
      return d
    } catch (err) {
      const s = err.response?.status
      const b = typeof err.response?.data === 'string' ? err.response.data.slice(0, 500) : JSON.stringify(err.response?.data)?.slice(0, 500)
      logger.error({ tag, status: s, body: b }, 'HikCentral FAILED')
      throw err
    }
  }

  // --- Basic ---
  getVersion() {
    return this.request('version', 'POST', '/artemis/api/common/v1/version', {})
  }
  getRegions(params = {}) {
    return this.request('regions', 'POST', '/artemis/api/resource/v1/regions', { pageNo: 1, pageSize: 200, ...params })
  }
  getParkingLotList() {
    return this.request('parkLot', 'POST', '/artemis/api/vehicle/v1/parkinglot/list', {})
  }

  // --- Cameras ---
  getCamerasAll() {
    return this.request('camAll', 'POST', '/artemis/api/resource/v1/cameras', { pageNo: 1, pageSize: 200 })
  }

  // --- Passageway records (barriers + vehicle passes) ---
  getPassagewayRecords(parkingLotIndexCode, beginTime, endTime) {
    return this.request('passRec', 'POST', '/artemis/api/vehicle/v1/parkinglot/passageway/record', {
      pageIndex: 1,
      pageSize: 200,
      queryInfo: {
        parkingLotIndexCode,
        beginTime,
        endTime,
        directionType: -1,
      },
    })
  }

  // --- Barrier control ---
  controlDoor(doorIndexCode, controlType, controlDirection) {
    const body = { doorIndexCodes: [doorIndexCode], controlType }
    if (controlDirection !== undefined) body.controlDirection = controlDirection
    return this.request('doorCtrl', 'POST', '/artemis/api/acs/v1/door/doControl', body)
  }

  confirmParkingFee(plateLicense) {
    return this.request('parkFee', 'POST', '/artemis/api/vehicle/v1/parkingfee/confirm', {
      plateLicense, immediatelyLeave: 1, fee: '0',
    })
  }

  calculateParkingFee(plateLicense) {
    return this.request('parkCalc', 'POST', '/artemis/api/vehicle/v1/parkingfee/calculate', {
      plateLicense,
    })
  }

  getAlarmOutputs(deviceType) {
    const body = { pageNo: 1, pageSize: 200 }
    if (deviceType) body.deviceType = deviceType
    return this.request('alarmOut', 'POST', '/artemis/api/resource/v1/alarmOutputs', body)
  }

  controlAlarmOutput(alarmOutputIndexCode, action) {
    return this.request('alarmCtrl', 'POST', '/artemis/api/resource/v1/alarmOutput/controlling', {
      alarmOutputIndexCode,
      action,
    })
  }

  // --- Events ---
  subscribeEvents(eventTypes, eventDest) {
    return this.request('evSub', 'POST', '/artemis/api/eventService/v1/eventSubscriptionByEventTypes', {
      eventTypes, eventDest, passBack: 1,
    })
  }

  unsubscribeEvents(eventTypes) {
    return this.request('evUnsub', 'POST', '/artemis/api/eventService/v1/eventUnSubscriptionByEventTypes', {
      eventTypes,
    })
  }

  getEventSubscriptionView() {
    return this.request('evView', 'POST', '/artemis/api/eventService/v1/eventSubscriptionView', {})
  }
}

module.exports = { HikCentralClient }
