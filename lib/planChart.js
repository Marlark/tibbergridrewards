'use strict';

/**
 * The battery plan (#15) as an SVG: planned charge level as a line, planned
 * charging/discharging per quarter as bars. Drawn here so the settings page and
 * the widget look the same. Colours come from CSS classes on the page:
 * .grid .day .soc .area .charge .discharge and text.
 *
 * points: from history.batteryPlans() ({ label, day, dayKey, soc, powerW }).
 */

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const f1 = (n) => n.toFixed(1);

/** compact: smaller chart for the widget, with fewer time labels. */
function planSvg(points, { title = '', compact = false } = {}) {
  if (!points || !points.length) return '';
  const W = compact ? 320 : 600;
  const X0 = compact ? 28 : 34;
  const X1 = W - 6;
  const Y0 = 10;
  const Y1 = compact ? 92 : 150;
  const P0 = Y1 + (compact ? 26 : 32);
  const PH = compact ? 16 : 22;
  const everyHours = compact ? 6 : 3;
  const n = points.length;
  const step = (X1 - X0) / n;
  const x = (i) => X0 + step * (i + 0.5);
  const y = (soc) => Y1 - (soc / 100) * (Y1 - Y0);
  const maxW = Math.max(...points.map((p) => Math.abs(p.powerW || 0)), 1);

  let svg = '';
  for (const v of [0, 50, 100]) {
    svg += `<line class="grid" x1="${X0}" x2="${X1}" y1="${y(v)}" y2="${y(v)}"/>`
      + `<text x="${X0 - 4}" y="${y(v) + 4}" text-anchor="end">${v}%</text>`;
  }
  svg += `<line class="grid" x1="${X0}" x2="${X1}" y1="${P0}" y2="${P0}"/>`;
  points.forEach((p, i) => {
    const edge = x(i) - step / 2;
    if (i > 0 && p.dayKey !== points[i - 1].dayKey) {
      svg += `<line class="day" x1="${f1(edge)}" x2="${f1(edge)}" y1="${Y0}" y2="${P0 + PH}"/>`
        + `<text x="${f1(edge + 3)}" y="${Y0 + 8}">${esc(p.day)}</text>`;
    }
    if (/:00$/.test(p.label) && parseInt(p.label, 10) % everyHours === 0) {
      svg += `<text x="${f1(x(i))}" y="${P0 + PH + 14}" text-anchor="middle">${esc(p.label)}</text>`;
    }
    if (p.powerW) {
      const h = Math.max(1, (Math.abs(p.powerW) / maxW) * PH);
      const cls = p.powerW > 0 ? 'charge' : 'discharge';
      svg += `<rect class="${cls}" x="${f1(edge)}" width="${f1(step + 0.2)}"`
        + ` y="${f1(p.powerW > 0 ? P0 - h : P0)}" height="${f1(h)}">`
        + `<title>${esc(p.label)} ${(p.powerW / 1000).toFixed(1)} kW</title></rect>`;
    }
  });

  const soc = points.map((p, i) => (p.soc == null ? null : [x(i), y(p.soc)])).filter(Boolean);
  if (soc.length) {
    const line = soc.map(([a, b]) => `${f1(a)},${f1(b)}`).join(' ');
    svg += `<polygon class="area" points="${f1(soc[0][0])},${Y1} ${line} ${f1(soc[soc.length - 1][0])},${Y1}"/>`
      + `<polyline class="soc" points="${line}"/>`;
  }
  return `<svg viewBox="0 0 ${W} ${P0 + PH + 20}" role="img" aria-label="${esc(title)}">${svg}</svg>`;
}

module.exports = { planSvg };
