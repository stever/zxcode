import React, {useEffect, useRef} from "react";
import {useDispatch, useSelector} from "react-redux";
import {TabPanel, TabView} from "primereact/tabview";
import {Toast} from "primereact/toast";
import {DemoSinclairBasicEditor} from "./DemoSinclairBasicEditor";
import {DemoAssemblyEditor} from "./DemoAssemblyEditor";
import {Emulator} from "./Emulator";
import {setSelectedTabIndex} from "../redux/demo/actions";
import {reset as resetProject, setErrorItems} from "../redux/project/actions";
import {reset} from "../redux/jsspeccy/actions";
import {showToastsForErrorItems} from "../errors";
import {selectHasUnsavedChanges} from "../redux/project/selectors";
import {useTranslation, Trans} from "@zxplay/i18n";
import {computeMode, resolveKeyboard, tabEmulatorWidth} from "../lib/layout";
import {login} from "../auth";

export default function HomePage() {
    const {t} = useTranslation();
    const dispatch = useDispatch();

    const selectedTabIndex = useSelector(state => state?.demo.selectedTabIndex);
    const errorItems = useSelector(state => state?.project.errorItems);
    const hasUnsavedCode = useSelector(selectHasUnsavedChanges);
    const windowWidth = useSelector(state => state?.window.width);
    const windowHeight = useSelector(state => state?.window.height);
    const userId = useSelector(state => state?.identity.userId);
    const machine = useSelector(state => state?.app.machine);
    const keyboardLayout = useSelector(state => state?.app.keyboardLayout);

    // Both machines share one neutral BASIC sample, so the tab is just "BASIC".
    // The editor still highlights the machine's dialect and the run saga routes
    // delivery (zmakebas tap vs txt2bas) by machine underneath.
    const basicTabHeader = t("home.tabBasic");

    const toast = useRef(null);

    const mode = computeMode(windowWidth, windowHeight);
    // The 128K and the Next draw their own keyboards, a different shape
    // from the 48K rubber grid, so the machine feeds the layout maths.
    const kbAspect = resolveKeyboard(machine, keyboardLayout).aspect;
    // The identity saga resolves userId to null when logged out; while it is
    // still undefined the notice is held back to avoid flashing it at users
    // who are about to be recognised as logged in.
    const showDemoNotice = userId === null;
    // Tab mode shows the demo notice above the tabs, so its height (banner plus
    // margins; three lines at tab widths, up to five in the wordiest locales on
    // narrow screens) comes out of the emulator's box. An estimate is enough —
    // see TAB_CHROME in layout.js.
    const noticeChrome = showDemoNotice && mode === 'tab'
        ? (windowWidth >= 520 ? 84 : 116)
        : 0;
    // Tab mode sizes the emulator to its box (fixing portrait clipping and
    // landscape overflow); split keeps the original 640px (2x) size.
    const emuW = mode === 'tab'
        ? tabEmulatorWidth({width: windowWidth, height: windowHeight, kbAspect, extraChrome: noticeChrome})
        : 640;
    const zoom = emuW / 320;

    useEffect(() => {
        // Keep the project's unsaved draft so navigating home and back doesn't
        // lose it (matches the About/settings pages, which never reset). The
        // reducer/saga restore the draft when the project is reloaded.
        if (!hasUnsavedCode) {
            dispatch(resetProject());
        }
        return () => {
            dispatch(reset());
        }
    }, []);

    useEffect(() => {
        if (errorItems && errorItems.length > 0 && toast.current) {
            showToastsForErrorItems(errorItems, toast);
            dispatch(setErrorItems(undefined));
        }

        return () => {};
    }, [errorItems, toast.current]);

    const className = mode === 'tab' ? '' : 'mx-2 mb-1';

    const demoNotice = showDemoNotice && (
        <Trans
            i18nKey="home.demoNotice"
            components={{
                signInLink: <a href="#" onClick={(e) => {
                    e.preventDefault();
                    login();
                }}/>
            }}
        />
    );

    return (
        <>
            <Toast ref={toast}/>
            <div className={className}>
                {mode === 'tab' && demoNotice && (
                    <div className="demo-notice mt-2 mb-2 mx-2">
                        {demoNotice}
                    </div>
                )}
                {mode === 'tab' && (
                    <TabView
                        activeIndex={selectedTabIndex}
                        onTabChange={(e) => dispatch(setSelectedTabIndex(e.index))}>
                        <TabPanel header={t("home.tabEmulator")}>
                            <div className="flex justify-content-center">
                                <Emulator zoom={zoom} width={emuW}/>
                            </div>
                        </TabPanel>
                        <TabPanel header={basicTabHeader}>
                            <DemoSinclairBasicEditor/>
                        </TabPanel>
                        <TabPanel header={t("home.tabZ80Assembly")}>
                            <DemoAssemblyEditor/>
                        </TabPanel>
                    </TabView>
                )}
                {mode === 'split' && (
                    <div className="grid full-width-grid">
                        <div className="col p-0 mr-2" style={{maxWidth: `calc(100vw - ${emuW + 41}px`}}>
                            <TabView
                                activeIndex={selectedTabIndex}
                                onTabChange={(e) => dispatch(setSelectedTabIndex(e.index))}>
                                <TabPanel header={basicTabHeader}>
                                    <DemoSinclairBasicEditor/>
                                </TabPanel>
                                <TabPanel header={t("home.tabZ80Assembly")}>
                                    <DemoAssemblyEditor/>
                                </TabPanel>
                            </TabView>
                        </div>
                        <div className="col-fixed p-0 pt-1" style={{width: `${emuW}px`}}>
                            {/* Header slot above the emulator; the project page
                                shows the project title here. The min-height
                                keeps the emulator aligned with the editor pane
                                when the banner fits in two lines; translations
                                that wrap to three grow the slot rather than
                                overlap the emulator. */}
                            <div className="min-height-53">
                                {demoNotice && (
                                    <div className="demo-notice">
                                        {demoNotice}
                                    </div>
                                )}
                            </div>
                            <Emulator zoom={zoom} width={emuW}/>
                        </div>
                    </div>
                )}
            </div>
        </>
    )
}
