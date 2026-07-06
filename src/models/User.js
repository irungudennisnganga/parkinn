const { Schema, model } = require('mongoose')

const userSchema = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true },
  fullName: { type: String, required: true },
  role: { type: String, enum: ['admin', 'operator'], default: 'operator' },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
})

module.exports = { User: model('User', userSchema) }
