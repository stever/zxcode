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
export function projectFileNameError(name) {
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
  return null;
}

// Files can carry an optional folder path (mirrors the project_file_folder_check
// DB constraint). The relative path folder/name is the file's identity
// everywhere: how code references it (INCLUDE, #include, LOAD), where the
// compile services and the Next's SD card stage it, and where it sits in the
// downloaded ZIP — so the bundle works unchanged on a real card. Uniqueness
// is per full path, letting different folders hold the same base name.
export const MAX_FOLDER_LENGTH = 128;
const PROJECT_FOLDER_RE =
  /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}(\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,63})*$/;

// Splits "assets/sprites/tiles.spr" into folder "assets/sprites" and name
// "tiles.spr"; a path without a slash is a root file with an empty folder.
export function splitProjectFilePath(path) {
  const input = path || "";
  const slash = input.lastIndexOf("/");
  if (slash < 0) {
    return { folder: "", name: input };
  }
  return { folder: input.slice(0, slash), name: input.slice(slash + 1) };
}

export function joinProjectFilePath(folder, name) {
  return folder ? `${folder}/${name}` : name;
}

// Validates a full "folder/name" path as typed in the file-name dialog,
// against the project's other paths for duplicates. Returns an i18n key
// describing the problem, or null when valid.
export function projectFilePathError(path, existingPaths = []) {
  const { folder, name } = splitProjectFilePath(path);
  if ((path || "").includes("/")
      && (folder.length > MAX_FOLDER_LENGTH || !PROJECT_FOLDER_RE.test(folder))) {
    return "editor.files.invalidFolder";
  }
  const nameError = projectFileNameError(name);
  if (nameError) {
    return nameError;
  }
  // The reserved/output rules cover folder segments too: on disk a directory
  // named program.* would clash with the main source, and a *.tap/*.nex
  // directory would match the compile services' output scan.
  for (const seg of folder ? folder.split("/") : []) {
    const segLower = seg.toLowerCase();
    if (segLower.split(".", 1)[0] === "program") {
      return "editor.files.reservedName";
    }
    if (segLower.endsWith(".tap") || segLower.endsWith(".nex")) {
      return "editor.files.outputName";
    }
  }
  const lower = (path || "").toLowerCase();
  for (const p of existingPaths) {
    const pl = p.toLowerCase();
    if (pl === lower) {
      return "editor.files.duplicateName";
    }
    // Staged on disk, a file and a folder cannot share a name: reject a path
    // that would nest inside an existing file, or turn an existing file's
    // parent path into a file.
    if (pl.startsWith(`${lower}/`) || lower.startsWith(`${pl}/`)) {
      return "editor.files.pathConflict";
    }
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

// Languages whose compile path returns a source map, enabling editor gutter
// breakpoints and the paused-line highlight. sjasmplus emits an SLD
// line-to-address map (lib/debugger/sld.js); the interpreted BASICs
// (nextbas, basic/zmakebas, bas2tap) map editor lines to BASIC line numbers
// (lib/debugger/basicMap.js), armed through the engine's PPC-watching
// basic-bp; zxbasic (Boriel, compiled) maps file lines through the
// --enable-break per-line runtime call (lib/debugger/lineCallMap.js),
// armed through the engine's linecall breakpoints; pascal (Pasta80) and c
// (z88dk) map file lines to addresses via listings their services parse
// (lib/debugger/pasta80Map.js, z88dkMap.js), armed as plain address
// breakpoints. Other toolchains would need a listing/map parser first.
const SOURCE_DEBUG_LANGS = new Set(
    ["sjasmplus", "nextbas", "basic", "bas2tap", "zxbasic", "pascal", "c"]);

export function languageSupportsSourceDebug(lang) {
  return SOURCE_DEBUG_LANGS.has(lang);
}
