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
import {useTranslation} from "@zxplay/i18n";
import {computeMode, currentKeystr, keyboardAspect, tabEmulatorWidth} from "../lib/layout";

export default function HomePage() {
    const {t} = useTranslation();
    const dispatch = useDispatch();

    const selectedTabIndex = useSelector(state => state?.demo.selectedTabIndex);
    const errorItems = useSelector(state => state?.project.errorItems);
    const windowWidth = useSelector(state => state?.window.width);
    const windowHeight = useSelector(state => state?.window.height);

    const toast = useRef(null);

    const mode = computeMode(windowWidth, windowHeight);
    const kbAspect = keyboardAspect(currentKeystr());
    // Tab mode sizes the emulator to its box (fixing portrait clipping and
    // landscape overflow); split keeps the original 640px (2x) size.
    const emuW = mode === 'tab'
        ? tabEmulatorWidth({width: windowWidth, height: windowHeight, kbAspect})
        : 640;
    const zoom = emuW / 320;

    useEffect(() => {
        dispatch(resetProject());
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

    const className = mode === 'tab' ? '' : 'mx-2 my-1';

    return (
        <>
            <Toast ref={toast}/>
            <div className={className}>
                {mode === 'tab' && (
                    <TabView
                        activeIndex={selectedTabIndex}
                        onTabChange={(e) => dispatch(setSelectedTabIndex(e.index))}>
                        <TabPanel header={t("home.tabEmulator")}>
                            <div className="flex justify-content-center">
                                <Emulator zoom={zoom} width={emuW}/>
                            </div>
                        </TabPanel>
                        <TabPanel header={t("home.tabSinclairBasic")}>
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
                                <TabPanel header={t("home.tabSinclairBasic")}>
                                    <DemoSinclairBasicEditor/>
                                </TabPanel>
                                <TabPanel header={t("home.tabZ80Assembly")}>
                                    <DemoAssemblyEditor/>
                                </TabPanel>
                            </TabView>
                        </div>
                        <div className="col-fixed p-0 pt-1" style={{width: `${emuW}px`}}>
                            <div className="height-53 pt-3 pl-1">

                            </div>
                            <Emulator zoom={zoom} width={emuW}/>
                        </div>
                    </div>
                )}
            </div>
        </>
    )
}
