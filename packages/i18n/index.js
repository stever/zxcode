import i18n from 'i18next';
import {initReactI18next} from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import {LANGUAGE_CODES} from './languages';
import commonEn from './locales/en/common.json';
import commonEs from './locales/es/common.json';
import commonRu from './locales/ru/common.json';
import commonPt from './locales/pt/common.json';
import commonPl from './locales/pl/common.json';
import commonCs from './locales/cs/common.json';
import commonSk from './locales/sk/common.json';
import commonRo from './locales/ro/common.json';
import commonBg from './locales/bg/common.json';

const COMMON = {
    en: commonEn,
    es: commonEs,
    ru: commonRu,
    pt: commonPt,
    pl: commonPl,
    cs: commonCs,
    sk: commonSk,
    ro: commonRo,
    bg: commonBg,
};

/**
 * Initialise the shared i18next instance, merging an app's own strings on top of
 * the shared common strings. Both ZX Play apps call this once at startup with
 * their per-app resources, e.g. initI18n({en: webEn, es: webEs, ru: webRu}).
 * Everything lives in one namespace, so components just use t('nav.home').
 */
export function initI18n(appResources = {}) {
    if (!i18n.isInitialized) {
        const resources = {};
        for (const lng of LANGUAGE_CODES) {
            resources[lng] = {translation: COMMON[lng]};
        }
        i18n
            .use(LanguageDetector)
            .use(initReactI18next)
            .init({
                resources,
                fallbackLng: 'en',
                supportedLngs: LANGUAGE_CODES,
                nonExplicitSupportedLngs: true,  // map es-ES -> es, ru-RU -> ru, etc.
                interpolation: {escapeValue: false},  // React already escapes
                detection: {
                    order: ['localStorage', 'navigator'],
                    lookupLocalStorage: 'zxplay_lang',
                    caches: ['localStorage'],
                },
            });
    }

    // Deep-merge each app's strings on top of the shared common strings (so an
    // app's "nav" keys add to common's rather than replacing the object).
    for (const lng of LANGUAGE_CODES) {
        if (appResources[lng]) {
            i18n.addResourceBundle(lng, 'translation', appResources[lng], true, true);
        }
    }

    return i18n;
}

export {i18n};
export {SUPPORTED_LANGUAGES, LANGUAGE_CODES} from './languages';
export {LanguageSwitcher} from './LanguageSwitcher';
export {useDateFnsLocale} from './dateLocale';
export {useTranslation, Trans, Translation} from 'react-i18next';
