import React from "react";
import {useSelector} from "react-redux";
import {Route, Routes} from "react-router-dom";
import {Titled} from "react-titled";
import "@zxplay/ui/theme.css";
import "primereact/resources/primereact.min.css";
import "primeicons/primeicons.css";
import "primeflex/primeflex.css";
import "@zxplay/ui/theme.scss";
import ErrorBoundary from "./ErrorBoundary";
import RenderEmulator from "./RenderEmulator";
import LoadingScreen from "./LoadingScreen";
import {LockScreen} from "@zxplay/ui";
import Nav from "./Nav";
import HomePage from "./HomePage";
import MaxWidth from "./MaxWidth";
import AboutPage from "./AboutPage";
import LinkingPage from "./LinkingPage";
import ErrorNotFoundPage from "./ErrorNotFoundPage";
import ErrorPage from "./ErrorPage";
import {computeMode} from "../lib/layout";
import clsx from "clsx";

export default function App() {
    const err = useSelector(state => state?.error.msg);
    const isMobile = useSelector(state => state?.window.isMobile);
    const width = useSelector(state => state?.window.width);
    const height = useSelector(state => state?.window.height);
    const keyConfig = useSelector(state => state?.app.keyConfig);
    const pathname = useSelector(state => state?.router.location.pathname);
    const className = clsx('pb-1', isMobile ? 'mobile' : 'desktop');

    // On the home page in landscape the emulator owns the whole viewport and
    // renders its own (side-column) nav, so the app shell drops the top nav.
    // The wrapper element is kept stable across this toggle (only its class and
    // the nav's presence change) so the routed tree - and the emulator's screen
    // DOM - is never remounted on rotation.
    const mode = computeMode({width, height, kbAspect: keyConfig.aspect});
    const sideHome = !err && pathname === '/' && mode === 'side';

    return (
        <Titled title={() => 'ZX Play'}>
            <RenderEmulator/>
            <LoadingScreen/>
            <LockScreen/>
            <div className={sideHome ? undefined : className}>
                {!sideHome && <Nav/>}
                {err
                    ? <ErrorPage msg={err}/>
                    : (
                        <ErrorBoundary>
                            <Routes>
                                <Route exact path="/" element={<HomePage/>}/>
                                <Route exact path="/about" element={<MaxWidth><AboutPage/></MaxWidth>}/>
                                <Route exact path="/info/linking" element={<MaxWidth><LinkingPage/></MaxWidth>}/>
                                <Route path="*" element={<ErrorNotFoundPage/>}/>
                            </Routes>
                        </ErrorBoundary>
                    )}
            </div>
        </Titled>
    )
}
