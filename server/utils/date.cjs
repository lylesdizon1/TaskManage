'use strict';

function getTodayLocal(tz = 'America/Los_Angeles') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

module.exports = { getTodayLocal };
