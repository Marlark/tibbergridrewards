'use strict';

// Homey language code -> locale for dates and numbers.
const LOCALES = {
  en: 'en-GB', sv: 'sv-SE', no: 'nb-NO', da: 'da-DK', de: 'de-DE', nl: 'nl-NL',
};

/** Locale for Homey's language, e.g. homey.i18n.getLanguage() === 'no' -> 'nb-NO'. */
function localeFor(language) {
  return LOCALES[language] || 'en-GB';
}

module.exports = { localeFor, LOCALES };
