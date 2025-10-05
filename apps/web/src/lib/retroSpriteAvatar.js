/**
 * Generate retro 8-bit sprite avatars with recognizable shapes
 * Compact sprite definitions using string templates
 */

// ZX Spectrum color palette
const COLORS = [
    '#000000', // 0 Black
    '#0000D7', // 1 Blue
    '#D70000', // 2 Red
    '#D700D7', // 3 Magenta
    '#00D700', // 4 Green
    '#00D7D7', // 5 Cyan
    '#D7D700', // 6 Yellow
    '#D7D7D7', // 7 White
    '#0000FF', // 8 Bright Blue
    '#FF0000', // 9 Bright Red
    '#FF00FF', // A Bright Magenta
    '#00FF00', // B Bright Green
    '#00FFFF', // C Bright Cyan
    '#FFFF00', // D Bright Yellow
    '#FFFFFF'  // E Bright White
];

// Compact sprite definitions (8x8)
// Each character represents a pixel: . = empty, letters/numbers = color index
const SPRITES = [
    // Spaceships & Vehicles
    '...CC...' + '..CCCC..' + '.CCCCCC.' + 'CCCBBCCC' + 'CCCBBCCC' + '.CCCCCC.' + '..CCCC..' + '...CC...', // Classic ship
    '...99...' + '..9999..' + '.999999.' + '99911999' + '99911999' + '.991199.' + '..9119..' + '...11...', // Fighter red
    '..BBBB..' + '.BBBBBB.' + 'BBB22BBB' + 'BBBBBBBB' + '.BB22BB.' + '..B22B..' + '..2222..' + '...22...', // Rocket
    '....C...' + '...CCC..' + '..CCCCC.' + '.CCCCCCC' + 'CCCC5CCC' + '.CC555C.' + '..C5C5C.' + '...C.C..', // Arrow ship
    '.66..66.' + '6666666.' + '66611666' + '.666666.' + '..6666..' + '..6116..' + '.611116.' + '6111111.', // UFO
    '...AA...' + '..AAAA..' + '.AAAAAA.' + 'AAAAAAAA' + 'AA9AA9AA' + 'AAAAAAAA' + '.A.AA.A.' + 'A......A', // Defender

    // Aliens & Creatures
    '.D....D.' + '..D..D..' + '.DDDDDD.' + 'DD.DD.DD' + 'DDDDDDDD' + 'D.DDDD.D' + 'D......D' + '.D....D.', // Invader
    '..5555..' + '.555555.' + '5.5225.5' + '55555555' + '.555555.' + '.5.55.5.' + '5.5..5.5' + '.5....5.', // Octopus
    '...33...' + '..3333..' + '.333333.' + '3.3..3.3' + '33333333' + '3333333.' + '3.3333.3' + '.3.33.3.', // Alien
    '..EEEE..' + '.E.EE.E.' + 'EEEEEEEE' + 'EE2EE2EE' + 'EEEEEEEE' + '.EEEEEE.' + 'E.E..E.E' + '........', // Ghost
    '..8888..' + '.888888.' + '82288228' + '88888888' + '.888888.' + '..8888..' + '.8.88.8.' + '8......8', // Robot head

    // Tech & Items
    'CCC..CCC' + 'CCC..CCC' + '...CC...' + '..CCCC..' + '..CCCC..' + '...CC...' + 'CCC..CCC' + 'CCC..CCC', // Hourglass
    '...77...' + '..7777..' + '.777777.' + '77777777' + '.777777.' + '..7777..' + '...77...' + '........', // Diamond
    '..2222..' + '.222222.' + '22222222' + '22299222' + '22299222' + '22222222' + '.222222.' + '..2222..', // Power core
    '....B...' + '...BBB..' + '..BB.BB.' + '.BB...BB' + 'BBBBBBBB' + '.B.....B' + '.BBBBBBB' + '........', // Key
    '.DDDDDD.' + 'D......D' + 'D.DDDD.D' + 'D.D..D.D' + 'D.D..D.D' + 'D.DDDD.D' + 'D......D' + '.DDDDDD.', // Chip

    // Abstract Creatures
    '...66...' + '..6666..' + '.666666.' + '66622666' + '.666666.' + '666..666' + '6.6..6.6' + '..6..6..', // Spider
    '....AAA.' + '...AAAA.' + '..AAAAA.' + '.AAA2AA.' + 'AAAAAAA.' + '.AAAAAA.' + '..AAAA..' + '...AA...', // Blob
    '.99..99.' + '9999999.' + '99922999' + '.999999.' + '..9999..' + '.9.99.9.' + '9..99..9' + '...99...', // Crab
    '...CC...' + '..C..C..' + '.C....C.' + 'CCCCCCCC' + 'C.CCCC.C' + 'CC.CC.CC' + 'C......C' + '.C....C.', // Skull

    // Retro Gaming
    '..3333..' + '.333333.' + '33355333' + '33355333' + '33333333' + '.333333.' + '..3333..' + '........', // Ball
    '...11...' + '..1111..' + '.111111.' + '11111111' + '.112211.' + '..1111..' + '...11...' + '........', // Star
    'EE....EE' + 'EEE..EEE' + '.EEEEEE.' + '..EEEE..' + '..EEEE..' + '.EEEEEE.' + 'EEE..EEE' + 'EE....EE', // Bow tie
    '.666666.' + '6......6' + '6.6..6.6' + '6......6' + '6.6666.6' + '6.6..6.6' + '6.6666.6' + '.666666.', // TV/Monitor

    // Nature & Space
    '...88...' + '..8888..' + '.888888.' + '88888888' + '88822888' + '.882288.' + '..8888..' + '...88...', // Sun
    '..CCCC..' + '.C....C.' + 'C......C' + 'C......C' + 'C......C' + 'C......C' + '.C....C.' + '..CCCC..', // Moon
    '...55...' + '..5555..' + '.555555.' + '555AA555' + '555AA555' + '.555555.' + '..5555..' + '...55...', // Planet
    '.2....2.' + '222..222' + '.222222.' + '..2222..' + '..2222..' + '.222222.' + '222..222' + '.2....2.', // X-Wing
];

