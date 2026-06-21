import React from 'react';
import {useTranslation} from 'react-i18next';
import {Dropdown} from 'primereact/dropdown';
import {SUPPORTED_LANGUAGES} from './languages';

// Language picker built on primereact's Dropdown so it inherits the site theme
// (both apps already ship primereact). A leading globe icon marks it as the
// language control. Apps pass className/style to fit their own chrome.
export function LanguageSwitcher({className, style}) {
    const {i18n, t} = useTranslation();
    const active = (i18n.resolvedLanguage || i18n.language || 'en').split('-')[0];
    const value = SUPPORTED_LANGUAGES.some((l) => l.code === active) ? active : 'en';

    const selectedTemplate = (option) => {
        const label =
            option?.label ??
            SUPPORTED_LANGUAGES.find((l) => l.code === value)?.label ??
            '';
        return (
            <span className="flex align-items-center gap-2">
                <i className="pi pi-globe" />
                <span>{label}</span>
            </span>
        );
    };

    return (
        <Dropdown
            aria-label={t('language')}
            className={className}
            style={{width: '11rem', ...style}}
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
