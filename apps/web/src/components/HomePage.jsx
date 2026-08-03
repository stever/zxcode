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
import {
    computeMode, editorHeight, emulatorBottom, panelHeight, resolveKeyboard,
    splitEmulator, SPLIT_EMU_CHROME, tabEmulator,
} from "../lib/layout";
import {useChromeAround, useDescendantHeight, useElementTop} from "../lib/usePageMetrics";
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
    const pixelPerfect = useSelector(state => state?.app.pixelPerfect);

    // Both machines share one neutral BASIC sample, so the tab is just "BASIC".
    // The editor still highlights the machine's dialect and the run saga routes
    // delivery (zmakebas tap vs txt2bas) by machine underneath.
    const basicTabHeader = t("home.tabBasic");

    const toast = useRef(null);
    // Measured, not estimated — see usePageMetrics.js. Sizing from the
    // emulator's own top is what retires the guess at the notice's height (three
    // lines, or five in the wordiest locales), and the chrome around the editor
    // covers this page's Run button and divider under it.
    const emuRef = useRef(null);
    const editorColRef = useRef(null);
    const emuTop = useElementTop(emuRef);
    const editorColTop = useElementTop(editorColRef);
    const editorChrome = useChromeAround(editorColRef, '.p-tabview', '.CodeMirror');
    // The emulator's header slot is the editor's tab strip, mirrored.
    const headerH = useDescendantHeight(editorColRef, '.p-tabview-nav');

    const mode = computeMode(windowWidth, windowHeight);
    // The 128K and the Next draw their own keyboards, a different shape
    // from the 48K rubber grid, so the machine feeds the layout maths. Asking
    // for no keyboard gives its space to the screen rather than leaving it.
    const {aspect: kbAspect, hidden: kbHidden} = resolveKeyboard(machine, keyboardLayout);
    // The identity saga resolves userId to null when logged out; while it is
    // still undefined the notice is held back to avoid flashing it at users
    // who are about to be recognised as logged in.
    const showDemoNotice = userId === null;
    // Both modes size every panel to the height it actually has, so nothing
    // below the nav can push the page into scrolling. Measuring where the
    // emulator starts is what accounts for the notice above it, whatever height
    // this locale's wording gives it.
    const isTab = mode === 'tab';
    const emuAvailH = panelHeight({
        viewportH: windowHeight,
        top: emuTop,
        reserveBelow: isTab ? 0 : SPLIT_EMU_CHROME,
    });
    const box = {availH: emuAvailH, kbAspect, hidden: kbHidden, width: windowWidth, pixelPerfect};
    const {emuW, emuH} = isTab ? tabEmulator(box) : splitEmulator(box);
    // Level with the emulator column beside it; in tab mode its panel simply
    // runs to the bottom of the page.
    const columnH = isTab
        ? panelHeight({viewportH: windowHeight, top: editorColTop})
        : emulatorBottom({emuTop, emuH}) - editorColTop;
    const editorH = editorHeight({columnH, chrome: editorChrome});
    const zoom = emuW / 320;
    // The heights the stylesheets read (see ProjectPage).
    const heights = {
        '--zx-editor-h': `${editorH}px`,
        ...(headerH ? {'--zx-title-slot': `${headerH}px`} : {}),
    };

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
            {/* In tab mode the page IS the editor's column, so it carries the
                ref the editor is measured against; split mode puts it on the
                column itself. */}
            <div className={className} style={heights} ref={isTab ? editorColRef : null}>
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
                            <div className="flex justify-content-center" ref={emuRef}>
                                <Emulator zoom={zoom} width={emuW} hideKeyboard={kbHidden}/>
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
                        <div className="col p-0 mr-2" ref={editorColRef}
                             style={{maxWidth: `calc(100vw - ${emuW + 41}px)`}}>
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
                        <div className="col-fixed p-0" style={{width: `${emuW}px`}}>
                            {/* Header slot above the emulator; the project page
                                shows the project title here. Its floor is the
                                editor's tab strip beside it, so the two columns
                                start their content on the same line; a notice
                                that wraps to another line grows the slot rather
                                than overlapping the emulator. */}
                            <div className="zx-title-slot-min">
                                {demoNotice && (
                                    <div className="demo-notice">
                                        {demoNotice}
                                    </div>
                                )}
                            </div>
                            <div ref={emuRef}>
                                <Emulator zoom={zoom} width={emuW} hideKeyboard={kbHidden}/>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </>
    )
}
