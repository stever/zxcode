import React from 'react';
import {useTranslation} from 'react-i18next';
import {SUPPORTED_LANGUAGES} from './languages';

// Dependency-free language picker (plain <select>) so the shared package stays
// light. Apps pass className/style to match their own chrome.
export function LanguageSwitcher({className, style}) {
    const {i18n, t} = useTranslation();
    const active = (i18n.resolvedLanguage || i18n.language || 'en').split('-')[0];
    const value = SUPPORTED_LANGUAGES.some((l) => l.code === active) ? active : 'en';

    return (
        <select
            aria-label={t('language')}
            className={className}
            style={style}
            value={value}
            onChange={(e) => i18n.changeLanguage(e.target.value)}
        >
            {SUPPORTED_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>{l.label}</option>
            ))}
        </select>
    );
}
