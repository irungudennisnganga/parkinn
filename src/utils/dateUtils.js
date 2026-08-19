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

function hikNow() {
  const config = require('../config')
  const offset = config?.hikcentral?.timeOffsetMs || 0
  return offset ? new Date(Date.now() + offset) : new Date()
}

function hikQueryEnd() {
  const config = require('../config')
  const bufferMs = config?.hikcentral?.queryBufferMs || 120 * 60 * 1000
  return new Date(hikNow().getTime() + bufferMs)
}

function toLocalTime(dateOrString) {
  const config = require('../config')
  const offset = config?.hikcentral?.timeOffsetMs || 0
  if (!offset || !dateOrString) return new Date(dateOrString || undefined)
  return new Date(new Date(dateOrString).getTime() - offset)
}

function withServerDuration(sessions) {
  const serverNow = hikNow().getTime()
  const arr = Array.isArray(sessions) ? sessions : [sessions]
  for (const s of arr) {
    if (s && s.entryTime && !s.durationMinutes) {
      const entryMs = new Date(s.entryTime).getTime()
      s.durationMinutes = Math.max(0, Math.round((serverNow - entryMs) / 60000))
      s.serverTime = new Date(serverNow).toISOString()
    }
  }
  return sessions
}

module.exports = { minutesBetween, hoursBetween, now, addDays, isoLocal, hikNow, hikQueryEnd, toLocalTime, withServerDuration }
