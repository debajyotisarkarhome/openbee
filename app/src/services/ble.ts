// BLE central for the OpenBee device: scan, connect, auto-reconnect, serialized writes, DEV_STATUS notifications.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, Device, State, Subscription } from 'react-native-ble-plx';

import { fromBase64, toBase64 } from '../core/base64';
import { DevStatusMsg, MsgType, RX_UUID, SERVICE_UUID, TX_UUID, decode } from '../core/proto';

const LAST_DEVICE_KEY = 'openbee.lastDevice';
const RECONNECT_MS = 3000;
const MAX_PENDING = 4;

export type LinkStatus = 'off' | 'idle' | 'scanning' | 'connecting' | 'connected';

export interface LinkView {
  status: LinkStatus;
  deviceId: string | null;
  deviceName: string | null;
  devStatus: DevStatusMsg | null;
  found: { id: string; name: string; rssi: number | null }[];
}

export class DeviceLink {
  private manager = new BleManager();
  private view: LinkView = { status: 'idle', deviceId: null, deviceName: null, devStatus: null, found: [] };
  private listeners = new Set<() => void>();
  private subs: Subscription[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wantConnected = false;
  onConnected: () => void = () => {};

  constructor() {
    this.manager.onStateChange((s) => {
      if (s !== State.PoweredOn) this.set({ status: 'off' });
      else if (this.view.status === 'off') {
        this.set({ status: 'idle' });
        void this.reconnectLast();
      }
    }, true);
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getView = () => this.view;

  private set(p: Partial<LinkView>) {
    this.view = { ...this.view, ...p };
    this.listeners.forEach((l) => l());
  }

  async requestPermissions(): Promise<boolean> {
    if (Platform.OS !== 'android') return true;
    const res = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    ]);
    return Object.values(res).every((r) => r === PermissionsAndroid.RESULTS.GRANTED);
  }

  async scan(timeoutMs = 10000) {
    if (!(await this.requestPermissions())) return;
    this.set({ status: 'scanning', found: [] });
    await this.manager.startDeviceScan([SERVICE_UUID], null, (err, d) => {
      if (err || !d) return;
      const name = d.name ?? d.localName ?? 'OpenBee';
      const found = this.view.found.filter((f) => f.id !== d.id);
      this.set({ found: [...found, { id: d.id, name, rssi: d.rssi }].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999)) });
    });
    setTimeout(() => this.stopScan(), timeoutMs);
  }

  stopScan() {
    void this.manager.stopDeviceScan();
    if (this.view.status === 'scanning') this.set({ status: 'idle' });
  }

  async reconnectLast() {
    const id = await AsyncStorage.getItem(LAST_DEVICE_KEY);
    if (id && this.view.status !== 'connected') await this.connect(id);
  }

  async connect(id: string) {
    this.stopScan();
    this.wantConnected = true;
    this.set({ status: 'connecting', deviceId: id });
    try {
      let d: Device = await this.manager.connectToDevice(id, { requestMTU: 247, timeout: 10000 });
      d = await d.discoverAllServicesAndCharacteristics();
      if (Platform.OS === 'android') d = await d.requestMTU(247);
      await AsyncStorage.setItem(LAST_DEVICE_KEY, id);
      this.subs.forEach((s) => s.remove());
      this.subs = [
        this.manager.onDeviceDisconnected(id, () => this.handleDisconnect()),
        this.manager.monitorCharacteristicForDevice(id, SERVICE_UUID, TX_UUID, (err, c) => {
          if (err || !c?.value) return;
          try {
            const msg = decode(fromBase64(c.value));
            if (msg.type === MsgType.DEV_STATUS) this.set({ devStatus: msg.msg });
          } catch {
            // ignore malformed notifications
          }
        }),
      ];
      this.set({ status: 'connected', deviceName: d.name ?? d.localName ?? 'OpenBee' });
      this.onConnected();
    } catch {
      this.handleDisconnect();
    }
  }

  async disconnect() {
    this.wantConnected = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await AsyncStorage.removeItem(LAST_DEVICE_KEY);
    if (this.view.deviceId) await this.manager.cancelDeviceConnection(this.view.deviceId).catch(() => {});
    this.set({ status: 'idle', deviceId: null, deviceName: null, devStatus: null });
  }

  private handleDisconnect() {
    this.subs.forEach((s) => s.remove());
    this.subs = [];
    this.pending = 0;
    this.set({ status: this.view.status === 'off' ? 'off' : 'idle' });
    if (this.wantConnected && this.view.deviceId) {
      const id = this.view.deviceId;
      this.reconnectTimer = setTimeout(() => void this.connect(id), RECONNECT_MS);
    }
  }

  /** Queue one frame. NAV frames are dropped when the link is backed up (a newer one follows soon). */
  send(frame: Uint8Array) {
    const id = this.view.deviceId;
    if (this.view.status !== 'connected' || !id) return;
    if (this.pending >= MAX_PENDING && frame[1] === MsgType.NAV) return;
    this.pending++;
    this.chain = this.chain
      .then(() => this.manager.writeCharacteristicWithoutResponseForDevice(id, SERVICE_UUID, RX_UUID, toBase64(frame)))
      .catch(() => {})
      .finally(() => this.pending--);
  }
}
