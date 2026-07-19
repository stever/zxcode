import React from "react";
import {useDispatch, useSelector} from "react-redux";
import {useNavigate} from "react-router-dom";
import {Nav as Deck} from "@zxplay/ui";
import {viewFullScreen, showOpenFileDialog} from "../redux/jsspeccy/actions";
import {resetEmulator, setMachine, setKeyboardSide, setJoystick} from "../redux/app/actions";
import {useTranslation} from "@zxplay/i18n";

export default function Nav({compact = false} = {}) {
    const dispatch = useDispatch();
    const navigate = useNavigate();
    const {t} = useTranslation();

    const pathname = useSelector(state => state?.router.location.pathname);
    const emuVisible = pathname === '/';
    const isMobileState = useSelector(state => state?.window.isMobile);
    // compact forces the collapsed (hamburger) menubar so it fits a narrow
    // landscape column.
    const isMobile = compact || isMobileState;
    const machine = useSelector(state => state?.app.machine);
    const machineLocked = useSelector(state => state?.app.machineLocked);
    const keyboardSide = useSelector(state => state?.app.keyboardSide);
    const joystick = useSelector(state => state?.app.joystick);

    const model = getMenuItems(t, navigate, dispatch, emuVisible, machine, machineLocked, keyboardSide, joystick);

    return (
        <Deck
            model={model}
            brandTitle="ZX Play"
            onBrand={() => navigate('/')}
            isMobile={isMobile}
        />
    );
}

function getMenuItems(t, navigate, dispatch, emuVisible, machine, machineLocked, keyboardSide, joystick) {
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
            {
                // zxgo engine only: the JSSpeccy3 engine has no Next.
                label: 'ZX Spectrum Next',
                icon: machine === 'next' ? 'pi pi-fw pi-check' : 'pi pi-fw',
                disabled: machineLocked,
                command: () => {
                    dispatch(setMachine('next'));
                }
            },
            {
                label: t('nav.loadFile', 'Load file...'),
                icon: 'pi pi-fw pi-folder-open',
                command: () => {
                    dispatch(showOpenFileDialog());
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

    // Which interface the gamepad drives. A game reads exactly one and there
    // is no way to detect which, so the player chooses. The labels name the
    // keys the keyboard-based schemes press, since that is how a player
    // recognises them from a game's own control screen.
    const joystickMenu = {
        label: t('nav.joystick', 'Joystick'),
        icon: 'pi pi-fw pi-directions',
        items: [
            ['Kempston', t('nav.joystickKempston', 'Kempston')],
            ['Sinclair1', t('nav.joystickSinclair1', 'Sinclair 1 (keys 1-5)')],
            ['Sinclair2', t('nav.joystickSinclair2', 'Sinclair 2 (keys 6-0)')],
            ['Cursor', t('nav.joystickCursor', 'Cursor / Protek')],
        ].map(([value, label]) => ({
            label,
            icon: joystick === value ? 'pi pi-fw pi-check' : 'pi pi-fw',
            command: () => {
                dispatch(setJoystick(value));
            }
        }))
    };

    return [
        viewMenu,
        machineMenu,
        joystickMenu,
        infoMenu,
        resetButton,
    ];
}
