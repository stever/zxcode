/**
 * Generate retro pattern-based avatars with high variety
 * Creates unique blocky 8-bit style patterns perfect for ZX Spectrum aesthetic
 */

// ZX Spectrum color palette
const SPECTRUM_COLORS = [
    '#000000', // Black
    '#0000D7', // Blue
    '#D70000', // Red
    '#D700D7', // Magenta
    '#00D700', // Green
    '#00D7D7', // Cyan
    '#D7D700', // Yellow
    '#D7D7D7', // White
    '#0000FF', // Bright Blue
    '#FF0000', // Bright Red
    '#FF00FF', // Bright Magenta
    '#00FF00', // Bright Green
    '#00FFFF', // Bright Cyan
    '#FFFF00', // Bright Yellow
    '#FFFFFF'  // Bright White
];

/**
 * Hash function with better distribution
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
 * Seeded random number generator
 */
class SeededRandom {
    constructor(seed) {
        this.seed = seed % 2147483647;
        if (this.seed <= 0) this.seed += 2147483646;
    }

    next() {
        this.seed = (this.seed * 16807) % 2147483647;
        return (this.seed - 1) / 2147483646;
    }

    nextInt(max) {
        return Math.floor(this.next() * max);
    }

    choice(array) {
        return array[this.nextInt(array.length)];
    }
}

/**
 * Pattern generators - each returns an 8x8 grid
 */
const patternGenerators = {
    // Symmetric vertical mirror
    symmetricVertical: (rng) => {
        const grid = Array(8).fill(null).map(() => Array(8).fill(false));
        for (let y = 0; y < 8; y++) {
            for (let x = 0; x < 4; x++) {
                const filled = rng.next() > 0.5;
                grid[y][x] = filled;
                grid[y][7 - x] = filled;
            }
        }
        return grid;
    },

    // Symmetric horizontal mirror
    symmetricHorizontal: (rng) => {
        const grid = Array(8).fill(null).map(() => Array(8).fill(false));
        for (let y = 0; y < 4; y++) {
            for (let x = 0; x < 8; x++) {
                const filled = rng.next() > 0.5;
                grid[y][x] = filled;
                grid[7 - y][x] = filled;
            }
        }
        return grid;
    },

    // Symmetric both ways (4-way symmetry)
    symmetric4Way: (rng) => {
        const grid = Array(8).fill(null).map(() => Array(8).fill(false));
        for (let y = 0; y < 4; y++) {
            for (let x = 0; x < 4; x++) {
                const filled = rng.next() > 0.5;
                grid[y][x] = filled;
                grid[y][7 - x] = filled;
                grid[7 - y][x] = filled;
                grid[7 - y][7 - x] = filled;
            }
        }
        return grid;
    },

    // Diagonal patterns
    diagonal: (rng) => {
        const grid = Array(8).fill(null).map(() => Array(8).fill(false));
        const pattern = rng.nextInt(4);
        for (let y = 0; y < 8; y++) {
            for (let x = 0; x < 8; x++) {
                switch (pattern) {
                    case 0: grid[y][x] = (x + y) % 3 === 0; break;
                    case 1: grid[y][x] = Math.abs(x - y) < 2; break;
                    case 2: grid[y][x] = (x + y) % 2 === 0; break;
                    case 3: grid[y][x] = (x * y) % 3 === 0; break;
                }
            }
        }
        return grid;
    },

    // Circular/radial patterns
    circular: (rng) => {
        const grid = Array(8).fill(null).map(() => Array(8).fill(false));
        const cx = 3.5, cy = 3.5;
        const numRings = 2 + rng.nextInt(2);
        for (let y = 0; y < 8; y++) {
            for (let x = 0; x < 8; x++) {
                const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
                grid[y][x] = Math.floor(dist) % numRings === 0;
            }
        }
        return grid;
    },

    // Random connected shapes
    organic: (rng) => {
        const grid = Array(8).fill(null).map(() => Array(8).fill(false));
        // Start with random seed points
        const seeds = 3 + rng.nextInt(3);
        for (let i = 0; i < seeds; i++) {
            const x = rng.nextInt(8);
            const y = rng.nextInt(8);
            grid[y][x] = true;

            // Grow from seed
            let growthSteps = 3 + rng.nextInt(5);
            let gx = x, gy = y;
            while (growthSteps-- > 0) {
                const dir = rng.nextInt(4);
                switch (dir) {
                    case 0: gx = Math.min(7, gx + 1); break;
                    case 1: gx = Math.max(0, gx - 1); break;
                    case 2: gy = Math.min(7, gy + 1); break;
                    case 3: gy = Math.max(0, gy - 1); break;
                }
                grid[gy][gx] = true;
            }
        }
        return grid;
    },

    // Maze-like patterns
    maze: (rng) => {
        const grid = Array(8).fill(null).map(() => Array(8).fill(false));
        // Create random walk paths
        for (let start = 0; start < 3; start++) {
            let x = rng.nextInt(8);
            let y = rng.nextInt(8);
            let steps = 8 + rng.nextInt(8);

            while (steps-- > 0) {
                grid[y][x] = true;
                const dir = rng.nextInt(4);
                switch (dir) {
                    case 0: x = (x + 1) % 8; break;
                    case 1: x = (x + 7) % 8; break;
                    case 2: y = (y + 1) % 8; break;
                    case 3: y = (y + 7) % 8; break;
                }
            }
        }
        return grid;
    },

    // Geometric shapes
    geometric: (rng) => {
        const grid = Array(8).fill(null).map(() => Array(8).fill(false));
        const shape = rng.nextInt(5);

        switch (shape) {
            case 0: // Square
                const size = 3 + rng.nextInt(3);
                const offset = rng.nextInt(8 - size);
                for (let y = offset; y < offset + size; y++) {
                    for (let x = offset; x < offset + size; x++) {
                        grid[y][x] = true;
                    }
                }
                break;
            case 1: // Cross
                const thickness = 1 + rng.nextInt(2);
                for (let i = 0; i < 8; i++) {
                    for (let t = 0; t < thickness; t++) {
                        grid[i][3 + t] = true;
                        grid[3 + t][i] = true;
                    }
                }
                break;
            case 2: // Diamond
                for (let y = 0; y < 8; y++) {
                    for (let x = 0; x < 8; x++) {
                        if (Math.abs(x - 3.5) + Math.abs(y - 3.5) < 3.5) {
                            grid[y][x] = true;
                        }
                    }
                }
                break;
            case 3: // Triangles
                for (let y = 0; y < 8; y++) {
                    for (let x = 0; x < 8; x++) {
                        grid[y][x] = x <= y;
                    }
                }
                break;
            case 4: // Checkerboard sections
                const checkSize = 2 + rng.nextInt(2);
                for (let y = 0; y < 8; y++) {
                    for (let x = 0; x < 8; x++) {
                        grid[y][x] = (Math.floor(x / checkSize) + Math.floor(y / checkSize)) % 2 === 0;
                    }
                }
                break;
        }
        return grid;
    },

    // Dotted/stippled patterns
    stippled: (rng) => {
        const grid = Array(8).fill(null).map(() => Array(8).fill(false));
        const density = 0.2 + rng.next() * 0.4;
        for (let y = 0; y < 8; y++) {
            for (let x = 0; x < 8; x++) {
                grid[y][x] = rng.next() < density;
            }
        }
        return grid;
    },

    // Wave patterns
    wave: (rng) => {
        const grid = Array(8).fill(null).map(() => Array(8).fill(false));
        const amplitude = 1 + rng.next() * 2;
        const frequency = 1 + rng.nextInt(3);
        const vertical = rng.next() > 0.5;

        for (let y = 0; y < 8; y++) {
            for (let x = 0; x < 8; x++) {
                if (vertical) {
                    const wave = 3.5 + amplitude * Math.sin(y * frequency * Math.PI / 4);
                    grid[y][x] = Math.abs(x - wave) < 1.5;
                } else {
                    const wave = 3.5 + amplitude * Math.sin(x * frequency * Math.PI / 4);
                    grid[y][x] = Math.abs(y - wave) < 1.5;
                }
            }
        }
        return grid;
    }
};

