const { Schema, model } = require('mongoose')

const barrierLogSchema = new Schema({
  barrierId: { type: String, required: true, index: true },
  barrierName: { type: String, default: '' },
  action: { type: String, enum: ['open', 'close'], required: true },
  method: { type: String, default: 'manual' },
  triggeredBy: { type: String, default: 'admin' },
  plate: { type: String, default: '' },
  cameraId: { type: String, default: '' },
  success: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now, index: true },
})

module.exports = { BarrierLog: model('BarrierLog', barrierLogSchema) }
