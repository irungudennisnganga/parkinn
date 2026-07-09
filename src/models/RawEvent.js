const { Schema, model } = require('mongoose')

const rawEventSchema = new Schema({
  body: { type: Schema.Types.Mixed },
  format: { type: String, default: 'unknown' },
  plate: { type: String, default: '' },
  cameraId: { type: String, default: '' },
  cameraName: { type: String, default: '' },
  direction: { type: String, default: '' },
  eventTime: { type: String, default: '' },
  action: { type: String, default: '' },
  reason: { type: String, default: '' },
  sessionId: { type: String, default: '' },
  processed: { type: Boolean, default: false },
  receivedAt: { type: Date, default: Date.now },
})

rawEventSchema.index({ receivedAt: -1 })
rawEventSchema.index({ plate: 1, receivedAt: -1 })
rawEventSchema.index({ processed: 1 })

module.exports = { RawEvent: model('RawEvent', rawEventSchema) }
