const { Schema, model } = require('mongoose')

const areaSchema = new Schema({
  areaId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  parentId: { type: String, default: '' },
  areaType: { type: String, enum: ['commercial', 'residential'], required: true },
})

module.exports = { Area: model('Area', areaSchema) }
