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

function isoLocal(date) {
  const d = date || new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const sign = d.getTimezoneOffset() <= 0 ? '+' : '-'
  const off = Math.abs(d.getTimezoneOffset())
  const offH = pad(Math.floor(off / 60))
  const offM = pad(off % 60)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${offH}:${offM}`
}

module.exports = { minutesBetween, hoursBetween, now, addDays, isoLocal }
