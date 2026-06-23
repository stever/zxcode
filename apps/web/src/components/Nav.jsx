import React, { useEffect } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useNavigate } from "react-router-dom";
import { Nav as Deck } from "@zxplay/ui";
import {
  pause,
  showOpenFileDialog,
  viewFullScreen,
} from "../redux/jsspeccy/actions";
import { downloadProjectTap } from "../redux/eightbit/actions";
import { getUserInfo } from "../redux/identity/actions";
import { login, logout } from "../auth";
import { resetEmulator, setMachine } from "../redux/app/actions";
import { getLanguageLabel } from "../lib/lang";
import { useTranslation } from "@zxplay/i18n";
import Constants from "../constants";

export default function Nav() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const pathname = useSelector((state) => state?.router.location.pathname);
  const selectedDemoTab = useSelector((state) => state?.demo.selectedTabIndex);
  const emuVisible =
    (pathname === "/" && selectedDemoTab === 0) ||
    pathname.startsWith("/projects/");

  const userId = useSelector((state) => state?.identity.userId);
  const userSlug = useSelector((state) => state?.identity.userSlug);
  const lang = useSelector((state) => state?.project.lang);
  const machine = useSelector((state) => state?.app.machine);
  const machineLocked = useSelector((state) => state?.app.machineLocked);

  const model = getMenuItems(
    t,
    navigate,
    userId,
    userSlug,
    dispatch,
    lang,
    emuVisible,
    machine,
    machineLocked
  );

  const isMobile = useSelector((state) => state?.window.isMobile);

  useEffect(() => {
    dispatch(getUserInfo());
  }, []);

  return (
    <Deck
      model={model}
      brandTitle="Code · ZX Play"
      onBrand={() => navigate("/")}
      isMobile={isMobile}
    />
  );
}

