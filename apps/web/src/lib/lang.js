export function getLanguageLabel(lang) {
  const labels = {
    asm: "Z80 (Pasmo)",
    basic: "Sinclair BASIC",
    bas2tap: "BASIC (bas2tap)",
    c: "z88dk C",
    sdcc: "SDCC",
    zmac: "Z80 (zmac)",
    zxbasic: "Boriel ZX BASIC",
  };
  return labels[lang] || lang;
}
