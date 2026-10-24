import { useSyncExternalStore } from 'react';

import { link, session } from '../services/runtime';

export const useSession = () => useSyncExternalStore(session.subscribe, session.getView);
export const useLink = () => useSyncExternalStore(link.subscribe, link.getView);
