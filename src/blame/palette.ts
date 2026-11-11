/**
 * Author-color palette (the IntelliJ "annotate" signature): authors map
 * deterministically to one of 8 buckets via FNV-1a(email) % 8, and each
 * bucket has a distinct line-highlight color per color-theme kind.
 * Pure module — no vscode imports.
 */

export type ThemeKind = 'dark' | 'light' | 'high-contrast';

/** FNV-1a 32-bit hash — stable, tiny, good-enough spread for bucketing. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    // Math.imul keeps this a 32-bit multiply.
    hash = Math.imul(hash, 0x01000193);
  }
  // Normalize to unsigned.
  return hash >>> 0;
}

export const BUCKET_COUNT = 8;

/** Deterministic bucket for an author email (lowercased: case = same person). */
export function bucketFor(email: string): number {
  return fnv1a(email.trim().toLowerCase()) % BUCKET_COUNT;
}

/**
 * Line-highlight colors per bucket, per theme kind. Alpha is deliberately
 * low: the highlight must never compete with the code. High-contrast themes
 * get NO backgrounds at all (accessibility — a background would fight the
 * forced contrast theme; blame stays visible via the text annotation only).
 */
const DARK = [
  'rgba(69, 183, 125, 0.16)',
  'rgba(108, 153, 240, 0.16)',
  'rgba(222, 130, 96, 0.16)',
  'rgba(186, 122, 232, 0.16)',
  'rgba(84, 182, 203, 0.16)',
  'rgba(230, 180, 84, 0.16)',
  'rgba(217, 106, 158, 0.16)',
  'rgba(142, 190, 90, 0.16)',
];

const LIGHT = [
  'rgba(38, 150, 100, 0.12)',
  'rgba(80, 120, 224, 0.12)',
  'rgba(206, 100, 66, 0.12)',
  'rgba(160, 90, 210, 0.12)',
  'rgba(48, 152, 176, 0.12)',
  'rgba(198, 146, 48, 0.12)',
  'rgba(190, 70, 130, 0.12)',
  'rgba(108, 158, 52, 0.12)',
];

export function paletteFor(kind: ThemeKind): string[] {
  if (kind === 'dark') {
    return [...DARK];
  }
  if (kind === 'light') {
    return [...LIGHT];
  }
  // High-contrast: neutral (no line backgrounds).
  return [];
}

/** Neutral text color token used for the inline annotation text. */
export const ANNOTATION_COLOR_TOKEN = 'descriptionForeground';
