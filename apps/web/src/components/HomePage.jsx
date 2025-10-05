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

export default function HomePage() {
    const dispatch = useDispatch();

    const selectedTabIndex = useSelector(state => state?.demo.selectedTabIndex);
    const errorItems = useSelector(state => state?.project.errorItems);
    const isMobile = useSelector(state => state?.window.isMobile);

    const toast = useRef(null);

    const zoom = 2;
    const width = zoom * 320;

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

    const className = isMobile ? '' : 'mx-2 my-1';

    return (
        <>
            <Toast ref={toast}/>
            <div className={className}>
                <div className="grid full-width-grid">
                    {isMobile && (
                        <>
                            <div className="col col-no-padding">

                            </div>
                            <div className="col-fixed p-0" style={{width: `${width}px`}}>
                                <TabView
                                    activeIndex={selectedTabIndex}
                                    onTabChange={(e) => dispatch(setSelectedTabIndex(e.index))}>
                                    <TabPanel header="Emulator">
                                        <Emulator zoom={zoom} width={width}/>
                                    </TabPanel>
                                    <TabPanel header="Sinclair BASIC">
                                        <DemoSinclairBasicEditor/>
                                    </TabPanel>
                                    <TabPanel header="Z80 Assembly">
                                        <DemoAssemblyEditor/>
                                    </TabPanel>
                                </TabView>
                            </div>
                            <div className="col col-no-padding">

                            </div>
                        </>
                    )}
                    {!isMobile && (
                        <>
                            <div className="col p-0 mr-2" style={{maxWidth: `calc(100vw - ${width + 41}px`}}>
                                <TabView
                                    activeIndex={selectedTabIndex}
                                    onTabChange={(e) => dispatch(setSelectedTabIndex(e.index))}>
                                    <TabPanel header="Sinclair BASIC">
                                        <DemoSinclairBasicEditor/>
                                    </TabPanel>
                                    <TabPanel header="Z80 Assembly">
                                        <DemoAssemblyEditor/>
                                    </TabPanel>
                                </TabView>
                            </div>
                            <div className="col-fixed p-0 pt-1" style={{width: `${width}px`}}>
                                <div className="height-53 pt-3 pl-1">

                                </div>
                                <Emulator zoom={zoom} width={width}/>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </>
    )
}
