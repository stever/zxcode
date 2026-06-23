// Languages the ZX Play apps are translated into. Add an entry here (plus a
// locale file per app) to extend; the list is sorted below by native label so
// each language appears under its own name in the switcher.
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
].sort((a, b) => a.label.localeCompare(b.label));

export const LANGUAGE_CODES = SUPPORTED_LANGUAGES.map((l) => l.code);
