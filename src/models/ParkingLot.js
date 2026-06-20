const { Schema, model } = require('mongoose')

const parkingLotSchema = new Schema({
  parkingLotId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  totalSpaces: { type: Number, default: 0 },
  freeSpaces: { type: Number, default: 0 },
  parentId: { type: String, default: '' },
})

module.exports = { ParkingLot: model('ParkingLot', parkingLotSchema) }
