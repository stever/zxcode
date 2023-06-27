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

    const activeIndex = useSelector(state => state?.demo.selectedTabIndex);
    const errorItems = useSelector(state => state?.project.errorItems);

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

    return (
        <>
            <Toast ref={toast}/>
            <div className="mx-2 my-1">
                <div className="grid" style={{width: "100%", padding: 0, margin: 0}}>
                    <div className="col p-0 mr-2" style={{maxWidth: `calc(100vw - ${width + 41}px`}}>
                        <TabView
                            activeIndex={activeIndex}
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
                        <div style={{height: '53px'}} className="pt-3 pl-1">

                        </div>
                        <Emulator zoom={zoom} width={width}/>
                    </div>
                </div>
            </div>
        </>
    )
}
