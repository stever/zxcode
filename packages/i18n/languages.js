// Languages the ZX Play apps are translated into. ZX Spectrum had large user
// communities in Spain and the former USSR, so Spanish and Russian come first
// alongside English. Add an entry here (plus a locale file per app) to extend.
export const SUPPORTED_LANGUAGES = [
    {code: 'en', label: 'English'},
    {code: 'es', label: 'Español'},
    {code: 'ru', label: 'Русский'},
    {code: 'pt', label: 'Português'},
    {code: 'pl', label: 'Polski'},
    {code: 'cs', label: 'Čeština'},
    {code: 'sk', label: 'Slovenčina'},
    {code: 'ro', label: 'Română'},
    {code: 'bg', label: 'Български'},
];

export const LANGUAGE_CODES = SUPPORTED_LANGUAGES.map((l) => l.code);
