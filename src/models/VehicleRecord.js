const { Schema, model } = require('mongoose')

const vehicleRecordSchema = new Schema({
  guid: { type: String, required: true, unique: true },
  plate: { type: String, required: true },
  vehicleType: { type: Number, default: 0 },
  parkingLotId: { type: String, required: true },
  parkingLotName: { type: String, default: '' },
  passagewayId: { type: String, default: '' },
  passagewayName: { type: String, default: '' },
  laneId: { type: String, default: '' },
  laneName: { type: String, default: '' },
  direction: { type: String, enum: ['entry', 'exit'], default: 'entry' },
  enterTime: { type: Date },
  exitTime: { type: Date },
  imageUrl: { type: String, default: '' },
  ownerName: { type: String, default: '' },
  ownerPhone: { type: String, default: '' },
  allowed: { type: Boolean, default: true },
  syncedAt: { type: Date, default: Date.now },
})

vehicleRecordSchema.index({ plate: 1, enterTime: -1 })
vehicleRecordSchema.index({ parkingLotId: 1 })

module.exports = { VehicleRecord: model('VehicleRecord', vehicleRecordSchema) }
