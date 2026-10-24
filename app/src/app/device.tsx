import { useEffect } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { link } from '../services/runtime';
import { useLink } from '../ui/hooks';
import { colors } from '../ui/theme';

export default function DeviceScreen() {
  const v = useLink();

  useEffect(() => {
    if (v.status === 'idle') void link.scan();
    return () => link.stopScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (v.status === 'connected') {
    return (
      <View style={styles.screen}>
        <Text style={styles.title}>{v.deviceName}</Text>
        <Text style={styles.dim}>Connected</Text>
        {v.devStatus ? (
          <Text style={styles.body}>
            Battery {v.devStatus.battPct}% ({(v.devStatus.battMv / 1000).toFixed(2)} V){v.devStatus.charging ? ' · charging' : ''} · firmware v
            {v.devStatus.fwVer}
          </Text>
        ) : null}
        <Pressable style={styles.secondary} onPress={() => link.disconnect()}>
          <Text style={styles.secondaryText}>Forget display</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Text style={styles.dim}>
        {v.status === 'off'
          ? 'Turn on Bluetooth to find your display.'
          : v.status === 'connecting'
            ? 'Connecting…'
            : v.status === 'scanning'
              ? 'Looking for OpenBee displays…'
              : 'Power on the display, then scan.'}
      </Text>
      <FlatList
        data={v.found}
        keyExtractor={(d) => d.id}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => link.connect(item.id)}>
            <Text style={styles.body}>{item.name}</Text>
            <Text style={styles.dim}>{item.rssi ?? '–'} dBm</Text>
          </Pressable>
        )}
      />
      <Pressable style={styles.secondary} onPress={() => link.scan()} disabled={v.status === 'scanning'}>
        <Text style={styles.secondaryText}>{v.status === 'scanning' ? 'Scanning…' : 'Scan again'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, gap: 12, backgroundColor: colors.bg },
  title: { color: colors.text, fontSize: 22, fontWeight: '700' },
  body: { color: colors.text, fontSize: 16 },
  dim: { color: colors.dim },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  secondary: { borderColor: colors.border, borderWidth: 1, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  secondaryText: { color: colors.text, fontWeight: '600' },
});
