const mockControlBarrier = jest.fn().mockResolvedValue({ errorCode: '0' })

class HikCentralClient {
  constructor() {
    this.controlBarrier = mockControlBarrier
    this.getAreas = jest.fn().mockResolvedValue({ data: { list: [] } })
    this.getCameras = jest.fn().mockResolvedValue({ data: { list: [] } })
    this.getDoors = jest.fn().mockResolvedValue({ data: { list: [] } })
    this.getToken = jest.fn().mockResolvedValue('mock-token')
    this.request = jest.fn()
    this.searchPassingRecords = jest.fn()
    this.configureWebhook = jest.fn().mockResolvedValue({ errorCode: '0' })
    this.subscribeAlarms = jest.fn().mockResolvedValue({ errorCode: '0' })
  }
}

module.exports = { HikCentralClient, mockControlBarrier }
