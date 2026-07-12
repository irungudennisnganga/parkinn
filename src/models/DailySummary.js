const { Schema, model } = require('mongoose')

const hourlyBreakdownSchema = new Schema({
  hour: { type: Number, required: true },
  entries: { type: Number, default: 0 },
  exits: { type: Number, default: 0 },
  revenue: { type: Number, default: 0 },
}, { _id: false })

const floorBreakdownSchema = new Schema({
  floor: { type: String, required: true },
  floorType: { type: String },
  entries: { type: Number, default: 0 },
  exits: { type: Number, default: 0 },
}, { _id: false })

const dailySummarySchema = new Schema({
  date: { type: String, required: true, unique: true },
  totalEntries: { type: Number, default: 0 },
  totalExits: { type: Number, default: 0 },
  totalRevenue: { type: Number, default: 0 },
  totalPaid: { type: Number, default: 0 },
  totalUnpaid: { type: Number, default: 0 },
  knownEntries: { type: Number, default: 0 },
  unknownEntries: { type: Number, default: 0 },
  peakHour: { type: Number, default: 0 },
  hourlyBreakdown: { type: [hourlyBreakdownSchema], default: [] },
  floorBreakdown: { type: [floorBreakdownSchema], default: [] },
  snapshotAt: { type: Date, default: Date.now },
}, { timestamps: true })

module.exports = { DailySummary: model('DailySummary', dailySummarySchema) }
