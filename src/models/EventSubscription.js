const { Schema, model } = require('mongoose')

const eventSubscriptionSchema = new Schema({
  eventTypes: { type: [Number], required: true },
  eventDest: { type: String, required: true },
  status: { type: String, enum: ['active', 'failed'], default: 'active' },
  subscribedAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
})

module.exports = { EventSubscription: model('EventSubscription', eventSubscriptionSchema) }
