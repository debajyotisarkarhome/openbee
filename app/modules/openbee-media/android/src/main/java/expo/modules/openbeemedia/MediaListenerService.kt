package expo.modules.openbeemedia

import android.service.notification.NotificationListenerService

/**
 * Intentionally empty. Holding notification access is what authorises
 * MediaSessionManager.getActiveSessions(); no notifications are read or forwarded.
 */
class MediaListenerService : NotificationListenerService()
