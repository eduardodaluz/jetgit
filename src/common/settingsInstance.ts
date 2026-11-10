/**
 * Shared settings singleton for feature modules. Instantiated lazily on
 * first access (post-activation) — do not touch at module top level.
 */
import { SettingsService } from './settings';

let instance: SettingsService | undefined;

export function settings(): SettingsService {
  if (!instance) {
    instance = new SettingsService();
  }
  return instance;
}
