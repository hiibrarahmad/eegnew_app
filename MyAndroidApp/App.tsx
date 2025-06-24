import React, { useEffect, useState, useRef } from 'react';
import {
  SafeAreaView,
  View,
  Text,
  FlatList,
  TouchableOpacity,
  TextInput,
  Button,
  StyleSheet,
  PermissionsAndroid,
  Platform,
} from 'react-native';
import { BleManager, Device } from 'react-native-ble-plx';
import base64 from 'react-native-base64';
import { Buffer } from 'buffer';

(global as any).Buffer = (global as any).Buffer || Buffer;

const BLE_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const BLE_CHAR_RX_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // write
const BLE_CHAR_TX_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // notify

const PACKET_SIZE = 21;
const NUM_CHANNELS = 3;

type LogItem = {
  dir: 'Info' | 'Warn' | 'Error' | 'Tx' | 'Pkt';
  msg: string;
  time: string;
};

export default function App() {
  const manager = useRef(new BleManager()).current;
  const [devices, setDevices] = useState<Device[]>([]);
  const [connected, setConnected] = useState<Device | null>(null);
  const [log, setLog] = useState<LogItem[]>([]);
  const [cmd, setCmd] = useState<string>('');
  const rxUuidRef = useRef<string | null>(null);
  const bufferRef = useRef<number[]>([]);

  useEffect(() => {
    requestPermissions();
  }, []);

  const requestPermissions = async () => {
    if (Platform.OS !== 'android') return;

    if (Platform.Version >= 31) {
      const result = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      ]);
      const allGranted = Object.values(result).every(
        v => v === PermissionsAndroid.RESULTS.GRANTED
      );
      if (allGranted) {
        pushLog('Info', 'All BLE permissions granted');
      } else {
        pushLog('Warn', 'BLE permissions denied');
      }
    } else {
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
      );
      if (result === PermissionsAndroid.RESULTS.GRANTED) {
        pushLog('Info', 'Location permission granted');
      } else {
        pushLog('Warn', 'Location permission denied');
      }
    }
  };

  const checkPermissions = async (): Promise<boolean> => {
    if (Platform.OS !== 'android') return true;

    if (Platform.Version >= 31) {
      const statuses = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      ]);
      return Object.values(statuses).every(
        s => s === PermissionsAndroid.RESULTS.GRANTED
      );
    } else {
      const status = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
      );
      return status === PermissionsAndroid.RESULTS.GRANTED;
    }
  };

  const scan = async () => {
    const hasPerm = await checkPermissions();
    if (!hasPerm) {
      pushLog('Warn', 'Cannot scan: permissions not granted');
      return;
    }

    pushLog('Info', 'Scanning…');
    setDevices([]);
    manager.startDeviceScan(null, { allowDuplicates: false }, (err, device) => {
      if (err) {
        pushLog('Error', err.message);
        return;
      }
      if (device) {
        setDevices(ds => (ds.some(d => d.id === device.id) ? ds : [...ds, device]));
      }
    });

    setTimeout(() => manager.stopDeviceScan(), 5000);
  };

  const connect = async (device: Device) => {
    try {
      await manager.stopDeviceScan();
      const d = await manager.connectToDevice(device.id);
      await d.discoverAllServicesAndCharacteristics();
      setConnected(d);
      rxUuidRef.current = BLE_CHAR_RX_UUID;
      d.monitorCharacteristicForService(
        BLE_SERVICE_UUID,
        BLE_CHAR_TX_UUID,
        onNotify
      );
      pushLog('Info', `Connected to ${device.name || device.id}`);
    } catch (e: any) {
      pushLog('Error', e.message);
    }
  };

  const onNotify = (_error: Error | null, char: any) => {
    if (_error) {
      pushLog('Error', _error.message);
      return;
    }
    const raw = base64.decode(char.value as string);
    const bytes = Array.from(raw).map(c => c.charCodeAt(0));
    bufferRef.current = [...bufferRef.current, ...bytes];

    while (bufferRef.current.length >= PACKET_SIZE) {
      const pkt = bufferRef.current.slice(0, PACKET_SIZE);
      bufferRef.current = bufferRef.current.slice(PACKET_SIZE);
      const [, sample, ch] = parsePacket(pkt);
      pushLog('Pkt', `#${sample} → Ch1:${ch[0]} Ch2:${ch[1]} Ch3:${ch[2]}`);
    }
  };

  const parsePacket = (pkt: number[]): [string, number, number[]] => {
    const sample = pkt[1];
    const ch: number[] = [];
    let offset = 2;
    for (let i = 0; i < NUM_CHANNELS; i++) {
      const raw = (pkt[offset + 1] << 16) | (pkt[offset + 2] << 8) | pkt[offset + 3];
      const val = raw & 0x800000 ? raw - (1 << 24) : raw;
      ch.push(val);
      offset += 4;
    }
    const hex = pkt.map(b => b.toString(16).padStart(2, '0')).join(' ');
    return [hex, sample, ch];
  };

  const sendCmd = async () => {
    if (!connected || !rxUuidRef.current) {
      pushLog('Warn', 'Not connected');
      return;
    }
    try {
      const payload = base64.encode(cmd + '\r');
      await connected.writeCharacteristicWithResponseForService(
        BLE_SERVICE_UUID,
        rxUuidRef.current,
        payload
      );
      pushLog('Tx', cmd);
      setCmd('');
    } catch (e: any) {
      pushLog('Error', e.message);
    }
  };

  const pushLog = (dir: LogItem['dir'], msg: string) => {
    const time = new Date().toLocaleTimeString(undefined, { hour12: false });
    setLog(l => [{ dir, msg, time }, ...l]);
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.row}>
        <Button title="Scan" onPress={scan} />
      </View>
      <FlatList
        data={devices}
        keyExtractor={item => item.id}
        renderItem={({ item: dev }) => {
          const matches = dev.serviceUUIDs?.map(u => u.toLowerCase()).includes(BLE_SERVICE_UUID);
          return (
            <TouchableOpacity
              style={[
                styles.device,
                matches ? { backgroundColor: '#cceeff' } : {},
              ]}
              onPress={() => connect(dev)}
            >
              <Text>
                {dev.name || 'Unknown'} ({dev.id.slice(-5)})
              </Text>
            </TouchableOpacity>
          );
        }}
      />
      <View style={styles.row}>
        <TextInput
          style={styles.input}
          placeholder="cmd: b / s / ?"
          value={cmd}
          onChangeText={setCmd}
        />
        <Button title="Send" onPress={sendCmd} />
      </View>
      <FlatList
        data={log}
        keyExtractor={(_, i) => i.toString()}
        renderItem={({ item }) => (
          <Text>
            [{item.time}] {item.dir}: {item.msg}
          </Text>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 10 },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  device: {
    padding: 8,
    backgroundColor: '#eee',
    marginBottom: 4,
    borderRadius: 4,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#999',
    padding: 6,
    marginRight: 6,
    borderRadius: 4,
  },
});
