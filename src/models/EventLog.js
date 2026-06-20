const { Schema, model } = require('mongoose')

const eventLogSchema = new Schema({
  body: { type: Schema.Types.Mixed },
  format: { type: String, default: 'unknown' },
  processed: { type: Boolean, default: false },
  plate: { type: String, default: '' },
  cameraId: { type: String, default: '' },
  direction: { type: String, default: '' },
  receivedAt: { type: Date, default: Date.now },
})

eventLogSchema.index({ receivedAt: -1 })
eventLogSchema.index({ plate: 1 })

module.exports = { EventLog: model('EventLog', eventLogSchema) }