/**
 * Generate a retro pattern avatar
 * @param {string} identifier - User identifier (username, user_id, or with variant suffix)
 * @param {number} size - Avatar size in pixels
 * @param {number} variant - Optional variant number to generate different versions
 * @returns {string} Data URI of the generated avatar
 */
export function generateRetroPatternAvatar(identifier, size = 80, variant = 0) {
    if (!identifier) {
        identifier = 'default';
    }

    // Add variant to identifier for different versions
    const fullIdentifier = variant > 0 ? `${identifier}_v${variant}` : identifier;
    const hash = hashCode(String(fullIdentifier));
    const rng = new SeededRandom(hash);

    const gridSize = 8;
    const pixelSize = Math.floor(size / gridSize);
    const actualSize = pixelSize * gridSize;

    // Select pattern generator
    const generators = Object.values(patternGenerators);
    const generator = rng.choice(generators);
    const grid = generator(rng);

    // Select colors - ensure good contrast
    const bgColorIndex = rng.nextInt(SPECTRUM_COLORS.length);
    let fgColorIndex = rng.nextInt(SPECTRUM_COLORS.length);

    // Ensure different colors
    while (Math.abs(bgColorIndex - fgColorIndex) < 2) {
        fgColorIndex = (fgColorIndex + 3) % SPECTRUM_COLORS.length;
    }

    const bgColor = SPECTRUM_COLORS[bgColorIndex];
    const fgColor = SPECTRUM_COLORS[fgColorIndex];

    // Optional third accent color
    const hasAccent = rng.next() > 0.6;
    let accentColor = null;
    if (hasAccent) {
        let accentIndex = rng.nextInt(SPECTRUM_COLORS.length);
        while (accentIndex === bgColorIndex || accentIndex === fgColorIndex) {
            accentIndex = (accentIndex + 2) % SPECTRUM_COLORS.length;
        }
        accentColor = SPECTRUM_COLORS[accentIndex];
    }

    // Generate SVG
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${actualSize}" height="${actualSize}" viewBox="0 0 ${actualSize} ${actualSize}">`;

    // Background
    svg += `<rect width="${actualSize}" height="${actualSize}" fill="${bgColor}"/>`;

    // Draw pattern
    for (let y = 0; y < gridSize; y++) {
        for (let x = 0; x < gridSize; x++) {
            if (grid[y][x]) {
                // Use accent color occasionally if available
                const useAccent = hasAccent && ((x + y) % 3 === 0);
                const color = useAccent ? accentColor : fgColor;
                svg += `<rect x="${x * pixelSize}" y="${y * pixelSize}" width="${pixelSize}" height="${pixelSize}" fill="${color}"/>`;
            }
        }
    }

    svg += '</svg>';

    // Convert to data URL
    const encoded = btoa(unescape(encodeURIComponent(svg)));
    return `data:image/svg+xml;base64,${encoded}`;
}