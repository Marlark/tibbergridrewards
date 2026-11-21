'use strict';

/**
 * Home battery details from Tibber's app API (HTTP POST /v4/gql), polled every 5 min.
 * The query is the same as the Home Assistant integration
 * JohNan/homeassistant-tibber_grid_rewards (battery_blocks.py / query_blocks.py).
 * Pure functions: no Homey dependency, so they can be tested.
 */

const POLL_MS = 5 * 60 * 1000;
const PLANNED_POWER_THRESHOLD_W = 100;

const BATTERY_QUERY = `
query GetBatteryDetails($homeId: String!, $deviceId: String!, $activityFrom: DateTime!, $activityTo: DateTime!, $timelineFrom: DateTime!, $timelineTo: DateTime!, $resolution: BatteryTimelineResolution!) {
  me {
    home(id: $homeId) {
      battery(id: $deviceId) {
        aggregatedHistory {
          periods {
            key
            batteryValueItems {
              value
              unit
              kind
            }
          }
        }
      }
      batteryActivityHistory(id: $deviceId, from: $activityFrom, to: $activityTo) {
        items {
          from
          to
          reason {
            __typename
          }
          secondaryReason {
            __typename
          }
        }
      }
      batteryTimeline(
        id: $deviceId,
        from: $timelineFrom,
        to: $timelineTo,
        resolution: $resolution
      ) {
        energyFlow {
          items {
            kind
            time
            charged
            discharged
          }
        }
        stateOfCharge {
          items {
            kind
            time
            stateOfCharge
          }
        }
      }
    }
  }
}`;

/** "YYYY-MM-DDTHH:MM:SSZ" in UTC, as the API expects. */
function isoSeconds(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * dayStart (local midnight, optional): also fetch today's activity and actual
 * energy from midnight, for the battery's day (#29, #48).
 */
function batteryVariables({
  homeId, batteryId, now, dayStart = null,
}) {
  const tomorrow = new Date(now + 24 * 3600 * 1000);
  tomorrow.setUTCHours(23, 59, 59, 0);
  const sixHoursAgo = now - 6 * 3600 * 1000;
  return {
    homeId,
    deviceId: batteryId,
    activityFrom: isoSeconds(dayStart === null ? sixHoursAgo : Math.min(sixHoursAgo, dayStart)),
    activityTo: isoSeconds(now + 3600 * 1000),
    timelineFrom: isoSeconds(dayStart === null ? now : dayStart),
    timelineTo: isoSeconds(tomorrow.getTime()),
    resolution: 'QUARTER_HOURLY',
  };
}

/**
 * The battery's plan from the timeline: one point per quarter,
 * { time, soc (percent or null), powerW (+ charging, - discharging), forecast }, sorted by time.
 */
function parsePlan(timeline) {
  const points = new Map();
  const at = (time) => {
    if (!points.has(time)) points.set(time, { time, soc: null, powerW: 0, forecast: true });
    return points.get(time);
  };
  for (const i of (timeline && timeline.energyFlow && timeline.energyFlow.items) || []) {
    if (!i || !i.time) continue;
    const p = at(i.time);
    p.powerW = Math.round((i.charged || 0) - (i.discharged || 0));
    if (i.kind === 'ACTUAL') p.forecast = false;
  }
  for (const i of (timeline && timeline.stateOfCharge && timeline.stateOfCharge.items) || []) {
    if (!i || !i.time || typeof i.stateOfCharge !== 'number') continue;
    const p = at(i.time);
    p.soc = Math.round(i.stateOfCharge * 10) / 10;
    if (i.kind === 'ACTUAL') p.forecast = false;
  }
  return [...points.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

function savingsFor(periods, key) {
  const period = (periods || []).find((p) => p && p.key === key);
  const total = period && (period.batteryValueItems || []).find((i) => i && i.kind === 'TOTAL');
  return total && typeof total.value === 'number' ? { value: total.value, unit: total.unit || '' } : null;
}

/** 'HomeBatteryChargingForGridRewards' -> 'ChargingForGridRewards' */
function activityCode(typename) {
  return typename ? String(typename).replace(/^HomeBattery/, '') : '';
}

/** 'ChargingForGridRewards' -> 'Charging for grid rewards' (fallback when there is no translation) */
function humanize(code) {
  const words = code.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Parse the GetBatteryDetails response. Returns
 * { savingsToday, savingsWeek, savingsMonth, unit, activity: {code, secondary, since} | null,
 *   nextPlanned: {time, action, powerW, stateOfCharge} | null, plan: see parsePlan }
 */
function parseBattery(data, { now = null } = {}) {
  const home = data && data.me && data.me.home;
  if (!home) return null;

  const periods = home.battery && home.battery.aggregatedHistory && home.battery.aggregatedHistory.periods;
  const today = savingsFor(periods, 'TODAY');
  const week = savingsFor(periods, 'WEEK');
  const month = savingsFor(periods, 'MONTH');

  const items = (home.batteryActivityHistory && home.batteryActivityHistory.items) || [];
  const current = items.find((i) => i && !i.to) || items[items.length - 1] || null;
  const activity = current ? {
    code: activityCode(current.reason && current.reason.__typename),
    secondary: activityCode(current.secondaryReason && current.secondaryReason.__typename),
    since: current.from || null,
  } : null;

  const timeline = home.batteryTimeline || {};
  const flow = (timeline.energyFlow && timeline.energyFlow.items) || [];
  const soc = (timeline.stateOfCharge && timeline.stateOfCharge.items) || [];
  const next = flow.find((i) => i && i.kind === 'FORECAST'
    && ((i.charged || 0) >= PLANNED_POWER_THRESHOLD_W || (i.discharged || 0) >= PLANNED_POWER_THRESHOLD_W));
  let nextPlanned = null;
  if (next) {
    const charging = (next.charged || 0) >= (next.discharged || 0);
    const socItem = soc.find((s) => s && s.time === next.time);
    nextPlanned = {
      time: next.time,
      action: charging ? 'charge' : 'discharge',
      powerW: charging ? next.charged : next.discharged,
      stateOfCharge: socItem && typeof socItem.stateOfCharge === 'number'
        ? Math.round(socItem.stateOfCharge * 10) / 10 : null,
    };
  }

  return {
    savingsToday: today ? today.value : null,
    savingsWeek: week ? week.value : null,
    savingsMonth: month ? month.value : null,
    unit: (today || month || week || {}).unit || '',
    activity,
    nextPlanned,
    // The plan from the current quarter on (the timeline may start at midnight).
    plan: parsePlan(timeline).filter((p) => now === null || Date.parse(p.time) + 15 * 60 * 1000 > now),
    // For the battery's day (lib/batteryDay.js).
    intervals: items.filter((i) => i && i.from).map((i) => ({
      from: i.from, to: i.to || null, code: activityCode(i.reason && i.reason.__typename),
    })),
    actual: flow.filter((i) => i && i.kind === 'ACTUAL' && i.time)
      .map((i) => ({ time: i.time, charged: i.charged || 0, discharged: i.discharged || 0 })),
  };
}

module.exports = {
  POLL_MS,
  BATTERY_QUERY,
  batteryVariables,
  parseBattery,
  parsePlan,
  activityCode,
  humanize,
  isoSeconds,
};
