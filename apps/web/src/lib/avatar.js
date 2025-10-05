import { generateRetroPatternAvatar } from './retroPatternAvatar';

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
    return generateRetroPatternAvatar(identifier, size, variant);
}

/**
 * Generate next variant of avatar
 * @param {string} identifier - The identifier
 * @param {number} size - The size in pixels
 * @returns {string} Data URI of the new avatar variant
 */
export function regenerateAvatar(identifier, size = 80) {
    const currentVariant = getStoredVariant(identifier);
    const nextVariant = (currentVariant + 1) % 100; // Cycle through 100 variants
    storeVariant(identifier, nextVariant);
    return generateRetroPatternAvatar(identifier, size, nextVariant);
}

/**
 * Get all possible avatar variants for preview
 * @param {string} identifier - The identifier
 * @param {number} count - Number of variants to generate
 * @param {number} size - The size in pixels
 * @returns {Array<string>} Array of data URIs
 */
export function getAvatarVariants(identifier, count = 9, size = 80) {
    const variants = [];
    for (let i = 0; i < count; i++) {
        variants.push(generateRetroPatternAvatar(identifier, size, i));
    }
    return variants;
}