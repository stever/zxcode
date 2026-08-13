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
import { renumberBasic } from "../redux/project/actions";
import { getUserInfo } from "../redux/identity/actions";
import { login, logout } from "../auth";
import {
  resetEmulator,
  setMachine,
  setKeyboardLayout,
  setPixelPerfect,
  setJoystick,
} from "../redux/app/actions";
import { getLanguageLabel, isBasicLang } from "../lib/lang";
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
  const activeFileId = useSelector((state) => state?.project.activeFileId);
  const machine = useSelector((state) => state?.app.machine);
  const joystick = useSelector((state) => state?.app.joystick);
  const keyboardLayout = useSelector((state) => state?.app.keyboardLayout);
  const pixelPerfect = useSelector((state) => state?.app.pixelPerfect);
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
    machineLocked,
    keyboardLayout,
    pixelPerfect,
    joystick,
    activeFileId
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

function getMenuItems(t, navigate, userId, userSlug, dispatch, lang, emuVisible, machine, machineLocked, keyboardLayout, pixelPerfect, joystick, activeFileId) {
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

  const newSjasmplus = {
    label: getLanguageLabel("sjasmplus"),
    command: () => {
      dispatch(pause());
      navigate("/new/sjasmplus");
    },
  };

  const newBoriel = {
    label: getLanguageLabel("zxbasic"),
    command: () => {
      dispatch(pause());
      navigate("/new/zxbasic");
    },
  };

  // One consolidated BASIC (#110): "Sinclair/NextBASIC" (lang nextbas) is
  // txt2bas-tokenised for every machine, so there is a single headline entry
  // instead of the old machine-dependent zmakebas/NextBASIC pair. zmakebas
  // and bas2tap live on under Other as standalone classic tokenisers with
  // their own source conventions.
  const newBasic = {
    label: getLanguageLabel("nextbas"),
    command: () => {
      dispatch(pause());
      navigate("/new/nextbas");
    },
  };

  const newZmakebas = {
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

  const newPascal = {
    label: getLanguageLabel("pascal"),
    command: () => {
      dispatch(pause());
      navigate("/new/pascal");
    },
  };

  const newForth = {
    label: getLanguageLabel("forth"),
    command: () => {
      dispatch(pause());
      navigate("/new/forth");
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
  otherMenu.items.push(newZmakebas);
  otherMenu.items.push(newBas2Tap);
  otherMenu.items.push(newZmac);
  otherMenu.items.push(newSdcc);

  const newProjectItems = [];
  newProjectItems.push(newBasic);
  if (Constants.enableBoriel) newProjectItems.push(newBoriel);
  newProjectItems.push(newPasmo);
  newProjectItems.push(newSjasmplus);
  if (Constants.enableZ88dk) newProjectItems.push(newZ88dk);
  newProjectItems.push(newPascal);
  newProjectItems.push(newForth);
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
        // On the Next the download is the translated artifact, not a tape:
        // a .nex, or a PLUS3DOS .bas for any BASIC dialect (native NextBASIC
        // or a translated Sinclair BASIC TAP) — see the download saga.
        label: t("nav.download", {
          ext: machine === "next" ? (isBasicLang(lang) ? "BAS" : "NEX") : "TAP",
        }),
        icon: "pi pi-fw pi-download",
        disabled: typeof lang === "undefined",
        command: () => {
          dispatch(downloadProjectTap());
        },
      },
      // Renumbering only means something in the dialects the ROM
      // interpreter runs (numbered lines); Boriel is compiled and jumps by
      // label, so the entry hides rather than sits disabled. It IS disabled
      // while a project-file tab is showing: the rewrite targets the main
      // source, and applying it off-screen would be invisible and land
      // outside the visible buffer's undo history.
      ...(isBasicLang(lang)
        ? [
            {
              label: t("nav.renumber"),
              icon: "pi pi-fw pi-sort-numeric-down",
              disabled: activeFileId !== null,
              command: () => {
                dispatch(renumberBasic());
              },
            },
          ]
        : []),
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

  // Served by the auth service, not this app: OTP secrets stay there.
  const twoFactorAuthMenuItem = {
    label: t("nav.twoFactorAuth"),
    icon: "pi pi-fw pi-shield",
    disabled: !userId,
    command: () => {
      window.location.href = `${Constants.authBase}/otp`;
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

  // Draws the screen only at a whole scale of the display, so no Spectrum
  // pixel is wider than its neighbour. It costs whatever is left over, so it
  // is a checkable choice rather than the default.
  const pixelPerfectMenuItem = {
    label: t("nav.pixelPerfect"),
    icon: pixelPerfect ? "pi pi-fw pi-check" : "pi pi-fw",
    command: () => {
      dispatch(setPixelPerfect(!pixelPerfect));
    },
  };

  const viewMenu = {
    label: t("nav.view"),
    icon: "pi pi-fw pi-eye",
    items: [],
  };

  viewMenu.items.push(viewFullScreenMenuItem);
  viewMenu.items.push(pixelPerfectMenuItem);
  viewMenu.items.push(sep);
  viewMenu.items.push(feedMenuItem);
  viewMenu.items.push(publicProfilesMenuItem);
  viewMenu.items.push(viewProfileMenuItem);
  viewMenu.items.push(profileSettingsMenuItem);
  viewMenu.items.push(twoFactorAuthMenuItem);

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
        label: t("nav.mastodonBot"),
        icon: "pi pi-fw pi-send",
        command: () => {
          navigate("/bot");
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

  // Every language runs on every machine (#110): compiled TAPs translate onto
  // the Next, and the BASIC dialects compile per machine — so only a "?m="
  // URL lock disables switching.
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
      {
        // zxgo engine only: the JSSpeccy3 engine has no Next.
        label: "ZX Spectrum Next",
        icon: machine === "next" ? "pi pi-fw pi-check" : "pi pi-fw",
        disabled: machineLocked,
        command: () => {
          dispatch(setMachine("next"));
        },
      },
    ],
  };

  // Which keyboard is drawn. It follows the machine you are building for
  // unless you say otherwise, which is worth being able to say: the program
  // running is not always suited by its target machine's keyboard — a Next
  // program in 48K mode, or a 48K one you would rather type in with the
  // Spectrum+'s dedicated EDIT and cursor keys. Or none of them: while you are
  // debugging with your own keyboard, the drawn one is only taking screen.
  const keyboardMenu = {
    label: t("nav.keyboard", "Keyboard"),
    icon: "pi pi-fw pi-th-large",
    items: [
      ["auto", t("nav.keyboardAuto", "Match Machine")],
      ["rubber", t("nav.keyboardRubber", "Spectrum 48K")],
      ["plus", t("nav.keyboardPlus", "Spectrum 128K")],
      ["next", t("nav.keyboardNext", "ZX Spectrum Next")],
      ["none", t("nav.keyboardNone", "No Keyboard")],
    ].map(([value, label]) => ({
      label,
      icon: keyboardLayout === value ? "pi pi-fw pi-check" : "pi pi-fw",
      command: () => {
        dispatch(setKeyboardLayout(value));
      },
    })),
  };

  // Which interface the gamepad drives. A game reads exactly one and there is
  // no way to detect which, so the user chooses. The labels name the keys the
  // keyboard-based schemes press, since that is how a game's own control
  // screen describes them.
  const joystickMenu = {
    label: t("nav.joystick", "Joystick"),
    icon: "pi pi-fw pi-directions",
    items: [
      ["Kempston", t("nav.joystickKempston", "Kempston")],
      ["Sinclair1", t("nav.joystickSinclair1", "Sinclair 1 (keys 6-0)")],
      ["Sinclair2", t("nav.joystickSinclair2", "Sinclair 2 (keys 1-5)")],
      ["Cursor", t("nav.joystickCursor", "Cursor / Protek")],
    ].map(([value, label]) => ({
      label,
      icon: joystick === value ? "pi pi-fw pi-check" : "pi pi-fw",
      command: () => {
        dispatch(setJoystick(value));
      },
    })),
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

  return [projectMenu, viewMenu, machineMenu, keyboardMenu, joystickMenu, infoMenu, resetButton, loginButton];
}
