'use strict';

// Translations: same keys in every language, every text translated, placeholders intact.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { localeFor } = require('../lib/i18n');

const ROOT = path.join(__dirname, '..');
const LANGS = ['en', 'sv', 'no', 'da', 'de', 'nl'];
// Texts that are the same in every language (Homey falls back to English).
const SAME = new Set(['10', '3', 'Grid Rewards', 'Tibber Grid Rewards', 'kr', 'min', 'name@example.com', 'Status']);
// Real words that happen to be the same as in English.
const SAME_IN = { de: new Set(['Sessions']) };

const flat = (o, p = '') => Object.entries(o)
  .flatMap(([k, v]) => (typeof v === 'object' ? flat(v, `${p}${k}.`) : [[`${p}${k}`, v]]));

/** __token__, [[arg]] and !{{a|b}} (only that it is there) must survive translation. */
function placeholders(s) {
  return [
    ...(s.match(/__\w+__/g) || []),
    ...(s.match(/\[\[\w+\]\]/g) || []),
    ...(s.includes('!{{') ? ['!{{|}}'] : []),
  ].sort();
}

function composeTexts() {
  const out = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) {
        if (!/node_modules|\.homeybuild|\.git$|test$/.test(p)) walk(p);
      } else if (/compose\.json$/.test(p) || p.includes(`.homeycompose${path.sep}`)) {
        const visit = (o, where) => {
          if (!o || typeof o !== 'object') return;
          if ('en' in o && Object.values(o).every((v) => typeof v === 'string')) {
            out.push({ where: `${path.relative(ROOT, p)} ${where}`, texts: o });
            return;
          }
          for (const [k, v] of Object.entries(o)) visit(v, `${where}.${k}`);
        };
        visit(JSON.parse(fs.readFileSync(p, 'utf8')), '');
      }
    }
  };
  walk(ROOT);
  return out;
}

test('locale files: same keys in all languages, placeholders intact', () => {
  const en = Object.fromEntries(flat(require('../locales/en.json')));
  for (const lang of LANGS) {
    const other = Object.fromEntries(flat(require(`../locales/${lang}.json`)));
    assert.deepStrictEqual(Object.keys(other).sort(), Object.keys(en).sort(), `keys in ${lang}.json`);
    for (const [k, v] of Object.entries(other)) {
      assert.deepStrictEqual(placeholders(v), placeholders(en[k]), `${lang}.json ${k}`);
      if (lang !== 'en' && !SAME.has(en[k]) && !(SAME_IN[lang] && SAME_IN[lang].has(v))) assert.notStrictEqual(v, en[k], `${lang}.json ${k} is not translated`);
    }
  }
});

test('manifest texts: every language present, placeholders intact', () => {
  const texts = composeTexts();
  assert.ok(texts.length > 100);
  for (const { where, texts: t } of texts) {
    if (SAME.has(t.en)) continue;
    for (const lang of LANGS) {
      assert.ok(t[lang], `${where} lacks ${lang}`);
      assert.deepStrictEqual(placeholders(t[lang]), placeholders(t.en), `${where} ${lang}`);
    }
  }
});

test('localeFor maps Homey languages to locales', () => {
  assert.deepStrictEqual(['sv', 'no', 'da', 'de', 'nl', 'en', 'fr'].map(localeFor),
    ['sv-SE', 'nb-NO', 'da-DK', 'de-DE', 'nl-NL', 'en-GB', 'en-GB']);
});

test('api.js exports only endpoints declared in the manifest', () => {
  const declared = Object.keys(require('../.homeycompose/app.json').api || {}).sort();
  assert.deepStrictEqual(Object.keys(require('../api')).sort(), declared);
  // Every widget's api.js, too (same rule: each export is an endpoint)
  const widgetsDir = path.join(ROOT, 'widgets');
  for (const id of fs.readdirSync(widgetsDir)) {
    const widget = require(path.join(widgetsDir, id, 'widget.compose.json'));
    assert.deepStrictEqual(Object.keys(require(path.join(widgetsDir, id, 'api'))).sort(), Object.keys(widget.api).sort(), id);
  }
});
