/**
 * Utility functions for generating URL-safe slugs
 */

/**
 * Generate a URL-safe slug from a text string
 * @param {string} text - The text to convert to a slug
 * @returns {string} The generated slug
 */
export function generateSlug(text) {
  if (!text) return '';

  return text
    .toLowerCase()
    .trim()
    // Replace spaces and non-alphanumeric characters with hyphens
    .replace(/[^a-z0-9]+/g, '-')
    // Remove leading/trailing hyphens
    .replace(/^-+|-+$/g, '')
    // Collapse multiple hyphens
    .replace(/-+/g, '-');
}

/**
 * Validate that a slug is valid
 * @param {string} slug - The slug to validate
 * @returns {boolean} True if valid
 */
export function isValidSlug(slug) {
  if (!slug || slug.length < 3 || slug.length > 100) return false;

  // Must contain only lowercase letters, numbers, and hyphens
  // Cannot start or end with a hyphen
  return /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug);
}

/**
 * Reserved slugs that cannot be used (for URL routing conflicts)
 */
export const RESERVED_USER_SLUGS = [
  'admin',
  'api',
  'about',
  'help',
  'home',
  'login',
  'logout',
  'new',
  'projects',
  'privacy',
  'privacy-policy',
  'profile',
  'register',
  'settings',
  'signin',
  'signout',
  'signup',
  'terms',
  'terms-of-use',
  'u',
  'user',
  'users',
];

/**
 * Check if a slug is reserved
 * @param {string} slug - The slug to check
 * @returns {boolean} True if reserved
 */
export function isReservedSlug(slug) {
  return RESERVED_USER_SLUGS.includes(slug.toLowerCase());
}

/**
 * Generate a unique slug by appending numbers if needed
 * @param {string} baseSlug - The base slug
 * @param {string[]} existingSlugs - Array of existing slugs to check against
 * @returns {string} A unique slug
 */
export function generateUniqueSlug(baseSlug, existingSlugs = []) {
  let slug = generateSlug(baseSlug);

  if (!existingSlugs.includes(slug) && !isReservedSlug(slug)) {
    return slug;
  }

  // Append numbers until we find a unique slug
  let counter = 2;
  while (existingSlugs.includes(`${slug}-${counter}`) || isReservedSlug(`${slug}-${counter}`)) {
    counter++;
  }

  return `${slug}-${counter}`;
}