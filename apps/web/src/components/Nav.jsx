import React, { useEffect } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useNavigate } from "react-router-dom";
import { Menubar } from "primereact/menubar";
import {
  pause,
  showOpenFileDialog,
  viewFullScreen,
} from "../redux/jsspeccy/actions";
import { downloadProjectTap } from "../redux/eightbit/actions";
import { getUserInfo } from "../redux/identity/actions";
import { login, logout } from "../auth";
import { resetEmulator } from "../redux/app/actions";
import { getLanguageLabel } from "../lib/lang";
import Constants from "../constants";

export default function Nav() {
  const dispatch = useDispatch();
  const navigate = useNavigate();

  const pathname = useSelector((state) => state?.router.location.pathname);
  const selectedDemoTab = useSelector((state) => state?.demo.selectedTabIndex);
  const emuVisible =
    (pathname === "/" && selectedDemoTab === 0) ||
    pathname.startsWith("/projects/");

  const userId = useSelector((state) => state?.identity.userId);
  const userSlug = useSelector((state) => state?.identity.userSlug);
  const lang = useSelector((state) => state?.project.lang);

  const items = getMenuItems(
    navigate,
    userId,
    userSlug,
    dispatch,
    lang,
    emuVisible
  );

  const isMobile = useSelector((state) => state?.window.isMobile);
  const className = isMobile ? "" : "px-2 pt-2";

  useEffect(() => {
    dispatch(getUserInfo());
  }, []);

  return (
    <div className={className}>
      <Menubar
        model={items}
        start={
          <img alt="logo" src="/logo.png" height={"40"} className="mx-1" />
        }
        style={{
          borderRadius: isMobile ? 0 : "5px",
          borderColor: "#1E1E1E",
        }}
      />
    </div>
  );
}

function getMenuItems(navigate, userId, userSlug, dispatch, lang, emuVisible) {
  const sep = {
    separator: true,
  };

  const homeButton = {
    label: "Code . ZX Play",
    command: () => {
      navigate("/");
    },
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

  const otherMenu = { label: "Other", items: [] };
  if (Constants.enableBoriel) otherMenu.items.push(newBoriel);
  otherMenu.items.push(newBas2Tap);
  otherMenu.items.push(newZmac);
  if (Constants.enableZ88dk) otherMenu.items.push(newZ88dk);
  otherMenu.items.push(newSdcc);

  const newProjectItems = [];
  newProjectItems.push(newBasic);
  newProjectItems.push(newPasmo);
  newProjectItems.push(otherMenu);

  const projectMenu = {
    label: "Project",
    icon: "pi pi-fw pi-file",
    items: [
      {
        label: "New Project",
        icon: "pi pi-fw pi-plus",
        disabled: !userId,
        items: newProjectItems,
      },
      {
        label: "Open Project",
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
      // {
      //   label: "Upload TAP",
      //   icon: "pi pi-fw pi-upload",
      //   command: () => {
      //     dispatch(showOpenFileDialog());
      //     navigate("/");
      //   },
      // },
      {
        label: "Download TAP",
        icon: "pi pi-fw pi-download",
        disabled: typeof lang === "undefined",
        command: () => {
          dispatch(downloadProjectTap());
        },
      },
    ],
  };

  const viewFullScreenMenuItem = {
    label: "Full Screen",
    icon: "pi pi-fw pi-window-maximize",
    disabled: !emuVisible,
    command: () => {
      dispatch(viewFullScreen());
    },
  };

  const viewProfileMenuItem = {
    label: "Your Profile",
    icon: "pi pi-fw pi-user",
    disabled: !userId,
    command: () => {
      // Use slug if available, otherwise fallback to userId
      navigate(`/u/${userSlug || userId}`);
    },
  };

  const profileSettingsMenuItem = {
    label: "Profile Settings",
    icon: "pi pi-fw pi-cog",
    disabled: !userId,
    command: () => {
      navigate(`/settings/profile`);
    },
  };

  const feedMenuItem = {
    label: "Feed",
    icon: "pi pi-fw pi-list",
    disabled: !userId,
    command: () => {
      navigate(`/feed`);
    },
  };

  const viewMenu = {
    label: "View",
    icon: "pi pi-fw pi-eye",
    items: [],
  };

  viewMenu.items.push(viewFullScreenMenuItem);
  viewMenu.items.push(sep);
  viewMenu.items.push(feedMenuItem);
  viewMenu.items.push(viewProfileMenuItem);
  viewMenu.items.push(profileSettingsMenuItem);

  const infoMenu = {
    label: "Info",
    icon: "pi pi-fw pi-info-circle",
    items: [
      {
        label: "About This Site",
        icon: "pi pi-fw pi-question-circle",
        command: () => {
          navigate("/about");
        },
      },
      {
        label: "Privacy Policy",
        icon: "pi pi-fw pi-eye",
        command: () => {
          navigate("/privacy-policy");
        },
      },
      {
        label: "Terms of Use",
        icon: "pi pi-fw pi-info-circle",
        command: () => {
          navigate("/terms-of-use");
        },
      },
    ],
  };

  const resetButton = {
    label: "Reset",
    icon: "pi pi-fw pi-power-off",
    command: () => {
      dispatch(resetEmulator());
    },
  };

  const loginButton = {
    label: userId ? "Sign-out" : "Sign-in",
    icon: userId ? "pi pi-fw pi-sign-out" : "pi pi-fw pi-sign-in",
    command: () => {
      userId ? logout() : login();
    },
  };

  return [
    homeButton,
    projectMenu,
    viewMenu,
    infoMenu,
    resetButton,
    loginButton,
  ];
}
