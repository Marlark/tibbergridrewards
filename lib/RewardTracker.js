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
 *   pending: null | { startedAt, endedAt, startMonth, endMonth },  // ended, awaiting settlement
 * }
 */

// How long to wait for Tibber's settlement after a session ends. Real data: ~40 s.
const SETTLE_MS = 3 * 60 * 1000;

const STATE_MAP = {
  GridRewardAvailable: 'available',
  GridRewardUnavailable: 'unavailable',
  GridRewardDelivering: 'delivering',
};

function mapState(typename) {
  return STATE_MAP[typename] || 'unknown';
}

/** Reason codes of a GridRewardState, e.g. ['excess'] or ['noVehiclesPluggedIn']. */
function reasonCodesOf(stateObj) {
  if (!stateObj) return [];
  if (Array.isArray(stateObj.reasons) && stateObj.reasons.length) return stateObj.reasons.map(String);
  const one = stateObj.reason || stateObj.kind;
  return one ? [String(one)] : [];
}

function reasonOf(stateObj) {
  return reasonCodesOf(stateObj).join(', ');
}

/** Turn a raw gridRewardStatus object into the values the app uses. */
function parseStatus(status) {
  const state = status && status.state;
  const num = (v) => (typeof v === 'number' ? v : null);
  return {
    gridState: mapState(state && state.__typename),
    reason: reasonOf(state),
    reasonCodes: reasonCodesOf(state),
    currency: (status && typeof status.rewardCurrency === 'string' && status.rewardCurrency) || null,
    month: num(status && status.rewardCurrentMonth),
    allTime: num(status && status.rewardAllTime),
  };
}

