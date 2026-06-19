const { Schema, model } = require('mongoose')

const barrierSchema = new Schema({
  barrierId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  areaId: { type: String, required: true },
  cameraId: { type: String, required: true },
  direction: { type: String, enum: ['entry', 'exit'], default: 'entry' },
})

module.exports = { Barrier: model('Barrier', barrierSchema) }
