import React from "react";
import { useSelector } from "react-redux";
import { Route, Routes } from "react-router-dom";
import { Titled } from "react-titled";
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
import PrivacyPolicyPage from "./PrivacyPolicyPage";
import TermsOfUsePage from "./TermsOfUsePage";
import NewProjectPage from "./NewProjectPage";
import ProjectPage from "./ProjectPage";
import PublicUserProfile from "./PublicUserProfile";
import PublicProjectPage from "./PublicProjectPage";
import UserProfileSettings from "./UserProfileSettings";
import YourProjectsPage from "./YourProjectsPage";
import ActivityFeed from "./ActivityFeed";
import FollowList from "./FollowList";
import ErrorNotFoundPage from "./ErrorNotFoundPage";
import ErrorPage from "./ErrorPage";
import clsx from "clsx";

export default function App() {
  const err = useSelector((state) => state?.error.msg);
  const isMobile = useSelector((state) => state?.window.isMobile);
  const className = clsx("pb-1", isMobile ? "mobile" : "desktop");

  return (
    <Titled title={() => "Code · ZX Play"}>
      <RenderEmulator />
      <LoadingScreen />
      <LockScreen />
      <div className={className}>
        <Nav />
        {err && <ErrorPage msg={err} />}
        {!err && (
          <ErrorBoundary>
            <Routes>
              <Route exact path="/" element={<HomePage />} />
              <Route
                exact
                path="/about"
                element={
                  <MaxWidth>
                    <AboutPage />
                  </MaxWidth>
                }
              />
              <Route
                exact
                path="/privacy-policy"
                element={
                  <MaxWidth>
                    <PrivacyPolicyPage />
                  </MaxWidth>
                }
              />
              <Route
                exact
                path="/terms-of-use"
                element={
                  <MaxWidth>
                    <TermsOfUsePage />
                  </MaxWidth>
                }
              />
              <Route
                exact
                path="/new/asm"
                element={
                  <MaxWidth>
                    <NewProjectPage type="asm" />
                  </MaxWidth>
                }
              />
              <Route
                exact
                path="/new/basic"
                element={
                  <MaxWidth>
                    <NewProjectPage type="basic" />
                  </MaxWidth>
                }
              />
              <Route
                exact
                path="/new/bas2tap"
                element={
                  <MaxWidth>
                    <NewProjectPage type="bas2tap" />
                  </MaxWidth>
                }
              />
              <Route
                exact
                path="/new/c"
                element={
                  <MaxWidth>
                    <NewProjectPage type="c" />
                  </MaxWidth>
                }
              />
              <Route
                exact
                path="/new/sdcc"
                element={
                  <MaxWidth>
                    <NewProjectPage type="sdcc" />
                  </MaxWidth>
                }
              />
              <Route
                exact
                path="/new/zmac"
                element={
                  <MaxWidth>
                    <NewProjectPage type="zmac" />
                  </MaxWidth>
                }
              />
              <Route
                exact
                path="/new/zxbasic"
                element={
                  <MaxWidth>
                    <NewProjectPage type="zxbasic" />
                  </MaxWidth>
                }
              />
              <Route exact path="/projects/:id" element={<ProjectPage />} />
              <Route exact path="/u/:id" element={<PublicUserProfile />} />
              <Route
                exact
                path="/u/:userSlug/:projectSlug"
                element={<PublicProjectPage />}
              />
              <Route
                exact
                path="/u/:id/projects"
                element={<YourProjectsPage />}
              />
              <Route exact path="/u/:slug/followers" element={<FollowList />} />
              <Route exact path="/u/:slug/following" element={<FollowList />} />
              <Route exact path="/feed" element={<ActivityFeed />} />
              <Route
                exact
                path="/settings/profile"
                element={
                  <MaxWidth>
                    <UserProfileSettings />
                  </MaxWidth>
                }
              />
              <Route path="*" element={<ErrorNotFoundPage />} />
            </Routes>
          </ErrorBoundary>
        )}
      </div>
    </Titled>
  );
}
