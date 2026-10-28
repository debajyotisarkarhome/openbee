// Android media relay wiring: the native now-playing module feeds MediaRelay, which talks to the display.
// Also exposes the notification-access permission as a store for the settings screen.
import { AppState } from 'react-native';

import * as NativeMediaModule from '../../modules/openbee-media';
import { NativeMedia } from '../../modules/openbee-media';
import { MediaRelay } from '../core/media';
import { MediaMsg } from '../core/proto';
import { DeviceLink } from './ble';

export interface MediaPermissionView {
  supported: boolean;
  granted: boolean;
}

function readPermission(): MediaPermissionView {
  const supported = NativeMediaModule.isSupported();
  return { supported, granted: supported && NativeMediaModule.isPermissionGranted() };
}

const permListeners = new Set<() => void>();
let permView: MediaPermissionView = readPermission();

export const mediaPermission = {
  subscribe(fn: () => void) {
    permListeners.add(fn);
    return () => {
      permListeners.delete(fn);
    };
  },
  getView: () => permView,
  refresh() {
    const next = readPermission();
    if (next.supported === permView.supported && next.granted === permView.granted) return;
    permView = next;
    permListeners.forEach((l) => l());
  },
  open() {
    NativeMediaModule.openPermissionSettings();
  },
};

// Access is granted in system settings, so re-check whenever the app comes back to the foreground.
AppState.addEventListener('change', (s) => {
  if (s === 'active') mediaPermission.refresh();
});

function toMediaMsg(m: NativeMedia): MediaMsg {
  return { state: m.state, volumePct: m.volumePct, title: m.title, artist: m.artist };
}

/** Relay phone media to `link`. Returns null (and does nothing) where media relay is unsupported. */
export function startMediaRelay(link: DeviceLink): MediaRelay | null {
  if (!NativeMediaModule.isSupported()) return null;
  const relay = new MediaRelay({ send: (f) => link.send(f), command: (c) => NativeMediaModule.command(c) });
  NativeMediaModule.addMediaListener((m) => relay.onMediaChanged(toMediaMsg(m)));
  relay.onMediaChanged(toMediaMsg(NativeMediaModule.getState()));
  return relay;
}
