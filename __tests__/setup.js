const { MongoMemoryServer } = require('mongodb-memory-server')
const mongoose = require('mongoose')

let mongod

async function startMongo() {
  mongod = await MongoMemoryServer.create()
  const uri = mongod.getUri()
  process.env.MONGODB_URI = uri
  await mongoose.connect(uri)
}

async function stopMongo() {
  await mongoose.disconnect()
  if (mongod) await mongod.stop()
}

module.exports = { startMongo, stopMongo }
