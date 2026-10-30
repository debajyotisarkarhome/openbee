import { useSyncExternalStore } from 'react';

import { history } from '../services/history';
import { link, session } from '../services/runtime';
import { settings } from '../services/settings';

export const useSession = () => useSyncExternalStore(session.subscribe, session.getView);
export const useLink = () => useSyncExternalStore(link.subscribe, link.getView);
export const useSettings = () => useSyncExternalStore(settings.subscribe, settings.getView);
export const useHistory = () => useSyncExternalStore(history.subscribe, history.getView);
