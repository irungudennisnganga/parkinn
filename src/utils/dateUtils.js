function minutesBetween(a, b) {
  return Math.abs(b.getTime() - a.getTime()) / 60000
}

function hoursBetween(a, b) {
  return minutesBetween(a, b) / 60
}

function now() {
  return new Date()
}

function addDays(date, days) {
  const result = new Date(date)
  result.setDate(result.getDate() + days)
  return result
}

module.exports = { minutesBetween, hoursBetween, now, addDays }
