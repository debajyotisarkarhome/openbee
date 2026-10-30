// Hands a place chosen on the map picker screen back to the plan screen, which routes to it. The plan
// tab stays mounted under the picker modal, so its listener is there to receive it.
import { Place } from './graphhopper';

const listeners = new Set<(p: Place) => void>();

export const placePicker = {
  listen(fn: (p: Place) => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  emit(p: Place) {
    listeners.forEach((l) => l(p));
  },
};
