export function getLanguageLabel(lang) {
  const labels = {
    asm: "Pasmo",
    basic: "zmakebas",
    bas2tap: "bas2tap",
    c: "z88dk C",
    sdcc: "SDCC",
    zmac: "zmac",
    zxbasic: "Boriel BASIC",
  };
  return labels[lang] || lang;
}
