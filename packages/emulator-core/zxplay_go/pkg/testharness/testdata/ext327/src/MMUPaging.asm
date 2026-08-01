; MMUPaging — sjasmplus port of Threetwosevensixseven/ZXSpectrumNextTests
; MMUPaging.asm (MIT; upstream commit d0e14d38b821). Build: build.sh.
;
; Deviations from upstream, all outside the test content:
;   - assembled with sjasmplus + SAVENEX instead of Zeus + output_z80
;     (Zeus is a Windows-only assembler; this keeps the build
;     reproducible on CI machines)
;   - the ParaSys remote-debugger stub (BootTestSetup/BootTest) is
;     dropped — it is instrumentation, not test content
;   - the two build variants of the upstream `Standard` optionbool are
;     selected with -DSTANDARD
;
; The test: page 16K banks holding known marker bytes at $C000 via port
; $7FFD (Standard) or via the MMU at $0000 (default), copying each
; marker read into the screen bitmap at $4000+2n. The MMU variant's
; third read checks that a $7FFD write does NOT disturb MMU slots 0/1.

    DEVICE ZXSPECTRUMNEXT

Stack   EQU Start

    MACRO PageBankS bank
        ld bc, $7FFD
        di
        ld a, (bank & 7) | 16
        out (c), a
        ei
    ENDM

; Upstream PageBankN writes NextReg $50/$51 via the port pair: MMU
; slots 0/1 ($0000-$3FFF) get the two 8K halves of 16K bank `bank`.
; (The upstream comment says slot 6/7 but the code targets $50/$51;
; the reads at $001E confirm slots 0/1 are intended.)
    MACRO PageBankN bank
        ld bc, $243B
        ld a, $50
        ld e, bank*2
        out (c), a
        inc b
        out (c), e
        dec b
        inc a
        out (c), a
        inc b
        inc e
        out (c), e
        ei
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

    nextreg $14, $E3    ; global transparency = bright magenta
    ld bc, $123B        ; hide layer 2, disable write paging
    ld a, 0
    out (c), a
    nextreg $15, %00000110

    IFDEF STANDARD
        PageBankS 1
        ld a, ($C000)
        ld ($4000), a

        PageBankS 3
        ld a, ($C01E)
        ld ($4002), a

        PageBankS 4
        ld a, ($C000)
        ld ($4004), a

        PageBankS 6
        ld a, ($C000)
        ld ($4006), a
    ELSE
        PageBankS 1
        ld a, ($C000)
        ld ($4000), a

        PageBankN 3
        ld a, ($001E)
        ld ($4002), a

        PageBankS 3
        ld a, ($C01E)
        ld ($4004), a

        ; upstream repeats the read WITHOUT re-paging: the $7FFD write
        ; above must not have disturbed MMU slots 0/1
        ld a, ($001E)
        ld ($4006), a

        PageBankN 4
        ld a, ($001E)
        ld ($4008), a
    ENDIF

Loop:
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
    ei
    ret

ClsAttr:
    ld a, $38           ; dim black-on-white paper
    ld hl, $5800
    ld (hl), a
    ld de, $5801
    ld bc, $2FF
    ldir
    ret

; IM2 vector table + handler, as upstream ($BE00 = 16K bank 2 upper 8K)
    MMU 5, 5
    ORG $BE00
    DUP 257
        db $BF
    EDUP
    ORG $BFBF
    ei
    reti

; Bank marker bytes (upstream org zeuspage(n) blocks)
    MMU 6, 2            ; 16K bank 1 low half
    ORG $C000
    db $FF
    MMU 6, 6            ; 16K bank 3 low half
    ORG $C000
    ds $1E
    db $AA
    MMU 6, 8            ; 16K bank 4 low half
    ORG $C000
    db $CC
    ds $1D
    db $CC
    MMU 6, 12           ; 16K bank 6 low half
    ORG $C000
    db $49

    IFDEF STANDARD
        SAVENEX OPEN "MMUPaging7FFD.nex", Start, Stack
    ELSE
        SAVENEX OPEN "MMUPagingMMU.nex", Start, Stack
    ENDIF
    SAVENEX CORE 3, 0, 0
    SAVENEX CFG 7
    SAVENEX AUTO
    SAVENEX CLOSE
