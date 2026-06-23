// Languages the ZX Play apps are translated into, ordered alphabetically by code.
// Add an entry here (plus a locale file per app) to extend.
export const SUPPORTED_LANGUAGES = [
    {code: 'bg', label: 'Български'},
    {code: 'cs', label: 'Čeština'},
    {code: 'el', label: 'Ελληνικά'},
    {code: 'en', label: 'English'},
    {code: 'es', label: 'Español'},
    {code: 'it', label: 'Italiano'},
    {code: 'pl', label: 'Polski'},
    {code: 'pt', label: 'Português'},
    {code: 'ro', label: 'Română'},
    {code: 'ru', label: 'Русский'},
    {code: 'sk', label: 'Slovenčina'},
];

export const LANGUAGE_CODES = SUPPORTED_LANGUAGES.map((l) => l.code);
