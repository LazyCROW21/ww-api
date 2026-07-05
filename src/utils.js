import { join } from 'path';
import { rimraf } from 'rimraf';

/**
 * Sanitizes a phone number to include only digits.
 * @param {string} phone 
 * @returns {string}
 */
export function sanitizePhone(phone) {
  if (typeof phone !== 'string') return '';
  return phone.replace(/\D/g, '');
}

/**
 * Formats a phone number into a WhatsApp JID.
 * @param {string} phone 
 * @returns {string|null}
 */
export function formatJid(phone) {
  const clean = sanitizePhone(phone);
  if (!clean) return null;
  return `${clean}@s.whatsapp.net`;
}

/**
 * Gets the absolute path of a session directory.
 * @param {string} phone 
 * @returns {string}
 */
export function getSessionDir(phone) {
  const clean = sanitizePhone(phone);
  return join(process.cwd(), 'sessions', clean);
}

/**
 * Clears the session directory for a given phone number.
 * @param {string} phone 
 * @returns {Promise<boolean>}
 */
export async function clearSessionDir(phone) {
  const dir = getSessionDir(phone);
  try {
    await rimraf(dir);
    return true;
  } catch (err) {
    console.error(`Failed to clear session directory for ${phone}:`, err);
    return false;
  }
}
