import React from "react";
import {useSelector} from "react-redux";
import {Route, Routes} from "react-router-dom";
import {Titled} from "react-titled";
import "primereact/resources/themes/md-dark-indigo/theme.css";
import "primereact/resources/primereact.min.css";
import "primeicons/primeicons.css";
import "primeflex/primeflex.css";
import ErrorBoundary from "./ErrorBoundary";
import RenderEmulator from "./RenderEmulator";
import LoadingScreen from "./LoadingScreen";
import LockScreen from "./LockScreen";
import Nav from "./Nav";
import HomePage from "./HomePage";
import MaxWidth from "./MaxWidth";
import AboutPage from "./AboutPage";
import LinkingPage from "./LinkingPage";
import SearchPage from "./SearchPage";
import ErrorNotFoundPage from "./ErrorNotFoundPage";
import ErrorPage from "./ErrorPage";
import clsx from "clsx";

export default function App() {
    const err = useSelector(state => state?.error.msg);
    const isMobile = useSelector(state => state?.window.isMobile);
    const className = clsx('pb-1', isMobile ? 'mobile' : 'desktop');

    return (
        <Titled title={() => 'ZX Play'}>
            <RenderEmulator/>
            <LoadingScreen/>
            <LockScreen/>
            <div className={className}>
                <Nav/>
                {err &&
                    <ErrorPage msg={err}/>
                }
                {!err &&
                    <ErrorBoundary>
                        <Routes>
                            <Route exact path="/" element={<HomePage/>}/>
                            <Route exact path="/about" element={<MaxWidth><AboutPage/></MaxWidth>}/>
                            <Route exact path="/info/linking" element={<MaxWidth><LinkingPage/></MaxWidth>}/>
                            <Route path="/search" element={<SearchPage/>}/>
                            <Route path="*" element={<ErrorNotFoundPage/>}/>
                        </Routes>
                    </ErrorBoundary>
                }
            </div>
        </Titled>
    )
}