function getMenuItems(t, navigate, userId, userSlug, dispatch, lang, emuVisible, machine, machineLocked) {
  const sep = {
    separator: true,
  };

  const newPasmo = {
    label: getLanguageLabel("asm"),
    command: () => {
      dispatch(pause());
      navigate("/new/asm");
    },
  };

  const newZmac = {
    label: getLanguageLabel("zmac"),
    command: () => {
      dispatch(pause());
      navigate("/new/zmac");
    },
  };

  const newBoriel = {
    label: getLanguageLabel("zxbasic"),
    command: () => {
      dispatch(pause());
      navigate("/new/zxbasic");
    },
  };

  const newBasic = {
    label: getLanguageLabel("basic"),
    command: () => {
      dispatch(pause());
      navigate("/new/basic");
    },
  };

  const newBas2Tap = {
    label: getLanguageLabel("bas2tap"),
    command: () => {
      dispatch(pause());
      navigate("/new/bas2tap");
    },
  };

  const newZ88dk = {
    label: getLanguageLabel("c"),
    command: () => {
      dispatch(pause());
      navigate("/new/c");
    },
  };

  const newSdcc = {
    label: getLanguageLabel("sdcc"),
    command: () => {
      dispatch(pause());
      navigate("/new/sdcc");
    },
  };

  const otherMenu = { label: t("nav.other"), items: [] };
  otherMenu.items.push(newBas2Tap);
  otherMenu.items.push(newZmac);
  if (Constants.enableZ88dk) otherMenu.items.push(newZ88dk);
  otherMenu.items.push(newSdcc);

  const newProjectItems = [];
  newProjectItems.push(newBasic);
  if (Constants.enableBoriel) newProjectItems.push(newBoriel);
  newProjectItems.push(newPasmo);
  newProjectItems.push(otherMenu);

  const projectMenu = {
    label: t("nav.project"),
    icon: "pi pi-fw pi-file",
    items: [
      {
        label: t("nav.newProject"),
        icon: "pi pi-fw pi-plus",
        disabled: !userId,
        items: newProjectItems,
      },
      {
        label: t("nav.openProject"),
        icon: "pi pi-fw pi-folder-open",
        disabled: !userId,
        command: () => {
          // Use slug if available, otherwise fallback to userId
          navigate(`/u/${userSlug || userId}/projects`);
        },
      },
      {
        separator: true,
      },
      {
        label: t("nav.downloadTap"),
        icon: "pi pi-fw pi-download",
        disabled: typeof lang === "undefined",
        command: () => {
          dispatch(downloadProjectTap());
        },
      },
    ],
  };

  const viewFullScreenMenuItem = {
    label: t("nav.fullScreen"),
    icon: "pi pi-fw pi-window-maximize",
    disabled: !emuVisible,
    command: () => {
      dispatch(viewFullScreen());
    },
  };

  const viewProfileMenuItem = {
    label: t("nav.yourProfile"),
    icon: "pi pi-fw pi-user",
    disabled: !userId,
    command: () => {
      // Use slug if available, otherwise fallback to userId
      navigate(`/u/${userSlug || userId}`);
    },
  };

  const profileSettingsMenuItem = {
    label: t("nav.profileSettings"),
    icon: "pi pi-fw pi-cog",
    disabled: !userId,
    command: () => {
      navigate(`/settings/profile`);
    },
  };

  const feedMenuItem = {
    label: t("nav.feed"),
    icon: "pi pi-fw pi-list",
    disabled: !userId,
    command: () => {
      navigate(`/feed`);
    },
  };

  const publicProfilesMenuItem = {
    label: t("nav.publicProfiles"),
    icon: "pi pi-fw pi-users",
    command: () => {
      navigate(`/profiles`);
    },
  };

  const viewMenu = {
    label: t("nav.view"),
    icon: "pi pi-fw pi-eye",
    items: [],
  };

  viewMenu.items.push(viewFullScreenMenuItem);
  viewMenu.items.push(sep);
  viewMenu.items.push(feedMenuItem);
  viewMenu.items.push(publicProfilesMenuItem);
  viewMenu.items.push(viewProfileMenuItem);
  viewMenu.items.push(profileSettingsMenuItem);

  const infoMenu = {
    label: t("nav.info"),
    icon: "pi pi-fw pi-info-circle",
    items: [
      {
        label: t("nav.aboutThisSite"),
        icon: "pi pi-fw pi-question-circle",
        command: () => {
          navigate("/about");
        },
      },
      {
        label: t("nav.privacyPolicy"),
        icon: "pi pi-fw pi-eye",
        command: () => {
          navigate("/privacy-policy");
        },
      },
      {
        label: t("nav.termsOfUse"),
        icon: "pi pi-fw pi-info-circle",
        command: () => {
          navigate("/terms-of-use");
        },
      },
    ],
  };

  const machineMenu = {
    label: t("nav.machine"),
    icon: "pi pi-fw pi-desktop",
    items: [
      {
        label: t("nav.machine48"),
        icon: machine === 48 ? "pi pi-fw pi-check" : "pi pi-fw",
        disabled: machineLocked,
        command: () => {
          dispatch(setMachine(48));
        },
      },
      {
        label: t("nav.machine128"),
        icon: machine === 128 ? "pi pi-fw pi-check" : "pi pi-fw",
        disabled: machineLocked,
        command: () => {
          dispatch(setMachine(128));
        },
      },
    ],
  };

  const resetButton = {
    label: t("nav.reset"),
    icon: "pi pi-fw pi-power-off",
    command: () => {
      dispatch(resetEmulator());
    },
  };

  const loginButton = {
    label: userId ? t("nav.logOut") : t("nav.logIn"),
    icon: userId ? "pi pi-fw pi-sign-out" : "pi pi-fw pi-sign-in",
    command: () => {
      userId ? logout() : login();
    },
  };

  return [projectMenu, viewMenu, machineMenu, infoMenu, resetButton, loginButton];
}
