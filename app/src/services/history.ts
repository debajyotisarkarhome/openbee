// Past rides, persisted with AsyncStorage. Same observable shape as the settings store so the plan
// screen reads it through useSyncExternalStore.
import AsyncStorage from '@react-native-async-storage/async-storage';

import { RideRecord } from '../core/history';

const KEY = 'openbee.history';
const MAX_RIDES = 100;

class HistoryStore {
  private rides: RideRecord[] = [];
  private listeners = new Set<() => void>();
  private loaded = false;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Newest first. */
  getView = () => this.rides;

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await AsyncStorage.getItem(KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as RideRecord[];
      // A ride recorded before load finished is already in memory; keep it on top.
      this.rides = [...this.rides, ...saved.filter((s) => !this.rides.some((r) => r.id === s.id))].slice(0, MAX_RIDES);
      this.emit();
    } catch {
      // History is a convenience; a corrupt store just starts empty.
    }
  }

  add(r: RideRecord) {
    this.rides = [r, ...this.rides.filter((x) => x.id !== r.id)].slice(0, MAX_RIDES);
    this.persist();
  }

  remove(id: string) {
    this.rides = this.rides.filter((r) => r.id !== id);
    this.persist();
  }

  private persist() {
    this.emit();
    void AsyncStorage.setItem(KEY, JSON.stringify(this.rides)).catch(() => {});
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }
}

export const history = new HistoryStore();
