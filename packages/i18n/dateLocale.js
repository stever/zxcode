import {enUS, es, ru, pt, pl, cs, sk, ro, bg} from 'date-fns/locale';
import {useTranslation} from 'react-i18next';

// Maps each supported app language to its date-fns locale, so relative times
// like "about 2 hours ago" render in the user's language rather than English.
const DATE_FNS_LOCALES = {en: enUS, es, ru, pt, pl, cs, sk, ro, bg};

/**
 * Returns the date-fns locale for the active language. Pass it as the `locale`
 * option to formatDistanceToNow/formatDistance so relative times are localised:
 *
 *   const locale = useDateFnsLocale();
 *   formatDistanceToNow(date, {addSuffix: true, locale});
 */
export function useDateFnsLocale() {
    const {i18n} = useTranslation();
    const lng = (i18n.language || 'en').split('-')[0];
    return DATE_FNS_LOCALES[lng] || enUS;
}
