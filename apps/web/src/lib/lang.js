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

// Display name for a project's main source file. It mirrors the fixed name
// the compile services stage the source under (program.asm / program.bas /
// program.c / program.pas), which is also how their diagnostics refer to it.
const MAIN_FILE_EXTENSIONS = {
  asm: "asm",
  sjasmplus: "asm",
  zmac: "asm",
  basic: "bas",
  bas2tap: "bas",
  nextbas: "bas",
  zxbasic: "bas",
  c: "c",
  sdcc: "c",
  pascal: "pas",
};

export function mainFileName(lang) {
  return `program.${MAIN_FILE_EXTENSIONS[lang] || "txt"}`;
}

// Languages whose toolchain can consume additional project files (compile
// includes / INCBIN assets, or SD-card files LOADed at runtime on the Next).
// zmakebas and bas2tap have no include mechanism and their TAPs carry only
// the tokenised program, so extra files would be dead weight — the add-file
// UI is hidden for them.
const NO_PROJECT_FILE_LANGS = new Set(["basic", "bas2tap"]);

export function languageSupportsProjectFiles(lang) {
  return !NO_PROJECT_FILE_LANGS.has(lang);
}

// Additional project files: constraints shared with the project_file DB check
// and the compile services' staging validation. Names stemmed 'program' are
// reserved for the main source and compiler outputs; .tap/.nex would collide
// with the sjasmplus output scan.
export const MAX_PROJECT_FILES = 32;
export const MAX_FILE_CONTENT_SIZE = 256 * 1024;
const PROJECT_FILE_NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;

// Returns an i18n key describing the problem, or null when the name is valid.
export function projectFileNameError(name, existingNames = []) {
  if (!PROJECT_FILE_NAME_RE.test(name || "")) {
    return "editor.files.invalidName";
  }
  const lower = name.toLowerCase();
  if (lower.split(".", 1)[0] === "program") {
    return "editor.files.reservedName";
  }
  if (lower.endsWith(".tap") || lower.endsWith(".nex")) {
    return "editor.files.outputName";
  }
  if (existingNames.some((n) => n.toLowerCase() === lower)) {
    return "editor.files.duplicateName";
  }
  return null;
}

// Uploaded files with these extensions are stored as editable text; anything
// else is kept as a base64 binary asset (INCBIN data etc.).
const TEXT_FILE_EXTENSIONS = new Set([
  "asm", "inc", "bas", "c", "h", "pas", "txt", "z80", "def", "cfg", "lua",
]);

export function isTextFileName(name) {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return TEXT_FILE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

// Languages whose compile path returns a line-to-address source map, enabling
// editor gutter breakpoints and the paused-line highlight. Only the sjasmplus
// service emits one today (SLD); other toolchains would need a listing/map
// parser first (see apps/web/src/lib/debugger/sld.js for the shape).
const SOURCE_DEBUG_LANGS = new Set(["sjasmplus"]);

export function languageSupportsSourceDebug(lang) {
  return SOURCE_DEBUG_LANGS.has(lang);
}
