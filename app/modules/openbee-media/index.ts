import { Platform } from 'react-native';
import { requireNativeModule } from 'expo';

export interface NativeMedia {
  /** 0 = no player, 1 = playing, 2 = paused */
  state: 0 | 1 | 2;
  title: string;
  artist: string;
  volumePct: number | null;
}

const NONE: NativeMedia = { state: 0, title: '', artist: '', volumePct: null };

// Android only; on iOS nothing native is loaded.
const native = Platform.OS === 'android' ? requireNativeModule('OpenbeeMedia') : null;

export function isSupported(): boolean {
  return Platform.OS === 'android';
}

export function isPermissionGranted(): boolean {
  return native ? native.isPermissionGranted() : false;
}

export function openPermissionSettings(): void {
  native?.openPermissionSettings();
}

export function getState(): NativeMedia {
  return native ? native.getState() : NONE;
}

/** `cmd` is a MediaCmd value (0 toggle, 1 next, 2 prev, 3 vol up, 4 vol down); unknown values are ignored. */
export function command(cmd: number): void {
  native?.command(cmd);
}

export function addMediaListener(fn: (m: NativeMedia) => void): { remove(): void } {
  if (!native) return { remove() {} };
  return native.addListener('onMediaChanged', fn);
}
