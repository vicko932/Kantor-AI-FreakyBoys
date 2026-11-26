import fs from 'fs';
import path from 'path';

export const KEYS_FILE = path.join(import.meta.dirname, '..', 'api-keys.json');

export function bacaUserKeys() {
  let fileKeys = {};
  try {
    if (fs.existsSync(KEYS_FILE)) {
      fileKeys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    }
  } catch (e) {}
  return {
    gemini: fileKeys.gemini || process.env.GEMINI_API_KEY || '',
    groq: fileKeys.groq || process.env.GROQ_API_KEY || '',
    openrouter: fileKeys.openrouter || process.env.OPENROUTER_API_KEY || ''
  };
}

export function maskKey(k) {
  if (!k || k.length < 8) return k ? '****' : '';
  return `${k.slice(0, 4)}...${k.slice(-4)}`;
}