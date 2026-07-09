import React, { useEffect } from "react";
import { useSelector } from "react-redux";
import { Route, Routes } from "react-router-dom";
import { Titled } from "react-titled";
import "@zxplay/ui/theme.css";
import "primereact/resources/primereact.min.css";
import "primeicons/primeicons.css";
import "primeflex/primeflex.css";
import "@zxplay/ui/theme.scss";
import ErrorBoundary from "./ErrorBoundary";
import RenderEmulator from "./RenderEmulator";
import LoadingScreen from "./LoadingScreen";
import { LockScreen } from "@zxplay/ui";
import Nav from "./Nav";
import HomePage from "./HomePage";
import MaxWidth from "./MaxWidth";
import AboutPage from "./AboutPage";
import BotPage from "./BotPage";
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
import Stargazers from "./Stargazers";
import PublicProfiles from "./PublicProfiles";
import ErrorNotFoundPage from "./ErrorNotFoundPage";
import ErrorPage from "./ErrorPage";
import UnsavedChangesGuard from "./UnsavedChangesGuard";
import { selectHasUnsavedChanges } from "../redux/project/selectors";
import clsx from "clsx";
import { computeMode } from "../lib/layout";

export default function App() {
  const err = useSelector((state) => state?.error.msg);
  const width = useSelector((state) => state?.window.width);
  const height = useSelector((state) => state?.window.height);
  const hasUnsavedCode = useSelector(selectHasUnsavedChanges);

  // The unsaved draft only lives in the store, so leaving the page (refresh,
  // close, log-out redirect) would lose it silently. In-app navigation is
  // safe: the draft survives in the store and reloading the same project
  // keeps it (see redux/project reducer + saga).
  useEffect(() => {
    if (!hasUnsavedCode) {
      return undefined;
    }
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasUnsavedCode]);
  // The body class drives the editor height and emulator-frame CSS, so it must
  // follow the layout mode (height-aware), not raw width.
  const mode = computeMode(width, height);
  const className = clsx("pb-1", mode === "tab" ? "mobile" : "desktop");

  return (
    <Titled title={() => "Code · ZX Play"}>
      <RenderEmulator />
      <LoadingScreen />
      <LockScreen />
      <UnsavedChangesGuard />
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
                path="/bot"
                element={
                  <MaxWidth>
                    <BotPage />
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
                path="/new/nextbas"
                element={
                  <MaxWidth>
                    <NewProjectPage type="nextbas" />
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
                path="/new/pascal"
                element={
                  <MaxWidth>
                    <NewProjectPage type="pascal" />
                  </MaxWidth>
                }
              />
              <Route
                exact
                path="/new/sjasmplus"
                element={
                  <MaxWidth>
                    <NewProjectPage type="sjasmplus" />
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
              <Route exact path="/projects/:id/stars" element={<Stargazers />} />
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
              <Route exact path="/profiles" element={<PublicProfiles />} />
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
