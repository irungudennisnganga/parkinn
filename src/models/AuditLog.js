const { Schema, model } = require('mongoose')

const auditLogSchema = new Schema({
  userId: { type: String, default: '' },
  userEmail: { type: String, default: '' },
  action: { type: String, required: true },
  resource: { type: String, default: '' },
  details: { type: String, default: '' },
  ip: { type: String, default: '' },
  status: { type: String, enum: ['success', 'failure'], default: 'success' },
  timestamp: { type: Date, default: Date.now },
})

auditLogSchema.index({ timestamp: -1 })
auditLogSchema.index({ userId: 1 })
auditLogSchema.index({ action: 1 })

module.exports = { AuditLog: model('AuditLog', auditLogSchema) }
