'use strict';

function getTodayLocal(tz = 'America/Los_Angeles') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function getTodayWithDay(tz = 'America/Los_Angeles') {
  const now = new Date();
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
  const dayName = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long'
  }).format(now);
  return { date, dayName };
}

module.exports = { getTodayLocal, getTodayWithDay };
