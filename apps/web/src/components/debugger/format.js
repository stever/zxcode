export const hex16 = (v) => (v & 0xFFFF).toString(16).toUpperCase().padStart(4, "0");

export const hex8 = (v) => (v & 0xFF).toString(16).toUpperCase().padStart(2, "0");

export const parseAddress = (text) => {
  const cleaned = text.trim().replace(/^\$|^0x/i, "");
  if (!/^[0-9a-f]{1,4}$/i.test(cleaned)) return null;
  return parseInt(cleaned, 16);
};

export const asciiByte = (b) => (b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : ".");
