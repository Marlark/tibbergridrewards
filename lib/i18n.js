'use strict';

// Homey language code -> locale for dates and numbers.
const LOCALES = {
  en: 'en-GB', sv: 'sv-SE', no: 'nb-NO', da: 'da-DK', de: 'de-DE', nl: 'nl-NL',
};

/** Locale for Homey's language, e.g. homey.i18n.getLanguage() === 'no' -> 'nb-NO'. */
function localeFor(language) {
  return LOCALES[language] || 'en-GB';
}

/**
 * A date formatter, made once per locale and options and then reused. Creating
 * an Intl.DateTimeFormat costs about 35 times as much as formatting with one
 * (41 µs against 1.2 µs on a PC), and the day key is needed on every update.
 */
const formatters = new Map();
function dateFormat(locale, options) {
  const key = `${locale}|${JSON.stringify(options)}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, options);
    formatters.set(key, f);
  }
  return f;
}

module.exports = { localeFor, LOCALES, dateFormat };
