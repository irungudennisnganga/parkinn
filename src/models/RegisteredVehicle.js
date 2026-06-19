const { Schema, model } = require('mongoose')

const registeredVehicleSchema = new Schema({
  plate: { type: String, required: true, unique: true, uppercase: true },
  ownerName: { type: String, required: true },
  unitNumber: { type: String, required: true },
  phoneNumber: { type: String, required: true },
  floorAccess: [{ type: Number }],
  isActive: { type: Boolean, default: true },
})

module.exports = { RegisteredVehicle: model('RegisteredVehicle', registeredVehicleSchema) }
