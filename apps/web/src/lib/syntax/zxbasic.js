import { defineBasicMode, BORIEL_KEYWORDS } from "./basic-common"

// Boriel's ZX BASIC. A C-like cross-compiler, not the Sinclair/NextBASIC
// interpreter, so it uses its own reserved-word set (BORIEL_KEYWORDS) rather
// than the shared Sinclair base. Its ZX Spectrum Next surface is the Z80/Z80N
// opcode mnemonics accepted by its inline assembler, which highlight only
// inside ASM ... END ASM blocks (asm: true switches on that sub-mode). Source
// of truth for both sets: boriel/zxbasic (src/zxbc/keywords.py and
// src/zxbasm/asmlex.py), pinned to the installed compiler zxbasic==1.18.7.
defineBasicMode("zxbasic", "text/x-zxbasic", {baseKeywords: BORIEL_KEYWORDS, asm: true})
