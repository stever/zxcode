import {actionTypes} from "./actions";

// -----------------------------------------------------------------------------
// Initial state
// -----------------------------------------------------------------------------

const initialState = {
    selectedTabIndex: 0,
    asmCode: `org 30000

start:
\tpush bc
    ld hl, hello

again:
\tld a,(hl)
    cp 0
    jr z, exit
    push hl
    rst 10h
    pop hl
    inc hl
    jr again

exit:
    pop bc
    djnz start
    ret

hello:
\tdb "Hello, world.", 0Dh, 0

    end start`,
    sinclairBasicCode: `# this file \`demo.bas' demonstrates the features of zmakebas
# (basically just the escape sequences), and gives you an example of
# what the input can look like if you use all the bells and whistles. :-)

10 rem zmakebas demo

# tabs (as below) are fine (they're removed)
20 let init=\t1000:\\
   let header=\t2000:\\
   let udgdem=\t3000:\\
   let blockdem=4000

30 gosub init
40 gosub header
50 gosub udgdem
60 gosub blockdem
70 stop


# init

1000 for f=usr "a"+7 to usr "u"+7 step 8
1010 poke f,255
1020 next f
1030 let is48=1

# init all attrs just in case
1040 border 7:paper 7:ink 7:bright 0:flash 0:cls

# check for 48k speccy or 48k mode. This is a pretty nasty way to do
# it, but seems to be the most sane way (from Basic at least).
1050 print "\\t"
1060 if screen$(0,0)="S" then let is48=0
1070 ink 0:print at 0,0;
1090 return


# header

2000 print ink 5;"\\..\\..\\..\\..\\..\\..\\..\\..\\..\\..\\..\\..\\..\\..\\..\\..";\\
\t         "\\..\\..\\..\\..\\..\\..\\..\\..\\..\\..\\..\\..\\..\\..\\.."
2010 print paper 5;"  Non-ASCII chars in zmakebas  "
2020 print ink 5;"\\''\\''\\''\\''\\''\\''\\''\\''\\''\\''\\''\\''\\''\\''\\''\\''";\\
\t         "\\''\\''\\''\\''\\''\\''\\''\\''\\''\\''\\''\\''\\''\\''\\''"
2030 print
2040 return


# udgdem

3000 print "Here are the UDGs:"''
3010 print ink 1;"\\a\\b\\c\\d\\e\\f\\g\\h\\i\\j\\k\\l\\m\\n\\o\\p\\q\\r\\s";
3020 if is48 then print ink 1;"\\t\\u";
3030 print ''"(They should be underlined.)"
3040 return


# blockdem

#                   01234567890123456789012345678901
4000 print at 11,0;"The block graphics, first as"'\\
\t\t   "listed by a for..next loop, then"'\\
\t\t   "via zmakebas's escape sequences:"
4010 ink 7
4020 print at 15,0;
4030 for f=128 to 143:print chr$(f);" ";:next f:print ''
4040 print at 17,0;"\\   \\ ' \\'  \\'' \\ . \\ : \\'. \\': ";\\
\t\t   "\\.  \\.' \\:  \\:' \\.. \\.: \\:. \\::"
# draw boxes around them to make it look less confusing
4050 ink 1
4060 for y=0 to 1
4070 for x=0 to 15
4080 plot x*16,55-y*16:draw 7,0:draw 0,-7:draw -7,0:draw 0,7
4090 next x
4100 next y
4110 ink 0
4120 print at 20,0;"And finally here's the copyright"'\\
\t\t   "symbol (";ink 1;"\\*";ink 0;\\
\t\t   ") and pound sign (";ink 1;"\`";ink 0;")."
4130 return`,
    zxBasicCode: `REM From the ZX Spectrum 48K Manual

DIM m, n, c AS BYTE

FOR m = 0 TO 1: BRIGHT m
FOR n = 1 TO 10
FOR c = 0 TO 7
PAPER c: PRINT "    ";: REM 4 coloured spaces
NEXT c: NEXT n: NEXT m

FOR m = 0 TO 1: BRIGHT m: PAPER 7
FOR c = 0 TO 3
INK c: PRINT c; "   ";
NEXT c: PAPER 0
FOR c = 4 TO 7
INK c: PRINT c; "   ";
NEXT c: NEXT m
PAPER 7: INK 0: BRIGHT 0`,
    cCode: `#include <arch/zx.h>
#include <stdio.h>
 
int main()
{
  zx_cls(PAPER_WHITE);
  puts("Hello, world!");
  return 0;
}`
};

// -----------------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------------

function setSelectedTabIndex(state, action) {
    return {
        ...state,
        selectedTabIndex: action.index
    }
}

function setAssemblyCode(state, action) {
    return {
        ...state,
        asmCode: action.code
    }
}

function setSinclairBasicCode(state, action) {
    return {
        ...state,
        sinclairBasicCode: action.code
    }
}

// -----------------------------------------------------------------------------
// Reducer
// -----------------------------------------------------------------------------

const actionsMap = {
    [actionTypes.setSelectedTabIndex]: setSelectedTabIndex,
    [actionTypes.setAssemblyCode]: setAssemblyCode,
    [actionTypes.setSinclairBasicCode]: setSinclairBasicCode,
};

export default function reducer(state = initialState, action) {
    const reducerFunction = actionsMap[action.type];
    return reducerFunction ? reducerFunction(state, action) : state;
}
