const mongoose = require('mongoose')
const config = require('./index')
const { logger } = require('../utils/logger')

async function connectMongo() {
  if (mongoose.connection.readyState !== 0) return
  await mongoose.connect(config.mongodb.uri)
  logger.info('Connected to MongoDB')
}

module.exports = { connectMongo }
