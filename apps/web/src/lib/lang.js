export function getLanguageLabel(lang) {
  const labels = {
    asm: "Pasmo Z80",
    basic: "zmakebas",
    bas2tap: "bas2tap",
    c: "z88dk C",
    sdcc: "SDCC",
    zmac: "zmac Z80",
    zxbasic: "Boriel BASIC",
  };
  return labels[lang] || lang;
}
