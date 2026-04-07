'use strict';

function getTodayLocal(tz = 'America/Los_Angeles') {
  const now = new Date();
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(now);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return `${weekday}, ${date}`;
}

module.exports = { getTodayLocal };
