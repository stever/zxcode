import React from "react";
import {useDispatch, useSelector} from "react-redux";
import {useNavigate} from "react-router-dom";
import {Nav as Deck} from "@zxplay/ui";
import {viewFullScreen} from "../redux/jsspeccy/actions";
import {resetEmulator, setMachine, setKeyboardSide} from "../redux/app/actions";
import {useTranslation} from "@zxplay/i18n";

export default function Nav() {
    const dispatch = useDispatch();
    const navigate = useNavigate();
    const {t} = useTranslation();

    const pathname = useSelector(state => state?.router.location.pathname);
    const emuVisible = pathname === '/';
    const isMobile = useSelector(state => state?.window.isMobile);
    const machine = useSelector(state => state?.app.machine);
    const machineLocked = useSelector(state => state?.app.machineLocked);
    const keyboardSide = useSelector(state => state?.app.keyboardSide);

    const model = getMenuItems(t, navigate, dispatch, emuVisible, machine, machineLocked, keyboardSide);

    return (
        <Deck
            model={model}
            brandTitle="ZX Play"
            onBrand={() => navigate('/')}
            isMobile={isMobile}
        />
    );
}

function getMenuItems(t, navigate, dispatch, emuVisible, machine, machineLocked, keyboardSide) {
    const viewFullScreenMenuItem = {
        label: t('nav.fullScreen'),
        icon: 'pi pi-fw pi-window-maximize',
        disabled: !emuVisible,
        command: () => {
            dispatch(viewFullScreen());
        }
    };

    const keyboardSideMenuItem = {
        label: t('nav.keyboardSide'),
        icon: 'pi pi-fw pi-arrows-h',
        items: [
            {
                label: t('nav.keyboardSideRight'),
                icon: keyboardSide === 'right' ? 'pi pi-fw pi-check' : 'pi pi-fw',
                command: () => {
                    dispatch(setKeyboardSide('right'));
                }
            },
            {
                label: t('nav.keyboardSideLeft'),
                icon: keyboardSide === 'left' ? 'pi pi-fw pi-check' : 'pi pi-fw',
                command: () => {
                    dispatch(setKeyboardSide('left'));
                }
            },
        ]
    };

    const viewMenu = {
        label: t('nav.view'),
        icon: 'pi pi-fw pi-eye',
        items: [viewFullScreenMenuItem, keyboardSideMenuItem]
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
