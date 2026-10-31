// User preferences, persisted with AsyncStorage. Same observable shape as DeviceLink/NavSession so the
// screens can read it through useSyncExternalStore.
import AsyncStorage from '@react-native-async-storage/async-storage';

import { DEFAULT_PAGES, PageSetting, normalizePages } from '../core/layout';
import { Units } from '../ui/theme';

const KEY = 'openbee.settings';

export interface Settings {
  units: Units;
  /** Speed used by "Simulate ride", km/h. */
  simSpeedKmh: number;
  /** Show the route preview map on the plan screen. */
  showMap: boolean;
  /** Mirror the device's road view on the ride screen. */
  showRoadShape: boolean;
  /** The display's pages: swipe order, and which are shown (sent to the device as LAYOUT). */
  pages: PageSetting[];
}

export const DEFAULTS: Settings = {
  units: 'metric',
  simSpeedKmh: 50,
  showMap: true,
  showRoadShape: true,
  pages: DEFAULT_PAGES,
};

export const SIM_SPEED_CHOICES = [25, 50, 80];

class SettingsStore {
  private value: Settings = DEFAULTS;
  private listeners = new Set<() => void>();
  private loaded = false;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getView = () => this.value;

  /** Read persisted values once at startup; unknown or corrupt data falls back to DEFAULTS. */
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await AsyncStorage.getItem(KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<Settings>;
      this.value = { ...DEFAULTS, ...saved, pages: normalizePages(saved.pages) };
      this.emit();
    } catch {
      // Keep defaults: preferences are not worth failing startup over.
    }
  }

  set<K extends keyof Settings>(key: K, v: Settings[K]) {
    if (this.value[key] === v) return;
    this.value = { ...this.value, [key]: v };
    this.emit();
    void AsyncStorage.setItem(KEY, JSON.stringify(this.value)).catch(() => {});
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }
}

export const settings = new SettingsStore();
