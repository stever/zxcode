export function getLanguageLabel(lang) {
  const labels = {
    asm: "Pasmo",
    basic: "zmakebas",
    bas2tap: "bas2tap",
    nextbas: "Next BASIC",
    c: "z88dk C",
    pascal: "Pasta80 Pascal",
    sdcc: "SDCC",
    sjasmplus: "sjasmplus",
    zmac: "zmac",
    zxbasic: "Boriel BASIC",
  };
  return labels[lang] || lang;
}

// Which machines a language can target. Sinclair BASIC (zmakebas/bas2tap) is
// 48/128 only; NextBASIC is a Next-only dialect (tokenised by txt2bas); every
// other language is machine-agnostic. Values are strings; the app's machine
// state uses 48/128 as numbers and 'next' as a string, so callers normalise via
// String(machine).
const MACHINE_RULES = {
  basic: ["48", "128"],
  bas2tap: ["48", "128"],
  nextbas: ["next"],
};

export function allowedMachines(lang) {
  return MACHINE_RULES[lang] || ["48", "128", "next"];
}

export function languageAllowedOnMachine(lang, machine) {
  return allowedMachines(lang).includes(String(machine));
}

// Languages whose compile path returns a line-to-address source map, enabling
// editor gutter breakpoints and the paused-line highlight. Only the sjasmplus
// service emits one today (SLD); other toolchains would need a listing/map
// parser first (see apps/web/src/lib/debugger/sld.js for the shape).
const SOURCE_DEBUG_LANGS = new Set(["sjasmplus"]);

export function languageSupportsSourceDebug(lang) {
  return SOURCE_DEBUG_LANGS.has(lang);
}