/** Turn one entry of gridRewardStatus.flexDevices (car or battery) into app values. */
function parseFlex(flex) {
  const bool = (v) => (typeof v === 'boolean' ? v : null);
  const state = flex && flex.state;
  return {
    id: (flex && (flex.vehicleId || flex.batteryId)) || null,
    kind: flex && flex.kind === 'battery' ? 'battery' : 'vehicle',
    name: (flex && (flex.shortName || flex.make)) || '',
    make: (flex && flex.make) || '',
    gridState: mapState(state && state.__typename),
    reasonCodes: reasonCodesOf(state),
    pluggedIn: bool(flex && flex.isPluggedIn),
    smartEnabled: bool(flex && (flex.isSmartChargingEnabled ?? flex.isSmartModeEnabled)),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Roll over the day if dayKey has changed. Returns { state, events } where events
 * holds a {type:'day_ended', date, reward, sessions, minutes} summary of the day
 * that just ended. Also called by a timer at midnight.
 */
function rollDayEvents(state, dayKey) {
  const s = { ...state };
  const events = [];
  if (s.dayKey !== dayKey) {
    if (s.dayKey && typeof s.lastMonth === 'number' && typeof s.dayStart === 'number') {
      const stats = s.dayStats || { sessions: 0, minutes: 0 };
      s.lastDay = {
        date: s.dayKey,
        reward: round2(Math.max(0, s.lastMonth - s.dayStart)),
        sessions: stats.sessions,
        minutes: stats.minutes,
      };
      events.push({ type: 'day_ended', ...s.lastDay });
      // New calendar month: summary of the month that ended. rewardCurrentMonth still
      // holds that month's total here (Tibber resets it later).
      const oldMonth = s.dayKey.slice(0, 7);
      if (oldMonth !== dayKey.slice(0, 7)) {
        const m = s.monthStats && s.monthStats.month === oldMonth ? s.monthStats : { sessions: 0, minutes: 0 };
        events.push({
          type: 'month_ended', month: oldMonth, reward: round2(s.lastMonth), sessions: m.sessions, minutes: m.minutes,
        });
      }
    }
    s.dayKey = dayKey;
    s.dayStart = typeof s.lastMonth === 'number' ? s.lastMonth : null;
    s.dayStats = { sessions: 0, minutes: 0 };
  }
  return { state: s, events };
}

/** Roll over the day if dayKey has changed (state only). */
function rollDay(state, dayKey) {
  return rollDayEvents(state, dayKey).state;
}

/** Close a pending session with the given month figure and emit session_ended. */
function finalizePending(s, settledMonth, events) {
  const p = s.pending;
  const reward = round2(Math.max(0, settledMonth - p.startMonth));
  const minutes = Math.round((p.endedAt - p.startedAt) / 60000);
  s.lastSession = {
    reward, minutes, startedAt: p.startedAt, endedAt: p.endedAt, reason: p.reason || '',
  };
  s.pending = null;
  // A session is counted in the day (and calendar month) it ends.
  const stats = s.dayStats || { sessions: 0, minutes: 0 };
  s.dayStats = { sessions: stats.sessions + 1, minutes: stats.minutes + minutes };
  const month = (s.dayKey || '').slice(0, 7);
  const m = s.monthStats && s.monthStats.month === month ? s.monthStats : { month, sessions: 0, minutes: 0 };
  s.monthStats = { month, sessions: m.sessions + 1, minutes: m.minutes + minutes };
  events.push({
    type: 'session_ended', reward, minutes, startedAt: p.startedAt, endedAt: p.endedAt, reason: p.reason || '',
    ...(p.flex ? { flex: p.flex } : {}),
  });
}

/**
 * Figures for the capabilities: last session, sessions and delivery minutes today
 * and this calendar month. dayKey is today's local date.
 */
function statsOf(state, dayKey) {
  const s = state || {};
  const today = s.dayKey === dayKey && s.dayStats ? s.dayStats : { sessions: 0, minutes: 0 };
  const month = s.monthStats && s.monthStats.month === dayKey.slice(0, 7)
    ? s.monthStats : { sessions: 0, minutes: 0 };
  return {
    lastSessionReward: s.lastSession ? s.lastSession.reward : null,
    lastSessionMinutes: s.lastSession ? s.lastSession.minutes : null,
    sessionsToday: today.sessions,
    minutesToday: today.minutes,
    sessionsMonth: month.sessions,
    minutesMonth: month.minutes,
  };
}

/**
 * Apply a new month figure + status (reason: reason code, kept for the session history). Returns { state, today, sessionReward, events[] }
 * where events can be {type:'session_started'} / {type:'session_ended', reward, minutes}.
 *
 * Tibber settles the last quarter of a session about 40 s after it ends (seen in real
 * data: +0.02–0.19 kr at hh:mm:40). So an ended session is kept as `pending` and
 * session_ended is emitted on the next increase of the month figure, or after
 * SETTLE_MS (see settle()) if nothing more arrives.
 */
function applyUpdate(prev, {
  month, gridState, dayKey, now, reason = '', flexDelivering = [],
}) {
  const { state: s, events } = rollDayEvents(prev || {}, dayKey);

  if (typeof month === 'number') {
    const calMonth = dayKey.slice(0, 7); // 'YYYY-MM'
    const prevMonth = s.lastMonth;
    if (s.pending && typeof prevMonth === 'number' && month !== prevMonth) {
      if (month > prevMonth) {
        // The settlement of the ended session.
        finalizePending(s, month, events);
        // A new session that started before the settlement arrived must not count it too.
        if (s.session && s.session.startMonth === prevMonth) {
          s.session = { ...s.session, startMonth: month };
        }
      } else {
        // Month reset or downward correction: close with what we had.
        finalizePending(s, Math.min(prevMonth, s.pending.endMonth), events);
      }
    }
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
    s.session = { startedAt: now, startMonth: s.lastMonth ?? 0, reason };
    // Cars/batteries delivering during the session (only when there are any).
    if (flexDelivering.length) s.session.flex = [...new Set(flexDelivering)];
    events.push({ type: 'session_started' });
  } else if (delivering && flexDelivering.some((id) => !(s.session.flex || []).includes(id))) {
    // A car/battery that starts delivering during the session shares in it.
    s.session = { ...s.session, flex: [...new Set([...(s.session.flex || []), ...flexDelivering])] };
  } else if (!delivering && s.session) {
    // Two sessions ended without any settlement in between: close the older one.
    if (s.pending) finalizePending(s, s.pending.endMonth, events);
    s.pending = {
      startedAt: s.session.startedAt,
      endedAt: now,
      startMonth: s.session.startMonth,
      endMonth: s.lastMonth ?? 0,
      reason: s.session.reason || '',
      ...(s.session.flex ? { flex: s.session.flex } : {}),
    };
    s.session = null;
  }

  // Waited long enough without a settlement.
  if (s.pending && now - s.pending.endedAt >= SETTLE_MS) {
    finalizePending(s, s.lastMonth ?? s.pending.endMonth, events);
  }

  const today = typeof s.lastMonth === 'number' ? round2(s.lastMonth - (s.dayStart ?? s.lastMonth)) : null;
  const sessionReward = s.session ? round2((s.lastMonth ?? 0) - s.session.startMonth) : 0;

  return { state: s, today, sessionReward, events };
}

/**
 * Called from a timer: emits session_ended for a pending session once SETTLE_MS
 * has passed without a settlement. Returns { state, events }.
 */
function settle(prev, now) {
  const s = { ...prev };
  const events = [];
  if (s.pending && now - s.pending.endedAt >= SETTLE_MS) {
    finalizePending(s, s.lastMonth ?? s.pending.endMonth, events);
  }
  return { state: s, events };
}

/** Local date as YYYY-MM-DD in the given IANA time zone. */
function localDayKey(date, timeZone) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

module.exports = {
  mapState,
  reasonOf,
  reasonCodesOf,
  parseStatus,
  parseFlex,
  rollDay,
  rollDayEvents,
  applyUpdate,
  settle,
  statsOf,
  localDayKey,
  SETTLE_MS,
};
