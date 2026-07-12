; Level2Order — sjasmplus port of Threetwosevensixseven/ZXSpectrumNextTests
; Level2Order.asm (MIT; upstream commit d0e14d38b821). Build: build.sh,
; six variants via -DORDER=0..5 (SLU LSU SUL LUS USL ULS).
;
; Deviations from upstream, all outside the ordering content under test:
;   - sjasmplus + SAVENEX instead of Zeus + output_z80; ParaSys dropped
;   - upstream sets `nextreg $12, 28` while filling Layer 2 through MMU
;     8K pages 24-29 (= 16K banks 12-14). NR$12 is a 16K bank number, so
;     28 points at different memory than the fills; corrected to 12 so
;     the Layer 2 banks are the ones the test fills (upstream slip)
;   - upstream writes `nextreg $74, $00` commented "transparency
;     fallback"; the fallback register is NR$4A ($74 is a sprite
;     attribute port). Ported as NR$4A = $00 to preserve the intent
;     (black fallback)
;
; The test: ULA shows vertical stripes whose PAPER (bright magenta) is
; redefined to the global transparency colour, Layer 2 shows a red top
; third, transparent middle third and green bottom third, and two
; sprites sit in the top and middle thirds. NR$15 selects one of the six
; layer orderings; every region of the composite then reveals which
; layer won.

    DEVICE ZXSPECTRUMNEXT

    IFNDEF ORDER
        DEFINE ORDER 0
    ENDIF

Stack   EQU $FFFF

    MACRO Fill addr, size, value
        ld a, value
        ld hl, addr
        ld (hl), a
        ld de, addr+1
        ld bc, size-1
        ldir
    ENDM

    MMU 6, 0            ; $C000 maps 8K page 0 (16K bank 0) at runtime
    ORG $C000
Start:
    di
    ld sp, Stack
    ld a, $BE
    ld i, a
    im 2

    xor a
    out ($FE), a        ; black border
    Fill $4000, $1800, $AA  ; ULA pixels: vertical stripes
    Fill $5800, $1B00, $59  ; ULA attrs: bright blue ink / magenta paper
    nextreg $14, $E3    ; global transparency = bright magenta
    nextreg $4A, $00    ; transparency fallback = black (upstream: $74)

    nextreg $43, $00    ; first palettes, autoincrement, edit ULA palette
    nextreg $40, $1B    ; bright magenta paper index
    nextreg $41, $E3    ; redefine to the global transparency colour

    nextreg $50, 24     ; MMU-page the bottom 48K to the Layer 2 banks
    nextreg $51, 25
    nextreg $52, 26
    nextreg $53, 27
    nextreg $54, 28
    nextreg $55, 29
    nextreg $12, 12     ; Layer 2 = 16K banks 12-14 (upstream: 28; see header)

    Fill $0000, $4000, $C0  ; Layer 2 top    third: red
    Fill $4000, $4000, $E3  ; Layer 2 middle third: transparent
    Fill $8000, $4000, $1C  ; Layer 2 bottom third: green

    ld bc, $123B        ; Layer 2 visible, write paging disabled
    ld a, $02
    out (c), a

    nextreg $15, (ORDER*4)+3    ; enable sprites, over border, ordering

    ; sprite pattern + two sprites (top and middle thirds)
    ld hl, TestSprite
    ld a, 0
    call WriteSpritePattern
    ld a, 0             ; sprite 0 at (32,48)
    ld hl, 32+32+((48+32)*256)
    ld de, $00+($80*256)
    call WriteNextSprite
    ld a, 1             ; sprite 1 at (32,64)
    ld hl, 32+32+((64+32)*256)
    ld de, $00+($80*256)
    call WriteNextSprite

    nextreg $50, 255    ; MMU-page the bottom 48K back
    nextreg $51, 255
    nextreg $52, 10
    nextreg $53, 11
    nextreg $54, 4
    nextreg $55, 5
    ei
Loop:
    halt
    jp Loop

WriteSpritePattern:
    ld bc, $303B
    out (c), a
    ld d, 0
    ld bc, $5B
WSP_loop:
    ld e, (hl)
    inc hl
    out (c), e
    dec d
    jr nz, WSP_loop
    ret

WriteNextSprite:
    ld bc, $303B
    out (c), a
    ld bc, $57
    out (c), l
    out (c), h
    out (c), e
    out (c), d
    ret

TestSprite:
    db  $E3, $E3, $E3, $E0, $E1, $E0, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3
    db  $E3, $E3, $1D, $19, $35, $19, $1D, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3
    db  $E3, $E3, $C1, $C1, $C1, $C1, $C1, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3
    db  $E3, $E3, $E3, $E0, $E8, $E0, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3
    db  $C1, $E0, $FF, $E1, $C5, $E1, $FF, $E0, $C1, $E3, $E3, $E3, $E3, $E3, $E3, $E3
    db  $F5, $E0, $E0, $DF, $BF, $DF, $E0, $E0, $F5, $E3, $E3, $E3, $E3, $E3, $E3, $E3
    db  $F9, $E3, $E0, $E0, $FF, $E0, $E0, $E3, $F9, $E3, $E3, $E3, $E3, $E3, $E3, $E3
    db  $FC, $E3, $E3, $C0, $E0, $C0, $E3, $E3, $FC, $E3, $E3, $E3, $E3, $E3, $E3, $E3
    db  $E3, $E3, $E3, $C0, $E0, $C0, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3
    db  $E3, $E3, $E1, $E1, $E3, $E1, $E1, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3
    db  $E3, $E3, $C4, $C4, $E3, $C4, $C4, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3
    db  $E3, $FD, $FC, $F5, $E3, $F5, $FC, $FC, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3
    db  $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3
    db  $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3
    db  $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3
    db  $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3, $E3

; IM2 vector table + handler, as upstream ($BE00 = 16K bank 2 upper 8K)
    MMU 5, 5
    ORG $BE00
    DUP 257
        db $BF
    EDUP
    ORG $BFBF
    ei
    reti

; Layer 2 content is written at runtime through the MMU; the banks only
; need to exist, which SAVENEX AUTO guarantees via this touch.
    MMU 7, 29
    ORG $E000
    db 0

    SAVENEX OPEN "Level2Order.nex", Start, Stack
    SAVENEX CORE 3, 0, 0
    SAVENEX CFG 7
    SAVENEX AUTO
    SAVENEX CLOSE
