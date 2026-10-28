import { MediaRelay } from '../media';
import { MediaCmd, MediaMsg, MediaState, MsgType, decode } from '../proto';

function setup() {
  const sent: Uint8Array[] = [];
  const commands: MediaCmd[] = [];
  const relay = new MediaRelay({ send: (f) => sent.push(f), command: (c) => commands.push(c) });
  return { relay, sent, commands };
}

const SONG: MediaMsg = { state: MediaState.PLAYING, volumePct: 40, title: 'Yellow', artist: 'Coldplay' };

describe('MediaRelay', () => {
  it('sends on change', () => {
    const { relay, sent } = setup();
    relay.onMediaChanged(SONG);
    expect(sent).toHaveLength(1);
    const d = decode(sent[0]);
    expect(d.type).toBe(MsgType.MEDIA);
    expect(d.msg).toEqual(SONG);
  });

  it('dedupes identical state', () => {
    const { relay, sent } = setup();
    relay.onMediaChanged(SONG);
    relay.onMediaChanged({ ...SONG });
    expect(sent).toHaveLength(1);
    relay.onMediaChanged({ ...SONG, state: MediaState.PAUSED });
    expect(sent).toHaveLength(2);
  });

  it('resends on connect', () => {
    const { relay, sent } = setup();
    relay.onMediaChanged(SONG);
    relay.onDeviceConnected();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
  });

  it('connect before any media sends NONE', () => {
    const { relay, sent } = setup();
    relay.onDeviceConnected();
    expect(sent).toHaveLength(1);
    expect(decode(sent[0]).msg).toEqual({ state: MediaState.NONE, volumePct: null, title: '', artist: '' });
  });

  it('forwards commands', () => {
    const { relay, commands } = setup();
    relay.onDeviceCommand(MediaCmd.NEXT);
    expect(commands).toEqual([1]);
    relay.onDeviceCommand(9);
    relay.onDeviceCommand(-1);
    relay.onDeviceCommand(1.5);
    expect(commands).toEqual([1]);
  });
});
