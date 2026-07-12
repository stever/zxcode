; DFFDPaging — sjasmplus port of Threetwosevensixseven/ZXSpectrumNextTests
; DFFDPaging.asm (MIT; upstream commit d0e14d38b821). Build: build.sh.
;
; Deviations from upstream, all outside the test content: sjasmplus +
; SAVENEX instead of Zeus + output_z80; the ParaSys stub is dropped;
; `vars` (upstream: after the ParaSys include) is placed at $5B00.
;
; The test: write distinct markers into 16K bank 1 and bank 3 of
; metabank 0 and metabank 1 (port $DFFD high-bank extension), then read
; them back through $7FFD, $DFFD and MMU paging combinations, recording
; each value into the screen bitmap and each NR$56/$57 read-back into
; the vars array.

    DEVICE ZXSPECTRUMNEXT

Stack   EQU Start
vars    EQU $5B00

    MACRO PageBankS bank
        ld bc, $7FFD
        di
        ld a, (bank & 7) | 16
        out (c), a
    ENDM

    MACRO PageBankN bank
        nextreg $56, bank*2
        nextreg $57, (bank*2)+1
    ENDM

    MACRO PortOut port, value
        ld bc, port
        ld a, value
        out (c), a
    ENDM

    MACRO NextRegRead register
        ld bc, $243B
        ld a, register
        out (c), a
        inc b
        in a, (c)
    ENDM

    MMU 3, 11           ; $6000 maps 8K page 11 (16K bank 5 upper) at runtime
    ORG $6000
Start:
    di
    ld sp, Stack
    ld a, $BE
    ld i, a
    im 2
    call Cls
    call ClsAttr

; Setup
    ld a, 7
    out ($FE), a        ; white border
    PortOut $123B, $00  ; hide layer 2, disable write paging
    nextreg $15, %00000110
    ld iy, vars

    PortOut $DFFD, 0    ; metabank 0
    PageBankS 1
    ld a, %001
    ld ($C000), a       ; marker in metabank 0 bank 1
    PageBankS 3
    ld a, %101
    ld ($C000), a       ; marker in metabank 0 bank 3

    PortOut $DFFD, 1    ; metabank 1
    PageBankS 1
    ld a, %011
    ld ($C000), a       ; marker in metabank 1 bank 1 (= bank 9)
    PageBankS 3
    ld a, %11011
    ld ($C000), a       ; marker in metabank 1 bank 3 (= bank 11)

    PortOut $DFFD, 0
    PageBankS 1
; Test 7FFD
    PortOut $DFFD, 0
    NextRegRead $56
    ld (iy+0), a
    NextRegRead $57
    ld (iy+1), a
    PageBankN 1
    NextRegRead $56
    ld (iy+2), a
    NextRegRead $57
    ld (iy+3), a
    ld a, ($C000)
    ld ($4000), a
    PortOut $DFFD, 1
    NextRegRead $56
    ld (iy+4), a
    NextRegRead $57
    ld (iy+5), a
    ld a, ($C000)
    ld ($4001), a

    PageBankS 1
    NextRegRead $56
    ld (iy+6), a
    NextRegRead $57
    ld (iy+7), a
    ld a, ($C000)
    ld ($4002), a

; Test MMU
    PortOut $DFFD, 0
    NextRegRead $56
    ld (iy+8), a
    NextRegRead $57
    ld (iy+9), a
    PageBankN 1
    NextRegRead $56
    ld (iy+10), a
    NextRegRead $57
    ld (iy+11), a
    ld a, ($C000)
    ld ($4004), a

    PortOut $DFFD, 1
    NextRegRead $56
    ld (iy+12), a
    NextRegRead $57
    ld (iy+13), a
    ld a, ($C000)
    ld ($4005), a

    PageBankN 1
    NextRegRead $56
    ld (iy+14), a
    NextRegRead $57
    ld (iy+15), a
    ld a, ($C000)
    ld ($4006), a
Loop:
    ei
    halt
    jp Loop

Cls:
    di
    ld (Cls_exit+1), sp
    ld sp, $5800
    ld de, $0000
    ld b, e
Cls_loop:
    DUP 12
        push de
    EDUP
    djnz Cls_loop
Cls_exit:
    ld sp, $0000
    ret

ClsAttr:
    ld a, $38
    ld hl, $5800
    ld (hl), a
    ld de, $5801
    ld bc, $2FF
    ldir
    ret

; IM2 vector table + handler, as upstream
    MMU 5, 5
    ORG $BE00
    DUP 257
        db $BF
    EDUP
    ORG $BFBF
    ei
    reti

    SAVENEX OPEN "DFFDPaging.nex", Start, Stack
    SAVENEX CORE 3, 0, 0
    SAVENEX CFG 7
    SAVENEX AUTO
    SAVENEX CLOSE
