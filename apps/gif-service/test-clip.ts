import zmakebas from 'zmakebas';
import { GIFGenerator } from './src/gif-generator.js';
import { writeFile } from 'fs/promises';

// Draws one line every ~5 frames (PAUSE 5). The first line is the start of
// intentional drawing. If the capture loses the program's opening frames, the
// first captured frame will already show several lines.
const CODE = [
    '10 BORDER 1: PAPER 7: INK 2: CLS',
    '20 FOR n=1 TO 20',
    '30 PRINT "DRAWING STEP ";n',
    '40 PAUSE 5',
    '50 NEXT n',
    '60 PAUSE 0',
].join('\n');

const label = process.argv[2] ?? 'out';

const tap = Buffer.from(await zmakebas(CODE));
const gen = new GIFGenerator({ maxDurationMs: 5000, scale: 2 });
await gen.initialize();
const mp4 = await gen.generateMp4FromTAP(tap, 48);
await writeFile(`/tmp/${label}.mp4`, mp4);
console.log(`wrote /tmp/${label}.mp4 (${mp4.length} bytes)`);
