// App-wide singletons: BLE link + nav session, wired to GPS (background), the ride simulator, battery
// and (Android) phone media.
// Imported once from the root layout so the background location task is defined at startup.
import * as Battery from 'expo-battery';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import { LatLon } from '../core/geo';
import { RideRecord, RideRecorder } from '../core/history';
import { Fix } from '../core/nav-engine';
import { NavState } from '../core/proto';
import { Route } from '../core/route';
import { NavSession } from '../core/session';
import { simulateRide } from '../core/simulator';
import { DeviceLink } from './ble';
import { history } from './history';
import { startMediaRelay } from './media';
import { fetchRoute } from './routing';
import { fetchStreets, prefetchAlongRoute } from './streets';

export const LOCATION_TASK = 'openbee-location';
const DEFAULT_SIM_SPEED_KMH = 50;
const SIM_INTERVAL_MS = 500;

let batteryPct: number | null = null;

export const link = new DeviceLink();
export const session = new NavSession({
  send: (f) => link.send(f),
  fetchRoute,
  fetchStreets,
  phoneBatteryPct: () => batteryPct,
  tzOffsetMin: () => -new Date().getTimezoneOffset(),
});
const mediaRelay = startMediaRelay(link);
link.onConnected = () => {
  session.onDeviceConnected();
  mediaRelay?.onDeviceConnected();
};
link.onMediaCmd = (cmd) => mediaRelay?.onDeviceCommand(cmd);

// expo-battery reports -1 when the level is unknown (e.g. the iOS simulator).
const setBattery = (level: number) => {
  const pct = level >= 0 ? Math.round(level * 100) : null;
  if (pct === batteryPct) return;
  batteryPct = pct;
  session.onPhoneBatteryChanged(Date.now());
};
void Battery.getBatteryLevelAsync().then(setBattery);
Battery.addBatteryLevelListener(({ batteryLevel }) => setBattery(batteryLevel));
// Keeps an idle display's phone battery and clock current; a no-op while riding.
setInterval(() => session.heartbeat(Date.now()), 5000);

function toFix(l: Location.LocationObject): Fix {
  return {
    lat: l.coords.latitude,
    lon: l.coords.longitude,
    speedMps: l.coords.speed != null && l.coords.speed >= 0 ? l.coords.speed : null,
    accuracyM: l.coords.accuracy,
    timeMs: l.timestamp,
  };
}

TaskManager.defineTask<{ locations: Location.LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
  if (error || !data || simTimer) return;
  for (const l of data.locations) onFix(toFix(l));
});

let tickTimer: ReturnType<typeof setInterval> | null = null;
let simTimer: ReturnType<typeof setInterval> | null = null;
/** Every ride, real or simulated, is recorded from start to stopRide() and saved to history. */
let recorder: RideRecorder | null = null;

function onFix(f: Fix) {
  session.onFix(f);
  recorder?.onFix(f);
}

export async function ensureLocationPermission(background: boolean): Promise<boolean> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') return false;
  if (!background) return true;
  const bg = await Location.requestBackgroundPermissionsAsync();
  return bg.status === 'granted';
}

export async function currentPosition(): Promise<LatLon> {
  const l = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  return { lat: l.coords.latitude, lon: l.coords.longitude };
}

// The background location session is what keeps the app alive with the screen locked (iOS `location`
// background mode, Android foreground service), so it also runs during a simulation, fixes discarded.
async function startLocationUpdates(accuracy: Location.Accuracy) {
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy,
    timeInterval: 1000,
    distanceInterval: 0,
    activityType: Location.ActivityType.AutomotiveNavigation,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'OpenBee is navigating',
      notificationBody: 'Sending directions to your handlebar display',
      killServiceOnDestroy: true,
    },
  });
}

async function stopLocationUpdates() {
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false)) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  }
}

/** Start real navigation: background GPS feeds the session until stopRide(). */
export async function startRide(route: Route, destination: RideRecord['destination']) {
  if (!(await ensureLocationPermission(true))) throw new Error('Location permission ("Allow all the time") is required');
  session.start(route, destination.point);
  recorder = new RideRecorder(Date.now(), false, destination, route.lengthM);
  // Warm the tile cache ahead of the rider so a signal gap does not blank the map. Fire-and-forget.
  void prefetchAlongRoute(route);
  await startLocationUpdates(Location.Accuracy.BestForNavigation);
  tickTimer = setInterval(() => session.tick(Date.now()), 1000);
}

/** Ride the route virtually: same pipeline, fake GPS. Great for testing the device on the bench. */
export async function startSimulation(
  route: Route,
  destination: RideRecord['destination'],
  speedKmh = DEFAULT_SIM_SPEED_KMH,
) {
  session.start(route, destination.point);
  recorder = new RideRecorder(Date.now(), true, destination, route.lengthM);
  void prefetchAlongRoute(route);
  const speedMps = speedKmh / 3.6;
  const fixes = simulateRide(route, { speedMps, intervalMs: SIM_INTERVAL_MS, startMs: Date.now() });
  // simTimer is set before the keep-alive starts, so the location task never sees a gap to feed real fixes into.
  simTimer = setInterval(() => {
    const next = fixes.next();
    if (next.done) {
      if (simTimer) clearInterval(simTimer);
      simTimer = null;
      // Otherwise real GPS would start feeding the finished session.
      void stopLocationUpdates();
      return;
    }
    onFix(next.value);
  }, SIM_INTERVAL_MS);
  // Best effort: without location permission the simulation still runs, just not with the screen locked.
  if (await ensureLocationPermission(false)) {
    await startLocationUpdates(Location.Accuracy.Lowest).catch(() => {});
  }
}

export async function stopRide() {
  if (simTimer) clearInterval(simTimer);
  if (tickTimer) clearInterval(tickTimer);
  simTimer = tickTimer = null;
  await stopLocationUpdates();
  const record = recorder?.finish(Date.now(), session.getView().state === NavState.ARRIVED);
  recorder = null;
  if (record) history.add(record);
  session.stop();
}

export const isSimulating = () => simTimer != null;
