const mockControlDoor = jest.fn().mockResolvedValue({ code: '0', msg: 'Success' })
const mockControlAlarm = jest.fn().mockRejectedValue(new Error('not available'))

const mockBarrierGateControl = jest.fn().mockRejectedValue(new Error('not available'))

const mockCalculateParkingFee = jest.fn().mockResolvedValue({
  code: '0',
  msg: 'Success',
  data: {
    plateLicense: 'TEST',
    parkingInTime: '2026-06-29T20:00:00+03:00',
    parkingDuration: 7200,
    feeRuleType: 0,
    feeRuleIndexCode: '1',
    feeRuleName: 'default',
    fee: '300.00',
  },
})

const mockConfirmParkingFee = jest.fn().mockResolvedValue({ code: '0', msg: 'Success' })

class HikCentralClient {
  constructor() {
    this.barrierGateControl = mockBarrierGateControl
    this.controlDoor = mockControlDoor
    this.controlAlarmOutput = mockControlAlarm
    this.calculateParkingFee = mockCalculateParkingFee
    this.confirmParkingFee = mockConfirmParkingFee
    this.getRegions = jest.fn().mockResolvedValue({ data: { list: [] } })
    this.getCamerasAll = jest.fn().mockResolvedValue({ data: { list: [] } })
    this.getParkingLotList = jest.fn()
    this.getPassagewayRecords = jest.fn().mockResolvedValue({ data: { list: [] } })
    this.request = jest.fn()
    this.getVersion = jest.fn().mockResolvedValue({ data: {} })
    this.subscribeEvents = jest.fn().mockResolvedValue({ code: '0', msg: 'Success' })
  }
}

module.exports = {
  HikCentralClient,
  mockControlDoor,
  mockControlAlarm,
  mockBarrierGateControl,
  mockCalculateParkingFee,
  mockConfirmParkingFee,
}
