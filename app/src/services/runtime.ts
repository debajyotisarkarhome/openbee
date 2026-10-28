// App-wide singletons: BLE link + nav session, wired to GPS (background), the ride simulator, battery
// and (Android) phone media.
// Imported once from the root layout so the background location task is defined at startup.
import * as Battery from 'expo-battery';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import { LatLon } from '../core/geo';
import { Fix } from '../core/nav-engine';
import { Route } from '../core/route';
import { NavSession } from '../core/session';
import { simulateRide } from '../core/simulator';
import { DeviceLink } from './ble';
import { startMediaRelay } from './media';
import { fetchRoute } from './routing';
import { fetchStreets, prefetchAlongRoute } from './streets';

export const LOCATION_TASK = 'openbee-location';
const DEFAULT_SIM_SPEED_KMH = 50;
const SIM_INTERVAL_MS = 500;

let batteryPct: number | null = null;
void Battery.getBatteryLevelAsync().then((l) => (batteryPct = l >= 0 ? Math.round(l * 100) : null));
Battery.addBatteryLevelListener(({ batteryLevel }) => (batteryPct = Math.round(batteryLevel * 100)));

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
  for (const l of data.locations) session.onFix(toFix(l));
});

let tickTimer: ReturnType<typeof setInterval> | null = null;
let simTimer: ReturnType<typeof setInterval> | null = null;

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

/** Start real navigation: background GPS feeds the session until stopRide(). */
export async function startRide(route: Route, destination: LatLon) {
  if (!(await ensureLocationPermission(true))) throw new Error('Location permission ("Allow all the time") is required');
  session.start(route, destination);
  // Warm the tile cache ahead of the rider so a signal gap does not blank the map. Fire-and-forget.
  void prefetchAlongRoute(route);
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.BestForNavigation,
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
  tickTimer = setInterval(() => session.tick(Date.now()), 1000);
}

/** Ride the route virtually: same pipeline, fake GPS. Great for testing the device on the bench. */
export function startSimulation(route: Route, destination: LatLon, speedKmh = DEFAULT_SIM_SPEED_KMH) {
  session.start(route, destination);
  void prefetchAlongRoute(route);
  const speedMps = speedKmh / 3.6;
  const fixes = simulateRide(route, { speedMps, intervalMs: SIM_INTERVAL_MS, startMs: Date.now() });
  simTimer = setInterval(() => {
    const next = fixes.next();
    if (next.done) {
      if (simTimer) clearInterval(simTimer);
      simTimer = null;
      return;
    }
    session.onFix(next.value);
  }, SIM_INTERVAL_MS);
}

export async function stopRide() {
  if (simTimer) clearInterval(simTimer);
  if (tickTimer) clearInterval(tickTimer);
  simTimer = tickTimer = null;
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false)) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  }
  session.stop();
}

export const isSimulating = () => simTimer != null;
