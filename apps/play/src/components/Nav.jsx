import React, {useState} from "react";
import {useDispatch, useSelector} from "react-redux";
import {useNavigate} from "react-router-dom";
import {InputText} from "primereact/inputtext";
import {Nav as Deck} from "@zxplay/ui";
import {viewFullScreen} from "../redux/jsspeccy/actions";
import {resetEmulator} from "../redux/app/actions";
import {useTranslation} from "@zxplay/i18n";

export default function Nav() {
    const dispatch = useDispatch();
    const navigate = useNavigate();
    const {t} = useTranslation();

    const [searchInput, setSearchInput] = useState('');

    const pathname = useSelector(state => state?.router.location.pathname);
    const emuVisible = pathname === '/';
    const isMobile = useSelector(state => state?.window.isMobile);

    const model = getMenuItems(t, navigate, dispatch, emuVisible);

    const search = (
        <InputText
            className="p-2"
            placeholder={t('nav.search')}
            type="text"
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
                if (e.key === 'Enter' && searchInput) {
                    navigate(`/search?q=${searchInput}`);
                }
            }}/>
    );

    return (
        <Deck
            model={model}
            brandTitle="ZX Play"
            onBrand={() => navigate('/')}
            isMobile={isMobile}
            search={search}
        />
    );
}

function getMenuItems(t, navigate, dispatch, emuVisible) {
    const viewFullScreenMenuItem = {
        label: t('nav.fullScreen'),
        icon: 'pi pi-fw pi-window-maximize',
        disabled: !emuVisible,
        command: () => {
            dispatch(viewFullScreen());
        }
    };

    const viewMenu = {
        label: t('nav.view'),
        icon: 'pi pi-fw pi-eye',
        items: [viewFullScreenMenuItem]
    };

    const infoMenu = {
        label: t('nav.info'),
        icon: 'pi pi-fw pi-info-circle',
        items: [
            {
                label: t('nav.aboutThisSite'),
                icon: 'pi pi-fw pi-question-circle',
                command: () => {
                    navigate('/about');
                }
            },
            {
                label: t('nav.linking'),
                icon: 'pi pi-fw pi-link',
                command: () => {
                    navigate('/info/linking');
                }
            },
        ]
    };

    const resetButton = {
        label: t('nav.reset'),
        icon: 'pi pi-fw pi-power-off',
        command: () => {
            dispatch(resetEmulator());
        }
    };

    return [
        viewMenu,
        infoMenu,
        resetButton,
    ];
}
