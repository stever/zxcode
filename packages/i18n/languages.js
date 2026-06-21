// Languages the ZX Play apps are translated into. ZX Spectrum had large user
// communities in Spain and the former USSR, so Spanish and Russian come first
// alongside English. Add an entry here (plus a locale file per app) to extend.
export const SUPPORTED_LANGUAGES = [
    {code: 'en', label: 'English'},
    {code: 'es', label: 'Español'},
    {code: 'ru', label: 'Русский'},
];

export const LANGUAGE_CODES = SUPPORTED_LANGUAGES.map((l) => l.code);
