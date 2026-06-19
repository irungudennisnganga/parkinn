const { Schema, model } = require('mongoose')

const chargeRateSchema = new Schema({
  floorId: { type: String, required: true },
  ratePerHr: { type: Number, default: 100 },
  flatRate: { type: Number, default: 0 },
  gracePeriod: { type: Number, default: 15 },
  maxDaily: { type: Number, default: 1000 },
})

module.exports = { ChargeRate: model('ChargeRate', chargeRateSchema) }
