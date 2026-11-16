'use strict';

/**
 * Pure logic (no Homey dependency, so it can be tested) that derives
 * "today" and "current session" from Tibber's rewardCurrentMonth.
 *
 * State is persisted per device (in the device store), so several
 * homes/accounts never share counters. That was the bug in the HA integration.
 *
 * state = {
 *   dayKey: '2026-11-16',     // local date that dayStart applies to
 *   dayStart: 12.34,          // month figure at the start of the day
 *   lastMonth: 15.00,         // last seen month figure
 *   monthKey: '2026-11',      // calendar month that lastMonth belongs to
 *   session: null | { startedAt: ms, startMonth: number },
 * }
 */

const STATE_MAP = {
  GridRewardAvailable: 'available',
  GridRewardUnavailable: 'unavailable',
  GridRewardDelivering: 'delivering',
};

function mapState(typename) {
  return STATE_MAP[typename] || 'unknown';
}

function reasonOf(stateObj) {
  if (!stateObj) return '';
  if (Array.isArray(stateObj.reasons) && stateObj.reasons.length) return stateObj.reasons.join(', ');
  return stateObj.reason || stateObj.kind || '';
}

/** Turn a raw gridRewardStatus object into the values the app uses. */
function parseStatus(status) {
  const state = status && status.state;
  const num = (v) => (typeof v === 'number' ? v : null);
  return {
    gridState: mapState(state && state.__typename),
    reason: reasonOf(state),
    month: num(status && status.rewardCurrentMonth),
    allTime: num(status && status.rewardAllTime),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Roll over the day if dayKey has changed. Also called by a timer at midnight. */
function rollDay(state, dayKey) {
  const s = { ...state };
  if (s.dayKey !== dayKey) {
    s.dayKey = dayKey;
    s.dayStart = typeof s.lastMonth === 'number' ? s.lastMonth : null;
  }
  return s;
}

/**
 * Apply a new month figure + status. Returns { state, today, sessionReward, events[] }
 * where events can be {type:'session_started'} / {type:'session_ended', reward, minutes}.
 */
function applyUpdate(prev, { month, gridState, dayKey, now }) {
  let s = rollDay(prev || {}, dayKey);
  const events = [];

  if (typeof month === 'number') {
    const calMonth = dayKey.slice(0, 7); // 'YYYY-MM'
    if (typeof s.lastMonth === 'number' && month < s.lastMonth) {
      // monthKey = the calendar month that lastMonth belongs to. It only advances
      // when a reset is actually seen, so a reset Tibber sends a while after
      // midnight is still detected. (Old state without monthKey: any drop = reset.)
      const isNewMonth = s.monthKey === undefined || s.monthKey !== calMonth;
      if (isNewMonth) {
        // New month: Tibber resets rewardCurrentMonth to (roughly) 0.
        s.dayStart = 0;
        if (s.session) s.session = { ...s.session, startMonth: 0 };
        s.monthKey = calMonth;
      } else {
        // Downward correction within the month: keep the bases, only make sure
        // today/session never go negative.
        if (typeof s.dayStart === 'number' && s.dayStart > month) s.dayStart = month;
        if (s.session && s.session.startMonth > month) {
          s.session = { ...s.session, startMonth: month };
        }
      }
    }
    if (s.monthKey === undefined) s.monthKey = calMonth;
    if (s.dayStart === null || s.dayStart === undefined) s.dayStart = month;
    s.lastMonth = month;
  }

  const delivering = gridState === 'delivering';
  if (delivering && !s.session) {
    s.session = { startedAt: now, startMonth: s.lastMonth ?? 0 };
    events.push({ type: 'session_started' });
  } else if (!delivering && s.session) {
    const reward = round2((s.lastMonth ?? 0) - s.session.startMonth);
    const minutes = Math.round((now - s.session.startedAt) / 60000);
    s.lastSession = { reward, minutes, endedAt: now };
    s.session = null;
    events.push({ type: 'session_ended', reward, minutes });
  }

  const today = typeof s.lastMonth === 'number' ? round2(s.lastMonth - (s.dayStart ?? s.lastMonth)) : null;
  const sessionReward = s.session ? round2((s.lastMonth ?? 0) - s.session.startMonth) : 0;

  return { state: s, today, sessionReward, events };
}

/** Local date as YYYY-MM-DD in the given IANA time zone. */
function localDayKey(date, timeZone) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

module.exports = {
  mapState, reasonOf, parseStatus, rollDay, applyUpdate, localDayKey,
};
