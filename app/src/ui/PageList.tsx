// Editor for the display's pages: a preview of the swipe order as little round screens, then one row per page
// with up/down to reorder and a switch to show or hide it. Nav stays on (it's the device's home page).
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Switch, Text, View } from 'react-native';

import { PageSetting, movePage, setPageOn } from '../core/layout';
import { Page } from '../core/proto';
import { Divider, IconButton } from './components';
import { colors, layout, space, type } from './theme';

type IconName = keyof typeof Ionicons.glyphMap;

export const PAGE_INFO: Record<Page, { name: string; detail: string; icon: IconName }> = {
  [Page.NAV]: { name: 'Nav', detail: 'Map and turn-by-turn, always on', icon: 'navigate-outline' },
  [Page.ENGINE]: { name: 'Engine', detail: 'RPM, speed, coolant, battery', icon: 'speedometer-outline' },
  [Page.MEDIA]: { name: 'Media', detail: 'Now playing and controls', icon: 'musical-notes-outline' },
  [Page.STATUS]: { name: 'Status', detail: 'Clock, batteries, arrival', icon: 'time-outline' },
  [Page.SETTINGS]: { name: 'Settings', detail: 'Brightness', icon: 'sunny-outline' },
};

export function PageList({ pages, onChange }: { pages: PageSetting[]; onChange: (p: PageSetting[]) => void }) {
  const shown = pages.filter((p) => p.on);
  return (
    <View style={styles.wrap}>
      <View style={styles.preview} accessibilityLabel={`Swipe order: ${shown.map((p) => PAGE_INFO[p.page].name).join(', ')}`}>
        {shown.map((p, i) => (
          <View key={p.page} style={styles.previewItem}>
            {i > 0 ? <Ionicons name="chevron-forward" size={12} color={colors.faint} /> : null}
            <View style={[styles.dot, p.page === Page.NAV && styles.dotHome]}>
              <Ionicons name={PAGE_INFO[p.page].icon} size={16} color={p.page === Page.NAV ? colors.accent : colors.text} />
            </View>
          </View>
        ))}
      </View>

      <View style={styles.card}>
        {pages.map((p, i) => {
          const info = PAGE_INFO[p.page];
          const isNav = p.page === Page.NAV;
          return (
            <View key={p.page}>
              {i > 0 ? <Divider /> : null}
              <View style={[styles.row, !p.on && styles.rowOff]}>
                <Ionicons name={info.icon} size={18} color={p.on ? colors.dim : colors.faint} style={styles.icon} />
                <View style={styles.body}>
                  <Text style={styles.title}>{info.name}</Text>
                  <Text style={styles.sub} numberOfLines={1}>
                    {info.detail}
                  </Text>
                </View>
                <IconButton
                  name="chevron-up"
                  size={20}
                  tone={i > 0 ? colors.text : colors.border}
                  onPress={() => onChange(movePage(pages, i, -1))}
                />
                <IconButton
                  name="chevron-down"
                  size={20}
                  tone={i < pages.length - 1 ? colors.text : colors.border}
                  onPress={() => onChange(movePage(pages, i, 1))}
                />
                <Switch
                  value={p.on}
                  disabled={isNav}
                  onValueChange={(on) => onChange(setPageOn(pages, p.page, on))}
                  trackColor={{ false: colors.surfaceHi, true: colors.accent }}
                  thumbColor="#FFFFFF"
                  ios_backgroundColor={colors.surfaceHi}
                />
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: layout.group },
  preview: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.xs },
  previewItem: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  dot: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#000000',
    borderWidth: 1,
    borderColor: colors.borderHi,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotHome: { borderColor: colors.accent },
  card: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.borderHi },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm + 2, minHeight: 56 },
  rowOff: { opacity: 0.55 },
  icon: { width: 18, textAlign: 'center', marginRight: space.xs },
  body: { flex: 1 },
  title: { ...type.body, color: colors.text },
  sub: { fontSize: 13, color: colors.dim, marginTop: 2 },
});
