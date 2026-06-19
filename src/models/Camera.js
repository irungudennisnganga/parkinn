const { Schema, model } = require('mongoose')

const cameraSchema = new Schema({
  cameraId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  areaId: { type: String, required: true },
  cameraType: { type: String, default: 'ANPR' },
  indexCode: { type: String },
  direction: { type: String, enum: ['entry', 'exit', 'both'], default: 'entry' },
})

module.exports = { Camera: model('Camera', cameraSchema) }
