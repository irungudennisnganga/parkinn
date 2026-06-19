const { Schema, model } = require('mongoose')

const vehicleSessionSchema = new Schema({
  plate: { type: String, required: true, index: true },
  entryTime: { type: Date, required: true },
  exitTime: { type: Date },
  entryCamera: { type: String, required: true },
  exitCamera: { type: String },
  entryBarrier: { type: String, required: true },
  exitBarrier: { type: String },
  isKnown: { type: Boolean, default: false },
  chargeAmount: { type: Number, default: 0 },
  chargeRate: { type: String, default: '' },
  paymentRef: { type: String, default: '' },
  status: {
    type: String,
    enum: ['active', 'paid', 'unpaid', 'exited'],
    default: 'active',
  },
})

module.exports = { VehicleSession: model('VehicleSession', vehicleSessionSchema) }
