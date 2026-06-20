import React, {useState} from "react";
import {useDispatch, useSelector} from "react-redux";
import {useNavigate} from "react-router-dom";
import {InputText} from "primereact/inputtext";
import {Menubar} from "primereact/menubar";
import {
    viewFullScreen
} from "../redux/jsspeccy/actions";
import {resetEmulator} from "../redux/app/actions";

export default function Nav() {
    const dispatch = useDispatch();
    const navigate = useNavigate();

    const [searchInput, setSearchInput] = useState('');

    const pathname = useSelector(state => state?.router.location.pathname);
    const emuVisible = pathname === '/';

    const isMobile = useSelector(state => state?.window.isMobile);
    const className = isMobile ? '' : 'px-2 pt-2';

    const items = getMenuItems(navigate, dispatch, emuVisible);

    return (
        <div className={className}>
            <Menubar
                model={items}
                start={<img alt="logo" src="/logo.png" height={"40"} className="mx-1"/>}
                end={(
                    <InputText
                        className="mx-1 p-2"
                        placeholder="Search"
                        type="text"
                        onChange={(e) => setSearchInput(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && searchInput) {
                                navigate(`/search?q=${searchInput}`);
                            }
                        }}/>
                )}
                style={{
                    borderRadius: isMobile ? 0 : '5px',
                    borderColor: '#1E1E1E'
                }}
            />
        </div>
    );
}

function getMenuItems(navigate, dispatch, emuVisible) {
    const sep = {
        separator: true
    };

    const homeButton = {
        label: 'ZX Play',
        command: () => {
            navigate('/');
        }
    };

    const viewFullScreenMenuItem = {
        label: 'Full Screen',
        icon: 'pi pi-fw pi-window-maximize',
        disabled: !emuVisible,
        command: () => {
            dispatch(viewFullScreen());
        }
    };

    const viewMenu = {
        label: 'View',
        icon: 'pi pi-fw pi-eye',
        items: []
    };

    viewMenu.items.push(viewFullScreenMenuItem);

    const infoMenu = {
        label: 'Info',
        icon: 'pi pi-fw pi-info-circle',
        items: [
            {
                label: 'About This Site',
                icon: 'pi pi-fw pi-question-circle',
                command: () => {
                    navigate('/about');
                }
            },
            {
                label: 'Linking To ZX Play',
                icon: 'pi pi-fw pi-link',
                command: () => {
                    navigate('/info/linking');
                }
            },
            // {
            //     label: 'Privacy Policy',
            //     icon: 'pi pi-fw pi-eye',
            //     command: () => {
            //         navigate('/legal/privacy-policy');
            //     }
            // },
            // {
            //     label: 'Terms of Use',
            //     icon: 'pi pi-fw pi-info-circle',
            //     command: () => {
            //         navigate('/legal/terms-of-use');
            //     }
            // }
        ]
    };

    const resetButton = {
        label: 'Reset',
        icon: 'pi pi-fw pi-power-off',
        command: () => {
            dispatch(resetEmulator());
        }
    };

    return [
        homeButton,
        viewMenu,
        infoMenu,
        resetButton,
    ];
}
