const mockControlDoor = jest.fn().mockResolvedValue({ code: '0', msg: 'Success' })
const mockControlAlarm = jest.fn().mockRejectedValue(new Error('not available'))

class HikCentralClient {
  constructor() {
    this.controlDoor = mockControlDoor
    this.controlAlarmOutput = mockControlAlarm
    this.getRegions = jest.fn().mockResolvedValue({ data: { list: [] } })
    this.getCamerasAll = jest.fn().mockResolvedValue({ data: { list: [] } })
    this.getParkingLotList = jest.fn()
    this.getPassagewayRecords = jest.fn().mockResolvedValue({ data: { list: [] } })
    this.request = jest.fn()
    this.getVersion = jest.fn().mockResolvedValue({ data: {} })
    this.subscribeEvents = jest.fn().mockResolvedValue({ code: '0', msg: 'Success' })
  }
}

module.exports = { HikCentralClient, mockControlDoor, mockControlAlarm }
