import React from 'react';
import {useTranslation} from 'react-i18next';
import {Dropdown} from 'primereact/dropdown';
import {SUPPORTED_LANGUAGES} from './languages';

// Language picker built on primereact's Dropdown so it inherits the site theme
// (both apps already ship primereact). Collapsed it shows a compact rainbow
// mark plus the uppercase language code; the open list shows full names. Apps
// pass className/style to fit their own chrome.
export function LanguageSwitcher({className, style}) {
    const {i18n, t} = useTranslation();
    const active = (i18n.resolvedLanguage || i18n.language || 'en').split('-')[0];
    const value = SUPPORTED_LANGUAGES.some((l) => l.code === active) ? active : 'en';

    const selectedTemplate = () => (
        <span className="flex align-items-center gap-2">
            <span
                aria-hidden="true"
                style={{
                    width: '16px',
                    height: '11px',
                    borderRadius: '2px',
                    flex: 'none',
                    background:
                        'linear-gradient(90deg,#D8222A 0 25%,#E8C400 25% 50%,#2FC04B 50% 75%,#2BD4D4 75% 100%)',
                }}
            />
            <span>{value.toUpperCase()}</span>
        </span>
    );

    return (
        <Dropdown
            aria-label={t('language')}
            className={className}
            style={{width: '6.25rem', ...style}}
            value={value}
            options={SUPPORTED_LANGUAGES}
            optionLabel="label"
            optionValue="code"
            scrollHeight="500px"
            onChange={(e) => i18n.changeLanguage(e.value)}
            valueTemplate={selectedTemplate}
            pt={{
                input: {className: 'p-2'},
                trigger: {style: {width: '2rem'}},
            }}
        />
    );
}
