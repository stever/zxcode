; ULAScreenPaging — sjasmplus port of Threetwosevensixseven/
; ZXSpectrumNextTests ULAScreenPaging.asm (MIT; upstream commit
; d0e14d38b821). Build: build.sh, three variants via -DMODE=0..2
; (128K R/5/2/0, +3 special 0/1/2/3, +3 special 4/5/6/7 — the upstream
; 4/5/6/3 and 4/7/6/3 options have no implementation upstream either).
;
; Deviations from upstream, all outside the paging content under test:
; sjasmplus + SAVENEX instead of Zeus + output_z80/output_sna, and the
; ParaSys stub was never included by this test.
;
; The test: shows main.scr, cycles the $C000 page every frame (128K
; mode), and switches between the main (bank 5) and shadow (bank 7) ULA
; screens via $7FFD bit 3 while key 1 (main, red border) or key 2
; (shadow, green border) is held. The +3 modes first enter the special
; all-RAM configurations via $1FFD — in 4/5/6/7 the code must live in
; bank 6 to survive its own paging switch.

    DEVICE ZXSPECTRUMNEXT

    IFNDEF MODE
        DEFINE MODE 0
    ENDIF

Stack   EQU $FFFF

    MACRO Border colour
        IF colour == 0
            xor a
        ELSE
            ld a, colour
        ENDIF
        out ($FE), a
    ENDM

; main screen into bank 5 ($4000), shadow screen into bank 7
    MMU 2, 10
    ORG $4000
    INCBIN "main.scr"
    MMU 2, 14           ; 16K bank 7 low half
    ORG $4000
    INCBIN "shadow.scr"

    IF MODE == 2
        ; +3 special 4/5/6/7 maps bank 6 at $8000, so the program lives
        ; in bank 6 (as upstream's dispto zeuspage(6) arranges). The
        ; .nex still enters at $8000 with normal paging (bank 2), so a
        ; bank-2 stub performs the switch; execution falls off its final
        ; OUT straight into bank 6, where a jp at the exact same
        ; address picks up.
        MMU 4, 4
        ORG $8000
Start:
        di
        ld a, %00000011 ; +3 special paging 4/5/6/7
        ld bc, $1FFD
        out (c), a      ; next fetch (at Resume) comes from bank 6
Resume  EQU $
        MMU 4, 12
        ORG Resume
        jp Init
    ELSE
        MMU 4, 4        ; default: bank 2 at $8000
        ORG $8000
Start:
        di
        IF MODE == 1
            ld a, %00000001 ; +3 special paging 0/1/2/3 ($8000 stays bank 2)
            ld bc, $1FFD
            out (c), a
        ENDIF
    ENDIF
Init:
    ld sp, Stack
    ld a, $BE
    ld i, a
    im 2
    ei
    Border 0
    xor a
    ld (Page), a
    ld a, 0
    ld (Screen), a
Loop:
    IF MODE == 0
        ld a, (Page)
        inc a
        and %111
        ld (Page), a
    ENDIF

    halt
    Border 0
    ld bc, $F7FE        ; keyboard half-row 1-5
    in a, (c)
    ld d, a
    and 1               ; key 1
    jp nz, Two
    Border 2
    ld a, %00000000
    ld (Screen), a      ; main screen
Two:
    ld a, d
    and 2               ; key 2
    jp nz, Set
    Border 4
    ld a, %00001000
    ld (Screen), a      ; shadow screen
Set:
Screen EQU $+1
    ld a, 0             ; SMC: main or shadow screen bit
Page EQU $+1
    or 0                ; SMC: page 0..7
    ld bc, $7FFD
    out (c), a
    jp Loop

; IM2 vector table + handler, as upstream (same bank as the code).
; Under special paging 4/5/6/7 the $A000-$BFFF window reads bank 6's
; upper half (8K page 13), so the table must assemble there.
    IF MODE == 2
        MMU 5, 13
    ENDIF
    ORG $BE00
    DUP 257
        db $BF
    EDUP
    ORG $BFBF
    ei
    reti

    IF MODE == 0
        SAVENEX OPEN "ULAScreenR520.nex", Start, Stack
    ENDIF
    IF MODE == 1
        SAVENEX OPEN "ULAScreen0123.nex", Start, Stack
    ENDIF
    IF MODE == 2
        SAVENEX OPEN "ULAScreen4567.nex", Start, Stack
    ENDIF
    SAVENEX CORE 3, 0, 0
    SAVENEX CFG 7
    SAVENEX AUTO
    SAVENEX CLOSE
