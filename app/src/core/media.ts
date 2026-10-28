// Phone-side media relay: forwards now-playing state to the display (deduped) and display button
// presses back to the phone's media player. Platform-free; the player and BLE link are injected.
import { MediaCmd, MediaMsg, MediaState, encodeMedia } from './proto';

export interface MediaRelayDeps {
  send(frame: Uint8Array): void;
  command(cmd: MediaCmd): void;
}

const NONE_FRAME = encodeMedia({ state: MediaState.NONE, volumePct: null, title: '', artist: '' });

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class MediaRelay {
  private latest: Uint8Array = NONE_FRAME;
  private lastSent: Uint8Array | null = null;

  constructor(private deps: MediaRelayDeps) {}

  /** Send the new state unless it encodes byte-identically to the last frame sent. */
  onMediaChanged(m: MediaMsg): void {
    this.latest = encodeMedia(m);
    if (this.lastSent && sameBytes(this.latest, this.lastSent)) return;
    this.sendLatest();
  }

  /** A (re)connected display knows nothing: always send the latest state, NONE if none seen yet. */
  onDeviceConnected(): void {
    this.sendLatest();
  }

  /** A MEDIA_CMD from the display; anything that is not a known MediaCmd is ignored. */
  onDeviceCommand(cmd: number): void {
    if (Number.isInteger(cmd) && cmd >= MediaCmd.TOGGLE && cmd <= MediaCmd.VOL_DOWN) this.deps.command(cmd);
  }

  private sendLatest() {
    this.lastSent = this.latest;
    this.deps.send(this.latest);
  }
}
