import React, {useState} from "react";
import {useDispatch, useSelector} from "react-redux";
import {useNavigate} from "react-router-dom";
import {InputText} from "primereact/inputtext";
import {Nav as Deck} from "@zxplay/ui";
import {viewFullScreen} from "../redux/jsspeccy/actions";
import {resetEmulator, setMachine} from "../redux/app/actions";
import {useTranslation} from "@zxplay/i18n";

export default function Nav() {
    const dispatch = useDispatch();
    const navigate = useNavigate();
    const {t} = useTranslation();

    const [searchInput, setSearchInput] = useState('');

    const pathname = useSelector(state => state?.router.location.pathname);
    const emuVisible = pathname === '/';
    const isMobile = useSelector(state => state?.window.isMobile);
    const machine = useSelector(state => state?.app.machine);
    const machineLocked = useSelector(state => state?.app.machineLocked);

    const model = getMenuItems(t, navigate, dispatch, emuVisible, machine, machineLocked);

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

function getMenuItems(t, navigate, dispatch, emuVisible, machine, machineLocked) {
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

    const machineMenu = {
        label: t('nav.machine'),
        icon: 'pi pi-fw pi-desktop',
        items: [
            {
                label: t('nav.machine48'),
                icon: machine === 48 ? 'pi pi-fw pi-check' : 'pi pi-fw',
                disabled: machineLocked,
                command: () => {
                    dispatch(setMachine(48));
                }
            },
            {
                label: t('nav.machine128'),
                icon: machine === 128 ? 'pi pi-fw pi-check' : 'pi pi-fw',
                disabled: machineLocked,
                command: () => {
                    dispatch(setMachine(128));
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
        machineMenu,
        infoMenu,
        resetButton,
    ];
}
