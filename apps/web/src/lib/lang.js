export function getLanguageLabel(lang) {
  const labels = {
    asm: "Pasmo",
    basic: "zmakebas",
    bas2tap: "bas2tap",
    nextbas: "NextBASIC",
    c: "z88dk C",
    sdcc: "SDCC",
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