/**
 * Simple hash function
 */
function hashCode(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0, ch; i < str.length; i++) {
        ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Generate variations of a sprite
 */
function generateSpriteVariation(baseSprite, variant, seed) {
    const rng = (s) => {
        const x = Math.sin(s) * 10000;
        return x - Math.floor(x);
    };

    // Variation types
    const variationType = variant % 8;
    let sprite = baseSprite;

    switch (variationType) {
        case 1: // Flip horizontal
            sprite = flipHorizontal(sprite);
            break;
        case 2: // Flip vertical
            sprite = flipVertical(sprite);
            break;
        case 3: // Rotate 90
            sprite = rotate90(sprite);
            break;
        case 4: // Rotate 180
            sprite = rotate180(sprite);
            break;
        case 5: // Mirror diagonal
            sprite = mirrorDiagonal(sprite);
            break;
        case 6: // Add noise
            sprite = addNoise(sprite, seed);
            break;
        case 7: // Invert some pixels
            sprite = invertPixels(sprite, seed);
            break;
    }

    return sprite;
}

function flipHorizontal(sprite) {
    let result = '';
    for (let y = 0; y < 8; y++) {
        for (let x = 7; x >= 0; x--) {
            result += sprite[y * 8 + x];
        }
    }
    return result;
}

function flipVertical(sprite) {
    let result = '';
    for (let y = 7; y >= 0; y--) {
        for (let x = 0; x < 8; x++) {
            result += sprite[y * 8 + x];
        }
    }
    return result;
}

function rotate90(sprite) {
    let result = '';
    for (let x = 7; x >= 0; x--) {
        for (let y = 0; y < 8; y++) {
            result += sprite[y * 8 + x];
        }
    }
    return result;
}

function rotate180(sprite) {
    return sprite.split('').reverse().join('');
}

function mirrorDiagonal(sprite) {
    let result = '';
    for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
            result += sprite[x * 8 + y];
        }
    }
    return result;
}

function addNoise(sprite, seed) {
    const rng = (s) => Math.sin(s) * 10000 - Math.floor(Math.sin(s) * 10000);
    let result = '';
    for (let i = 0; i < 64; i++) {
        if (sprite[i] !== '.' && rng(seed + i) > 0.8) {
            result += '.';
        } else {
            result += sprite[i];
        }
    }
    return result;
}

function invertPixels(sprite, seed) {
    const rng = (s) => Math.sin(s) * 10000 - Math.floor(Math.sin(s) * 10000);
    let result = '';
    for (let i = 0; i < 64; i++) {
        if (rng(seed + i * 7) > 0.85) {
            result += sprite[i] === '.' ? '7' : '.';
        } else {
            result += sprite[i];
        }
    }
    return result;
}

/**
 * Generate a retro sprite avatar
 */
export function generateRetroSpriteAvatar(identifier, size = 80, variant = 0) {
    if (!identifier) identifier = 'default';

    const fullId = `${identifier}_${variant}`;
    const hash = hashCode(fullId);

    // Select sprite and apply variation
    const spriteIndex = Math.floor((hash / 100) % SPRITES.length);
    const baseSprite = SPRITES[spriteIndex];
    const sprite = variant > 0 ? generateSpriteVariation(baseSprite, variant, hash) : baseSprite;

    // Color remapping based on hash
    const colorShift = (hash % 7) + 1;

    // Generate background
    const bgOptions = [0, 0, 0, 1, 3, 5]; // Mostly black, sometimes colored
    const bgColor = COLORS[bgOptions[hash % bgOptions.length]];

    const gridSize = 8;
    const pixelSize = Math.floor(size / gridSize);
    const actualSize = pixelSize * gridSize;

    // Generate SVG
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${actualSize}" height="${actualSize}" viewBox="0 0 ${actualSize} ${actualSize}">`;
    svg += `<rect width="${actualSize}" height="${actualSize}" fill="${bgColor}"/>`;

    // Draw sprite
    for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
            const char = sprite[y * 8 + x];
            if (char !== '.') {
                // Parse color index (0-9, A-E)
                let colorIdx = parseInt(char, 16);
                if (!isNaN(colorIdx)) {
                    // Apply color shift for variation
                    if (variant > 0) {
                        colorIdx = (colorIdx + colorShift) % COLORS.length;
                    }
                    const color = COLORS[colorIdx];
                    svg += `<rect x="${x * pixelSize}" y="${y * pixelSize}" width="${pixelSize}" height="${pixelSize}" fill="${color}"/>`;
                }
            }
        }
    }

    // Add occasional stars for space theme
    if ((hash % 3) === 0) {
        const starCount = 2 + (hash % 3);
        for (let i = 0; i < starCount; i++) {
            const sx = ((hash * (i + 13)) % 8) * pixelSize;
            const sy = ((hash * (i + 17)) % 8) * pixelSize;
            if (sprite[Math.floor(sy/pixelSize) * 8 + Math.floor(sx/pixelSize)] === '.') {
                svg += `<rect x="${sx}" y="${sy}" width="${pixelSize}" height="${pixelSize}" fill="${COLORS[7]}" opacity="0.5"/>`;
            }
        }
    }

    svg += '</svg>';
    const encoded = btoa(unescape(encodeURIComponent(svg)));
    return `data:image/svg+xml;base64,${encoded}`;
}