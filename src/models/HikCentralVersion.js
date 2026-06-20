const { Schema, model } = require('mongoose')

const hikcentralVersionSchema = new Schema({
  version: { type: String, required: true },
  platform: { type: String, default: '' },
  fetchedAt: { type: Date, default: Date.now },
})

module.exports = { HikCentralVersion: model('HikCentralVersion', hikcentralVersionSchema) }
