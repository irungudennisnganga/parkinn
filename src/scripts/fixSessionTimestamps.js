const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') })

const { connectMongo } = require('../config/database')
const { VehicleSession } = require('../models/VehicleSession')
const config = require('../config')

async function fixSessionTimestamps(direction = 'subtract') {
  const offsetMs = config.hikcentral.timeOffsetMs
  if (!offsetMs) {
    console.log('HIKCENTRAL_TIME_OFFSET_MINUTES is 0 or not set. Nothing to fix.')
    return { fixed: 0 }
  }

  const adjustMs = direction === 'add' ? -offsetMs : offsetMs
  const label = direction === 'add' ? 'Restoring' : 'Fixing'

  console.log(`Offset: ${offsetMs}ms (${offsetMs / 60000} minutes). Direction: ${direction}`)
  console.log(`${label} active/unpaid session timestamps...`)

  const result = await VehicleSession.updateMany(
    { status: { $in: ['active', 'unpaid'] } },
    [
      {
        $set: {
          entryTime: { $subtract: ['$entryTime', adjustMs] },
          exitTime: {
            $cond: {
              if: { $ne: ['$exitTime', null] },
              then: { $subtract: ['$exitTime', adjustMs] },
              else: null,
            },
          },
          floorLog: {
            $map: {
              input: '$floorLog',
              as: 'fl',
              in: {
                $mergeObjects: [
                  '$$fl',
                  { timestamp: { $subtract: ['$$fl.timestamp', adjustMs] } },
                ],
              },
            },
          },
        },
      },
    ],
  )

  console.log(`${label} ${result.modifiedCount} sessions`)
  return { fixed: result.modifiedCount, direction }
}

async function main() {
  const dir = process.argv[2] === 'add' ? 'add' : 'subtract'
  try {
    await connectMongo()
    const result = await fixSessionTimestamps(dir)
    console.log('Done:', result)
    process.exit(0)
  } catch (err) {
    console.error('Failed:', err.message)
    process.exit(1)
  }
}

if (require.main === module) {
  main()
}

module.exports = { fixSessionTimestamps }
