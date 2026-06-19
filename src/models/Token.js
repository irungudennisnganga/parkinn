const { Schema, model } = require('mongoose')

const tokenSchema = new Schema({
  token: { type: String, required: true },
  expiresAt: { type: Date, required: true },
})

module.exports = { Token: model('Token', tokenSchema) }
