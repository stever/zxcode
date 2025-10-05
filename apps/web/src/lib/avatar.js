import { generateRetroSpriteAvatar } from './retroSpriteAvatar';

/**
 * Generate a retro avatar for a user
 * @param {string} identifier - The identifier (username, user_id, etc)
 * @param {number} size - The size of the avatar in pixels (default: 80)
 * @param {Object} userData - User data containing avatar_variant and custom_avatar_data
 * @returns {string} Data URI of the generated avatar
 */
export function generateRetroAvatar(identifier, size = 80, userData = null) {
    // Use database data if available, otherwise default to variant 0
    const variant = userData?.avatar_variant ?? 0;
    const customAvatarData = userData?.custom_avatar_data;

    // Check if using custom avatar
    if (variant === -1 && customAvatarData) {
        try {
            const grid = customAvatarData;
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
        } catch (e) {
            console.error('Failed to load custom avatar:', e);
        }
    }

    return generateRetroSpriteAvatar(identifier, size, variant);
}

/**
 * Generate next variant of avatar (for preview, not saving to DB)
 * @param {string} identifier - The identifier
 * @param {number} size - The size in pixels
 * @param {number} currentVariant - Current variant number
 * @returns {string} Data URI of the new avatar variant
 */
export function regenerateAvatar(identifier, size = 80, currentVariant = 0) {
    const nextVariant = (currentVariant + 1) % 200; // More variants with transformations
    return generateRetroSpriteAvatar(identifier, size, nextVariant);
}