import React from "react";
import {useSelector} from "react-redux";
import {Route, Routes} from "react-router-dom";
import {Titled} from "react-titled";
import queryString from "query-string";
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
import PrivacyPolicyPage from "./PrivacyPolicyPage";
import TermsOfUsePage from "./TermsOfUsePage";
import NewProjectPage from "./NewProjectPage";
import ProjectPage from "./ProjectPage";
import SearchPage from "./SearchPage";
import YourProfilePage from "./YourProfilePage";
import YourProjectsPage from "./YourProjectsPage";
import ErrorNotFoundPage from "./ErrorNotFoundPage";
import ErrorPage from "./ErrorPage";

export default function App() {
    const err = useSelector(state => state?.error.msg);

    // Hide tabs when loading external tape files.
    const search = useSelector(state => state?.router.location.search);
    const parsed = queryString.parse(search);
    const externalLoad = typeof parsed.u !== 'undefined';

    return (
        <Titled title={() => 'ZX Play'}>
            <RenderEmulator/>
            <LoadingScreen/>
            <LockScreen/>
            <div className="pb-1">
                {!externalLoad &&
                    <Nav/>
                }
                {err &&
                    <ErrorPage msg={err}/>
                }
                {!err &&
                    <ErrorBoundary>
                        <Routes>
                            <Route exact path="/" element={<HomePage/>}/>
                            <Route exact path="/about" element={<MaxWidth><AboutPage/></MaxWidth>}/>
                            <Route exact path="/info/linking" element={<MaxWidth><LinkingPage/></MaxWidth>}/>
                            <Route exact path="/legal/privacy-policy" element={<MaxWidth><PrivacyPolicyPage/></MaxWidth>}/>
                            <Route exact path="/legal/terms-of-use" element={<MaxWidth><TermsOfUsePage/></MaxWidth>}/>
                            <Route exact path="/new/asm" element={<MaxWidth><NewProjectPage type="asm"/></MaxWidth>}/>
                            <Route exact path="/new/basic" element={<MaxWidth><NewProjectPage type="basic"/></MaxWidth>}/>
                            <Route exact path="/new/bas2tap" element={<MaxWidth><NewProjectPage type="bas2tap"/></MaxWidth>}/>
                            <Route exact path="/new/c" element={<MaxWidth><NewProjectPage type="c"/></MaxWidth>}/>
                            <Route exact path="/new/sdcc" element={<MaxWidth><NewProjectPage type="sdcc"/></MaxWidth>}/>
                            <Route exact path="/new/zmac" element={<MaxWidth><NewProjectPage type="zmac"/></MaxWidth>}/>
                            <Route exact path="/new/zxbasic" element={<MaxWidth><NewProjectPage type="zxbasic"/></MaxWidth>}/>
                            <Route exact path="/projects/:id" element={<ProjectPage/>}/>
                            <Route path="/search" element={<SearchPage/>}/>
                            <Route exact path="/u/:id" element={<YourProfilePage/>}/>
                            <Route exact path="/u/:id/projects" element={<YourProjectsPage/>}/>
                            <Route path="*" element={<ErrorNotFoundPage/>}/>
                        </Routes>
                    </ErrorBoundary>
                }
            </div>
        </Titled>
    )
}
