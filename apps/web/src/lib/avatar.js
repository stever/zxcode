import { generateRetroSpriteAvatar } from './retroSpriteAvatar';

// Store user's selected variant in localStorage
const AVATAR_VARIANT_KEY = 'avatar_variants';

/**
 * Get stored variant for a user
 */
function getStoredVariant(identifier) {
    try {
        const variants = JSON.parse(localStorage.getItem(AVATAR_VARIANT_KEY) || '{}');
        return variants[identifier] || 0;
    } catch {
        return 0;
    }
}

/**
 * Store variant for a user
 */
function storeVariant(identifier, variant) {
    try {
        const variants = JSON.parse(localStorage.getItem(AVATAR_VARIANT_KEY) || '{}');
        variants[identifier] = variant;
        localStorage.setItem(AVATAR_VARIANT_KEY, JSON.stringify(variants));
    } catch {
        // Ignore localStorage errors
    }
}

/**
 * Generate a retro avatar for a user using stored variant
 * @param {string} identifier - The identifier (username, user_id, etc)
 * @param {number} size - The size of the avatar in pixels (default: 80)
 * @returns {string} Data URI of the generated avatar
 */
export function generateRetroAvatar(identifier, size = 80) {
    const variant = getStoredVariant(identifier);

    // Check if using custom avatar
    if (variant === 'custom') {
        try {
            const saved = localStorage.getItem(`custom_avatar_${identifier}`);
            if (saved) {
                const grid = JSON.parse(saved);
                // Generate SVG from saved grid
                const pixelSize = size / 8;
                const COLORS = [
                    '#000000', '#0000D7', '#D70000', '#D700D7',
                    '#00D700', '#00D7D7', '#D7D700', '#D7D7D7',
                    '#0000FF', '#FF0000', '#FF00FF', '#00FF00',
                    '#00FFFF', '#FFFF00', '#FFFFFF'
                ];

                let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`;
                svg += `<rect width="${size}" height="${size}" fill="${COLORS[0]}"/>`;

                for (let row = 0; row < 8; row++) {
                    for (let col = 0; col < 8; col++) {
                        const colorIndex = grid[row][col];
                        if (colorIndex > 0 && colorIndex < COLORS.length) {
                            const color = COLORS[colorIndex];
                            svg += `<rect x="${col * pixelSize}" y="${row * pixelSize}" width="${pixelSize}" height="${pixelSize}" fill="${color}"/>`;
                        }
                    }
                }

                svg += '</svg>';
                const encoded = btoa(unescape(encodeURIComponent(svg)));
                return `data:image/svg+xml;base64,${encoded}`;
            }
        } catch (e) {
            console.error('Failed to load custom avatar:', e);
        }
    }

    return generateRetroSpriteAvatar(identifier, size, variant);
}

/**
 * Generate next variant of avatar
 * @param {string} identifier - The identifier
 * @param {number} size - The size in pixels
 * @returns {string} Data URI of the new avatar variant
 */
export function regenerateAvatar(identifier, size = 80) {
    const currentVariant = getStoredVariant(identifier);
    const nextVariant = (currentVariant + 1) % 200; // More variants with transformations
    storeVariant(identifier, nextVariant);
    return generateRetroSpriteAvatar(identifier, size, nextVariant);
}