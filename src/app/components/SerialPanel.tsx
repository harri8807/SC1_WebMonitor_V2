import { useState, useEffect, useRef, useCallback } from 'react';
import { Settings, Send, Trash2, Search, RefreshCw, Activity, Thermometer, Droplets, Gauge, PlayCircle, AlertCircle, StopCircle, Play, FileText, Save } from 'lucide-react';

// Web Serial API Type Definitions
interface SerialPort {
  open(options: SerialOptions): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  getInfo(): SerialPortInfo;
}

interface SerialOptions {
  baudRate: number;
  dataBits?: number;
  stopBits?: number;
  parity?: 'none' | 'even' | 'odd';
  bufferSize?: number;
  flowControl?: 'none' | 'hardware';
}

interface SerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}

interface NavigatorSerial {
  serial: {
    requestPort(options?: { filters?: Array<{ usbVendorId?: number; usbProductId?: number }> }): Promise<SerialPort>;
    getPorts(): Promise<SerialPort[]>;
    addEventListener(type: string, listener: (event: Event) => void): void;
    removeEventListener(type: string, listener: (event: Event) => void): void;
  };
}

// Machine Status Interface
export interface MachineStatus {
  timestamp?: string;
  error_code: number;
  flow_rate: number;
  brew_boiler_pressure: number;
  brew_boiler_temperature: number;
  brew_head_temperature: number;
  brew_pressure_level: number;
  steam_boiler_water_level: number;
  steam_run_status: number;
  steam_boiler_pressure: number;
  steam_boiler_temperature: number;
  steam_milk_temperature: number;
  steam_pressure_level: number;
  hot_water_run_status: number;
  hot_water_percent_level: number;
  hot_water_temperature: number;
  tray_postion_state: number;
  brew_handle_postion_state: number;
  hot_switch_postion_state: number;
  tray_high_level_state: number;
  tray_low_level_state_1: number;
  tray_low_level_state_2: number;
  current_stage: number;
  total_stage: number;
  drink_making_flg: number;
  liquid_adc: number;
  liquid_weight: number;
  ucFwVersion: string;
}

interface SerialPanelProps {
  onDataReceived?: (data: string) => void;
  onStatusUpdate?: (status: MachineStatus) => void;
  onPortSelected?: (name: string) => void;
}

export function SerialPanel({ onDataReceived, onStatusUpdate, onPortSelected }: SerialPanelProps) {
  const [ports, setPorts] = useState<SerialPort[]>([]);
  const [selectedPort, setSelectedPort] = useState<SerialPort | null>(null);

  const [sendData, setSendData] = useState('');
  const [sendDataSticky, setSendDataSticky] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isReading, setIsReading] = useState(false);

  // Protocol State
  const [autoPoll, setAutoPoll] = useState(true);
  const [machineStatus, setMachineStatus] = useState<MachineStatus | null>(null);
  const [pollIntervalId, setPollIntervalId] = useState<ReturnType<typeof setInterval> | null>(null);

  // CSV Logging State
  const [isLogging, setIsLogging] = useState(false);
  const [csvData, setCsvData] = useState<MachineStatus[]>([]);
  const isLoggingRef = useRef(false);

  // Target Weight for Extraction
  const [targetWeight, setTargetWeight] = useState(40);

  // Target Water Temperature for Hot Water
  const [targetWaterTemp, setTargetWaterTemp] = useState(80);

  // Extraction timer (seconds)
  const [extractionTime, setExtractionTime] = useState<number>(0);
  const extractionTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const extractionStartRef = useRef<number | null>(null);
  const extractionRunningRef = useRef<boolean>(false);
  const prevDrinkFlagRef = useRef<number | null>(null);

  // Pre-soak control
  const [preSoakEnabled, setPreSoakEnabled] = useState<'on' | 'off'>('off');
  const [preSoakVolume, setPreSoakVolume] = useState<number>(20); // ml, default 20
  const [preSoakTime, setPreSoakTime] = useState<number>(3); // seconds, default 3

  // Voice Alarm State for Steam Boiler Pressure
  const [isAlarmActive, setIsAlarmActive] = useState(false);
  const [isManualAlarmTest, setIsManualAlarmTest] = useState(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const oscillatorRef = useRef<OscillatorNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const alarmIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Port Name Mapping (store custom names for ports)
  const [portNames, setPortNames] = useState<Map<SerialPort, string>>(new Map());

  // Refs for stream handling
  const portRef = useRef<SerialPort | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const writerRef = useRef<WritableStreamDefaultWriter<Uint8Array> | null>(null);
  const keepReadingRef = useRef<boolean>(false);
  const bufferRef = useRef<string>('');
  const logBufferRef = useRef<string>('');
  const closedPromiseRef = useRef<Promise<void> | null>(null); // Track read loop completion

  // Check Web Serial API support
  useEffect(() => {
    const nav = navigator as unknown as NavigatorSerial;
    if (!nav.serial) {
      console.error('[System] Web Serial API not supported in this browser.');
    }
  }, []);



  // Sync connection status to parent
  useEffect(() => {
    if (isConnected && selectedPort && onPortSelected) {
      const customName = portNames.get(selectedPort);
      const portName = customName || `COM${ports.indexOf(selectedPort) + 1}`;
      onPortSelected(portName);
    } else if (onPortSelected) {
      onPortSelected('');
    }
  }, [isConnected, selectedPort, ports, portNames, onPortSelected]);

  // Steam Boiler Pressure Alarm Monitoring
  useEffect(() => {
    // Skip automatic monitoring if in manual test mode
    if (isManualAlarmTest) return;

    if (!machineStatus) return;

    const PRESSURE_THRESHOLD = 3.0;
    const currentPressure = machineStatus.steam_boiler_pressure;

    if (currentPressure > PRESSURE_THRESHOLD && !isAlarmActive) {
      // Start alarm
      startAlarm();
      setIsAlarmActive(true);
      console.log(`[ALARM] Steam boiler pressure exceeded ${PRESSURE_THRESHOLD} bar: ${currentPressure.toFixed(2)} bar`);
    } else if (currentPressure <= PRESSURE_THRESHOLD && isAlarmActive) {
      // Stop alarm
      stopAlarm();
      setIsAlarmActive(false);
      console.log(`[ALARM] Steam boiler pressure normal: ${currentPressure.toFixed(2)} bar`);
    }
  }, [machineStatus?.steam_boiler_pressure, isManualAlarmTest]);

  // Extraction timer: start only when drink_making_flg transitions from 2 -> 4 or 2 -> 6, stop when it becomes 0
  useEffect(() => {
    const currentFlag = machineStatus?.drink_making_flg ?? null;
    const prevFlag = prevDrinkFlagRef.current;

    const isBrewFlag = (f: number | null) => f === 4 || f === 6;

    // Start only when previous flag was 2 and current becomes 4 or 6
    if (prevFlag === 2 && isBrewFlag(currentFlag) && !extractionRunningRef.current) {
      extractionStartRef.current = Date.now();
      extractionRunningRef.current = true;
      setExtractionTime(0);
      extractionTimerRef.current = setInterval(() => {
        if (extractionStartRef.current !== null) {
          setExtractionTime(Math.floor((Date.now() - extractionStartRef.current) / 1000));
        }
      }, 1000);
    }

    // Stop when flag becomes 0 or 3 (regardless of previous)
    if ((currentFlag === 0 || currentFlag === 3) && extractionRunningRef.current) {
      if (extractionTimerRef.current) {
        clearInterval(extractionTimerRef.current);
        extractionTimerRef.current = null;
      }
      if (extractionStartRef.current !== null) {
        setExtractionTime(Math.floor((Date.now() - extractionStartRef.current) / 1000));
      }
      extractionStartRef.current = null;
      extractionRunningRef.current = false;
    }

    // Remember current flag for next transition detection
    prevDrinkFlagRef.current = currentFlag;

    return () => { };
  }, [machineStatus?.drink_making_flg]);

  // Cleanup extraction timer on unmount
  useEffect(() => {
    return () => {
      if (extractionTimerRef.current) {
        clearInterval(extractionTimerRef.current);
        extractionTimerRef.current = null;
      }
    };
  }, []);

  // Cleanup alarm on unmount
  useEffect(() => {
    return () => {
      stopAlarm();
    };
  }, []);

  const startAlarm = () => {
    try {
      // Initialize AudioContext if not already created
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }

      const audioContext = audioContextRef.current;

      // Create oscillator and gain node
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(800, audioContext.currentTime); // 800Hz tone

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      oscillatorRef.current = oscillator;
      gainNodeRef.current = gainNode;

      oscillator.start();

      // Create beep pattern: 500ms on, 500ms off
      let isBeeping = true;
      gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);

      alarmIntervalRef.current = setInterval(() => {
        if (gainNodeRef.current) {
          if (isBeeping) {
            gainNodeRef.current.gain.setValueAtTime(0, audioContext.currentTime);
          } else {
            gainNodeRef.current.gain.setValueAtTime(0.3, audioContext.currentTime);
          }
          isBeeping = !isBeeping;
        }
      }, 500);

    } catch (error) {
      console.error('[ALARM] Failed to start alarm:', error);
    }
  };

  const stopAlarm = () => {
    try {
      // Clear interval
      if (alarmIntervalRef.current) {
        clearInterval(alarmIntervalRef.current);
        alarmIntervalRef.current = null;
      }

      // Stop oscillator
      if (oscillatorRef.current) {
        oscillatorRef.current.stop();
        oscillatorRef.current.disconnect();
        oscillatorRef.current = null;
      }

      // Disconnect gain node
      if (gainNodeRef.current) {
        gainNodeRef.current.disconnect();
        gainNodeRef.current = null;
      }

      // Close audio context
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
    } catch (error) {
      console.error('[ALARM] Failed to stop alarm:', error);
    }
  };

  // Polling Effect
  useEffect(() => {
    if (isConnected && autoPoll) {
      const id = setInterval(() => {
        sendString("102@READ@ALL#43433");
      }, 500);
      setPollIntervalId(id);
      return () => clearInterval(id);
    } else {
      if (pollIntervalId) {
        clearInterval(pollIntervalId);
        setPollIntervalId(null);
      }
    }
  }, [isConnected, autoPoll]);

  const sendString = async (str: string) => {
    if (!writerRef.current) return;
    try {
      const encoder = new TextEncoder();
      const data = encoder.encode(str);
      await writerRef.current.write(data);
    } catch (e) {
      console.error('Send failed', e);
    }
  };

  // Generate friendly device name based on VID/PID
  const getDeviceName = (port: SerialPort): string => {
    const info = port.getInfo();
    const vid = info.usbVendorId;
    const pid = info.usbProductId;

    if (!vid || !pid) {
      return '通用串口设备';
    }

    const vidHex = vid.toString(16).toUpperCase().padStart(4, '0');
    const pidHex = pid.toString(16).toUpperCase().padStart(4, '0');

    // Common USB-Serial chip manufacturers
    const vendorNames: { [key: number]: string } = {
      0x0403: 'FTDI设备',      // FTDI
      0x10C4: 'Silicon Labs',  // Silicon Labs CP210x
      0x1A86: 'CH340设备',     // WCH CH340
      0x067B: 'Prolific设备',  // Prolific PL2303
      0x2341: 'Arduino设备',   // Arduino
      0x1A40: 'TERMINUS',      // TERMINUS
      0x0483: 'STM设备',       // STMicroelectronics
    };

    const vendorName = vendorNames[vid] || 'USB串口';
    return `${vendorName} (VID:${vidHex} PID:${pidHex})`;
  };

  const handleSearchPort = async () => {
    const nav = navigator as unknown as NavigatorSerial;
    if (!nav.serial) return;

    try {
      const port = await nav.serial.requestPort();

      // Check if port already exists in the list
      const portExists = ports.some(p => p === port);
      if (!portExists) {
        setPorts(prevPorts => [...prevPorts, port]);
      }

      // Automatically generate device name from VID/PID
      const deviceName = getDeviceName(port);
      setPortNames(prev => {
        const newMap = new Map(prev);
        newMap.set(port, deviceName);
        return newMap;
      });

      setSelectedPort(port);
    } catch (err) {
      console.log('Port selection cancelled or failed', err);
    }
  };

  const parseMachineStatus = (payload: string) => {
    // Format: 102@READ@<csv>#CRC
    const startMarker = "102@READ@";
    const startIndex = payload.lastIndexOf(startMarker);
    if (startIndex === -1) return;

    const remaining = payload.substring(startIndex + startMarker.length);
    const endIndex = remaining.indexOf('#');
    if (endIndex === -1) return;

    const csvData = remaining.substring(0, endIndex);
    const parts = csvData.split(',').map(s => s.trim());

    if (parts.length < 27) return;

    // If firmware version comes in as a dotted segment split across fields (e.g. 0.0.2),
    // rejoin the tail so we can parse the fixed fields correctly.
    let normalizedParts = parts;
    if (parts.length > 27) {
      const head = parts.slice(0, 26);
      const version = parts.slice(26).join('.');
      normalizedParts = [...head, version];
    }

    const status: MachineStatus = {
      timestamp: new Date().toISOString(),
      error_code: parseInt(normalizedParts[0]) || 0,
      flow_rate: parseFloat(normalizedParts[1]) || 0,
      brew_boiler_pressure: parseFloat(normalizedParts[2]) || 0,
      brew_boiler_temperature: parseFloat(normalizedParts[3]) || 0,
      brew_head_temperature: parseFloat(normalizedParts[4]) || 0,
      brew_pressure_level: parseInt(normalizedParts[5]) || 0,
      steam_boiler_water_level: parseInt(normalizedParts[6]) || 0,
      steam_run_status: parseInt(normalizedParts[7]) || 0,
      steam_boiler_pressure: parseFloat(normalizedParts[8]) || 0,
      steam_boiler_temperature: parseFloat(normalizedParts[9]) || 0,
      steam_milk_temperature: parseFloat(normalizedParts[10]) || 0,
      steam_pressure_level: parseInt(normalizedParts[11]) || 0,
      hot_water_run_status: parseInt(normalizedParts[12]) || 0,
      hot_water_percent_level: parseInt(normalizedParts[13]) || 0,
      hot_water_temperature: parseFloat(normalizedParts[14]) || 0,
      tray_postion_state: parseInt(normalizedParts[15]) || 0,
      brew_handle_postion_state: parseInt(normalizedParts[16]) || 0,
      hot_switch_postion_state: parseInt(normalizedParts[17]) || 0,
      tray_high_level_state: parseInt(normalizedParts[18]) || 0,
      tray_low_level_state_1: parseInt(normalizedParts[19]) || 0,
      tray_low_level_state_2: parseInt(normalizedParts[20]) || 0,
      current_stage: parseInt(normalizedParts[21]) || 0,
      total_stage: parseInt(normalizedParts[22]) || 0,
      drink_making_flg: parseInt(normalizedParts[23]) || 0,
      liquid_adc: parseInt(normalizedParts[24]) || 0,
      liquid_weight: parseFloat(normalizedParts[25]) || 0,
      ucFwVersion: normalizedParts[26] || '',
    };

    setMachineStatus(status);
    if (onStatusUpdate) {
      onStatusUpdate(status);
    }

    // Collect data for CSV logging
    if (isLoggingRef.current) {
      setCsvData(prev => [...prev, status]);
    }

    return startIndex + startMarker.length + endIndex + 1;
  };

  const readLoop = async () => {
    if (!portRef.current?.readable) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const textDecoder = new (window as any).TextDecoderStream();
    const readableStreamClosed = portRef.current.readable.pipeTo(textDecoder.writable);
    const reader = textDecoder.readable.getReader();
    readerRef.current = reader;

    try {
      while (keepReadingRef.current) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          // Log Buffering Logic
          // DEBUG: Print raw data to confirm reception
          console.log(`[Raw] Received chunk (${value.length} chars):`, JSON.stringify(value));

          logBufferRef.current += value;

          // Split on any common line ending: \r\n, \n, or \r
          // Note: If we receive "abc\r" and the next chunk is "\n", this might split early, 
          // but for visual logging this is acceptable to avoid delay.
          let lines = logBufferRef.current.split(/\r\n|\n|\r/);

          // If we have more than 1 item, it means we have at least one complete line
          if (lines.length > 1) {
            const completeLines = lines.slice(0, -1);
            const remainder = lines[lines.length - 1];

            logBufferRef.current = remainder;

            const time = new Date().toLocaleTimeString();
            completeLines.forEach(line => {
              if (line) {
                console.log(`[${time}] ${line}`);
              }
            });
          } else if (logBufferRef.current.length > 2000) {
            // Fail-safe: if line is too long without breaks, print it anyway
            console.log(`[${new Date().toLocaleTimeString()}] (Buffer Full) ${logBufferRef.current}`);
            logBufferRef.current = '';
          }

          // Parsing Logic (independent of log buffering)
          bufferRef.current += value;

          while (true) {
            const packetEnd = parseMachineStatus(bufferRef.current);
            if (packetEnd) {
              bufferRef.current = bufferRef.current.slice(packetEnd);
              continue;
            }
            break;
          }

          if (bufferRef.current.length > 10000) {
            bufferRef.current = bufferRef.current.slice(-1000);
          }

          if (onDataReceived) {
            onDataReceived(value);
          }
        }
      }
    } catch (error) {
      console.error('Read error:', error);
    } finally {
      reader.releaseLock();
      await readableStreamClosed.catch(() => { });
    }
  };

  const handleConnect = async () => {
    if (isConnected) {
      if (isLoggingRef.current) {
        isLoggingRef.current = false;
        setIsLogging(false);
        handleSaveCSV();
        console.log('[CSV] Logging stopped (disconnect)');
      }

      // Graceful Disconnect
      keepReadingRef.current = false;

      // 1. Cancel the reader to break the loop
      if (readerRef.current) {
        try {
          await readerRef.current.cancel();
        } catch (e) {
          console.error('Error cancelling reader', e);
        }
      }

      // 2. Wait for the read loop to completely finish (which releases locks)
      if (closedPromiseRef.current) {
        try {
          await closedPromiseRef.current;
        } catch (e) {
          console.error('Error in closedPromise', e);
        }
        closedPromiseRef.current = null;
      }

      // 3. Release writer lock
      if (writerRef.current) {
        try {
          writerRef.current.releaseLock();
        } catch (e) { console.error('Error releasing writer', e); }
      }

      // 4. Close the port
      if (portRef.current) {
        try {
          await portRef.current.close();
        } catch (e) {
          console.error('Error closing port', e);
        }
      }

      portRef.current = null;
      setIsConnected(false);
      setIsReading(false);
      setAutoPoll(false);
      console.log(`[${new Date().toLocaleTimeString()}] Disconnected`);

    } else {
      if (!selectedPort) return;

      try {
        await selectedPort.open({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' });
        portRef.current = selectedPort;
        setIsConnected(true);
        console.log(`[${new Date().toLocaleTimeString()}] Connected (115200, 8N1)`);

        if (selectedPort.writable) {
          writerRef.current = selectedPort.writable.getWriter();
        }

        keepReadingRef.current = true;
        setIsReading(true);
        // Store the read loop promise to await on disconnect
        closedPromiseRef.current = readLoop();

      } catch (err) {
        console.error('Failed to connect:', err);
        setIsConnected(false);
      }
    }
  };

  const sendInterferingCommand = async (command: string) => {
    const wasPolling = autoPoll;
    if (wasPolling) {
      setAutoPoll(false);
    }

    // Give React time to re-render and stop the polling
    await new Promise(resolve => setTimeout(resolve, 100));

    await sendString(command);

    // Resume polling after a delay
    if (wasPolling) {
      setTimeout(() => setAutoPoll(true), 500);
    }
  };

  const handleSend = async () => {
    if (!sendData.trim() || !isConnected || !writerRef.current) return;
    try {
      console.log(`[${new Date().toLocaleTimeString()}] Send: ${sendData}`);
      const commandToSend = sendData + '\n';

      const wasPolling = autoPoll;
      if (wasPolling) {
        setAutoPoll(false);
      }
      await new Promise(resolve => setTimeout(resolve, 100));

      const encoder = new TextEncoder();
      const data = encoder.encode(commandToSend);
      await writerRef.current.write(data);

      if (wasPolling) {
        setTimeout(() => setAutoPoll(true), 500);
      }

      // Intentionally keep `sendData` after sending so the input is preserved
    } catch (err) {
      console.error('Send error:', err);
    }
  };

  const handleSendSticky = async () => {
    if (!sendDataSticky.trim() || !isConnected || !writerRef.current) return;
    try {
      console.log(`[${new Date().toLocaleTimeString()}] Send(sticky): ${sendDataSticky}`);

      const wasPolling = autoPoll;
      if (wasPolling) {
        setAutoPoll(false);
      }
      await new Promise(resolve => setTimeout(resolve, 100));

      const encoder = new TextEncoder();
      const data = encoder.encode(sendDataSticky + '\n');
      await writerRef.current.write(data);

      if (wasPolling) {
        setTimeout(() => setAutoPoll(true), 500);
      }
      // NOTE: intentionally do NOT clear sendDataSticky
    } catch (err) {
      console.error('Send(sticky) error:', err);
    }
  };

  const handleExtraction = async (start: boolean) => {
    if (start) {
      // Reset extraction timer when user initiates extraction
      setExtractionTime(0);
      extractionStartRef.current = null;
      extractionRunningRef.current = false;
      const preFlag = preSoakEnabled === 'on' ? 1 : 0;
      const prePart = `PRE_INFUSION=${preFlag},${preSoakVolume},${preSoakTime}`;
      const freePart = `FREE_PRESSURE=${targetWeight},9,93`;
      const cmd = `123@FREE_PRESSURE@${prePart}|${freePart}#123`;
      console.log(`[CMD] Start Extraction (Target: ${targetWeight}g) -> ${cmd}`);
      await sendInterferingCommand(cmd);
    } else {
      const cmd = "123@OUT@NULL#123";
      console.log(`[CMD] Stop Extraction`);
      await sendInterferingCommand(cmd);
    }
  };

  const handlePowerOnTest = async () => {
    const cmd = "123@POWER_ON@NULL#123";
    console.log(`[CMD] Power On Self Test`);
    await sendInterferingCommand(cmd);
  };

  const handleHotWater = async () => {
    const cmd = `102@HOT_WATER@HOT_WATER=${targetWeight},${targetWaterTemp}#102`;
    console.log(`[CMD] Hot Water (Target: ${targetWeight}ml,${targetWaterTemp}°C)`);
    await sendInterferingCommand(cmd);
  };

  const handleAlarmTest = () => {
    if (isManualAlarmTest) {
      // Stop test
      stopAlarm();
      setIsAlarmActive(false);
      setIsManualAlarmTest(false);
      console.log('[ALARM TEST] Manual test stopped');
    } else {
      // Start test
      startAlarm();
      setIsAlarmActive(true);
      setIsManualAlarmTest(true);
      console.log('[ALARM TEST] Manual test started');
    }
  };

  // Convert MachineStatus array to CSV string
  const convertToCSV = (data: MachineStatus[]): string => {
    if (data.length === 0) return '';

    // Define CSV headers
    const headers = [
      'timestamp',
      'error_code',
      'flow_rate',
      'brew_boiler_pressure',
      'brew_boiler_temperature',
      'brew_head_temperature',
      'brew_pressure_level',
      'steam_boiler_water_level',
      'steam_run_status',
      'steam_boiler_pressure',
      'steam_boiler_temperature',
      'steam_milk_temperature',
      'steam_pressure_level',
      'hot_water_run_status',
      'hot_water_percent_level',
      'hot_water_temperature',
      'tray_postion_state',
      'brew_handle_postion_state',
      'hot_switch_postion_state',
      'tray_high_level_state',
      'tray_low_level_state_1',
      'tray_low_level_state_2',
      'current_stage',
      'total_stage',
      'drink_making_flg',
      'liquid_adc',
      'liquid_weight',
      'ucFwVersion'
    ];

    // Create CSV rows
    const rows = data.map(record => {
      return headers.map(header => {
        const value = record[header as keyof MachineStatus];
        // Escape values containing commas or quotes
        if (typeof value === 'string' && (value.includes(',') || value.includes('"'))) {
          return `"${value.replace(/"/g, '""')}"`;
        }
        return value;
      }).join(',');
    });

    // Combine headers and rows
    return [headers.join(','), ...rows].join('\n');
  };

  // Save CSV file
  const handleSaveCSV = () => {
    if (csvData.length === 0) {
      console.log('[CSV] No data to save');
      return;
    }

    try {
      // Generate timestamp for filename: YYYYMMDD_HHmmss
      const now = new Date();
      const timestamp = now.toISOString()
        .replace(/[-:]/g, '')
        .replace('T', '_')
        .split('.')[0];

      const filename = `MachineStatus_${timestamp}.csv`;
      const csvContent = convertToCSV(csvData);

      // Create blob and download
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);

      link.setAttribute('href', url);
      link.setAttribute('download', filename);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      console.log(`[CSV] Saved ${csvData.length} records to ${filename}`);
    } catch (error) {
      console.error('[CSV] Save error:', error);
    }
  };

  // Handle logging control
  const handleLogging = (start: boolean) => {
    if (start) {
      isLoggingRef.current = true;
      setIsLogging(true);
      setCsvData([]);
      console.log('[CSV] Logging started');
    } else {
      isLoggingRef.current = false;
      setIsLogging(false);
      handleSaveCSV();
      console.log('[CSV] Logging stopped');
    }
  };

  return (
    <div className="flex flex-col h-full bg-gray-50 border-l border-gray-200 overflow-y-auto">
      {/* 串口设置区 */}
      <div className="p-4 bg-white border-b border-gray-200 flex-shrink-0">
        <div className="flex items-center gap-2 mb-4">
          <Settings className="w-5 h-5 text-blue-600" />
          <h3 className="font-semibold">串口设置</h3>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-sm text-gray-600 mb-1">端口</label>
            <div className="flex gap-2">
              <select
                value={ports.indexOf(selectedPort as SerialPort)}
                onChange={(e) => {
                  const idx = parseInt(e.target.value);
                  if (idx >= 0 && idx < ports.length) {
                    setSelectedPort(ports[idx]);
                  }
                }}
                disabled={isConnected}
                className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
              >
                {ports.length === 0 ? (
                  <option value="-1">未检测到端口</option>
                ) : (
                  ports.map((port, index) => {
                    const customName = portNames.get(port) || `COM${index + 1}`;
                    return (
                      <option key={index} value={index}>
                        {customName}
                      </option>
                    );
                  })
                )}
              </select>
              <button
                onClick={handleSearchPort}
                disabled={isConnected}
                className="px-3 py-2 bg-gray-100 hover:bg-gray-200 rounded-md border border-gray-300 text-gray-700 disabled:opacity-50"
                title="Search & Request Port"
              >
                <Search className="w-4 h-4" />
              </button>
            </div>
            {isConnected && selectedPort && (
              <div className="text-xs text-green-700 mt-1 pl-1 font-medium flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full bg-green-500"></span>
                已连接: {portNames.get(selectedPort) || `COM${ports.indexOf(selectedPort) + 1}`}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 bg-blue-50 p-2 rounded border border-blue-100">
            <input
              type="checkbox"
              id="autoPoll"
              checked={autoPoll}
              onChange={(e) => setAutoPoll(e.target.checked)}
              disabled={!isConnected}
              className="rounded text-blue-600 focus:ring-blue-500"
            />
            <label htmlFor="autoPoll" className="text-sm font-medium text-gray-700 cursor-pointer select-none">
              设备状态轮询 (500ms)
            </label>
            {autoPoll && isConnected && <span className="flex h-2 w-2 relative ml-auto">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
            </span>}
          </div>

          <button
            onClick={handleConnect}
            disabled={!selectedPort}
            className={`w-full py-2 rounded-md font-medium transition-colors ${isConnected
              ? 'bg-red-500 hover:bg-red-600 text-white'
              : 'bg-green-500 hover:bg-green-600 text-white disabled:bg-green-300'
              }`}
          >
            {isConnected ? '断开连接' : '连接'}
          </button>
        </div>
      </div>

      {/* 萃取控制区 - 仅连接时显示 */}
      {isConnected && (
        <div className="p-4 bg-purple-50 border-b border-purple-100 flex-shrink-0">
          <h3 className="font-semibold mb-3 flex items-center gap-2 text-purple-800">
            <PlayCircle className="w-4 h-4" />
            控制
          </h3>

            {/* 预浸泡控制 */}
            <div className="mb-3 bg-white p-3 rounded-lg border border-purple-200">
              <label className="block text-sm font-medium text-gray-700 mb-2">预浸泡控制</label>

              <div className="flex items-center gap-4 mb-2">
                <label className="inline-flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="preSoak"
                    checked={preSoakEnabled === 'on'}
                    onChange={() => setPreSoakEnabled('on')}
                    className="rounded text-blue-600"
                  />
                  开
                </label>
                <label className="inline-flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="preSoak"
                    checked={preSoakEnabled === 'off'}
                    onChange={() => setPreSoakEnabled('off')}
                    className="rounded text-blue-600"
                  />
                  关
                </label>
              </div>

              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <label className="text-xs text-gray-500">体积 (ml)</label>
                  <input
                    type="number"
                    min="0"
                    value={preSoakVolume}
                    onChange={(e) => setPreSoakVolume(parseInt(e.target.value) || 30)}
                    className="w-full px-2 py-1 border border-gray-300 rounded text-center font-mono font-semibold text-purple-700"
                  />
                </div>
                <div className="w-28">
                  <label className="text-xs text-gray-500">时间 (s)</label>
                  <input
                    type="number"
                    min="0"
                    value={preSoakTime}
                    onChange={(e) => setPreSoakTime(parseInt(e.target.value) || 5)}
                    className="w-full px-2 py-1 border border-gray-300 rounded text-center font-mono font-semibold text-purple-700"
                  />
                </div>
              </div>
            </div>

            {/* 目标克重选择器 */}
            <div className="mb-3 bg-white p-3 rounded-lg border border-purple-200">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                目标克重 (g)
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min="10"
                  max="200"
                  step="5"
                  value={targetWeight}
                  onChange={(e) => setTargetWeight(parseInt(e.target.value))}
                  className="flex-1 h-2 bg-purple-200 rounded-lg appearance-none cursor-pointer accent-purple-600"
                />
                <input
                  type="number"
                  min="10"
                  max="200"
                  step="1"
                  value={targetWeight}
                  onChange={(e) => setTargetWeight(parseInt(e.target.value) || 40)}
                  className="w-20 px-2 py-1 border border-gray-300 rounded text-center font-mono font-semibold text-purple-700"
                />
              </div>
            </div>

            {/* 目标水温选择器 */}
            <div className="mb-3 bg-white p-3 rounded-lg border border-purple-200">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                目标水温 (°C)
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min="50"
                  max="100"
                  step="5"
                  value={targetWaterTemp}
                  onChange={(e) => setTargetWaterTemp(parseInt(e.target.value))}
                  className="flex-1 h-2 bg-purple-200 rounded-lg appearance-none cursor-pointer accent-purple-600"
                />
                <input
                  type="number"
                  min="50"
                  max="100"
                  step="5"
                  value={targetWaterTemp}
                  onChange={(e) => {
                    const val = parseInt(e.target.value) || 80;
                    const clamped = Math.min(100, Math.max(50, val));
                    const rounded = Math.round(clamped / 5) * 5;
                    setTargetWaterTemp(rounded);
                  }}
                  className="w-20 px-2 py-1 border border-gray-300 rounded text-center font-mono font-semibold text-purple-700"
                />
              </div>
            </div>

            <div className="grid grid-cols-4 gap-2">
            <button
              onClick={() => handleExtraction(true)}
              disabled={!machineStatus || machineStatus.brew_boiler_temperature < 90 || machineStatus.drink_making_flg === 4 || machineStatus.drink_making_flg === 6}
              className="flex items-center justify-center gap-1 px-3 py-2 bg-green-600 hover:bg-green-700 text-white rounded-md transition-colors shadow-sm font-medium disabled:bg-gray-400 disabled:cursor-not-allowed text-sm"
            >
              <Play className="w-4 h-4 fill-current" />
              萃取
            </button>
            <button
              onClick={handleHotWater}
              className="flex items-center justify-center gap-1 px-3 py-2 bg-orange-600 hover:bg-orange-700 text-white rounded-md transition-colors shadow-sm font-medium text-sm"
            >
              <Thermometer className="w-4 h-4" />
              热水
            </button>
            <button
              onClick={() => handleExtraction(false)}
              className="flex items-center justify-center gap-1 px-3 py-2 bg-red-600 hover:bg-red-700 text-white rounded-md transition-colors shadow-sm font-medium text-sm"
            >
              <StopCircle className="w-4 h-4" />
              停止
            </button>
            <button
              onClick={handlePowerOnTest}
              className="flex items-center justify-center gap-1 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors shadow-sm font-medium text-sm"
            >
              <Activity className="w-4 h-4" />
              自检
            </button>
          </div>

          {/* Alarm Test Button */}
          <div className="mt-3">
            <button
              onClick={handleAlarmTest}
              className={`w-full flex items-center justify-center gap-2 px-4 py-2 rounded-md transition-colors shadow-sm font-medium text-sm ${isManualAlarmTest
                  ? 'bg-red-600 hover:bg-red-700 text-white animate-pulse'
                  : 'bg-yellow-600 hover:bg-yellow-700 text-white'
                }`}
            >
              <AlertCircle className="w-4 h-4" />
              {isManualAlarmTest ? '停止报警测试' : '测试报警音'}
            </button>
          </div>
        </div>
      )}

      {/* 日志控制区 - 仅连接时显示 */}
      {isConnected && (
        <div className="p-4 bg-green-50 border-b border-green-100 flex-shrink-0">
          <h3 className="font-semibold mb-3 flex items-center gap-2 text-green-800">
            <FileText className="w-4 h-4" />
            数据日志
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => handleLogging(true)}
              disabled={isLogging}
              className="flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors shadow-sm font-medium disabled:bg-gray-400 disabled:cursor-not-allowed"
            >
              <FileText className="w-4 h-4" />
              日志记录
            </button>
            <button
              onClick={() => handleLogging(false)}
              disabled={!isLogging}
              className="flex items-center justify-center gap-2 px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white rounded-md transition-colors shadow-sm font-medium disabled:bg-gray-400 disabled:cursor-not-allowed"
            >
              <Save className="w-4 h-4" />
              日志停止
            </button>
          </div>
          {isLogging && (
            <div className="mt-2 text-sm text-green-700 flex items-center gap-2">
              <span className="flex h-2 w-2 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
              </span>
              正在记录... ({csvData.length} 条记录)
            </div>
          )}
        </div>
      )}

      {/* Machine Status Dashboard - 可滚动 */}
      {machineStatus && (
        <div className="p-4 bg-white border-b border-gray-200 flex-shrink-0">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold flex items-center gap-2">
              <Activity className="w-4 h-4 text-green-600" />
              Machine Status
            </h3>
            <span className="text-xs bg-gray-100 px-2 py-1 rounded text-gray-600 border border-gray-200">
              CTR Ver: {machineStatus.ucFwVersion}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm">

            {/* Brew Section */}
            <div className="col-span-2 bg-orange-50 p-2 rounded border border-orange-100">
              <div className="font-semibold text-orange-800 mb-2 flex items-center gap-1">
                <Droplets className="w-3 h-3" /> Brew (Flow: {machineStatus.flow_rate.toFixed(1)} ml/s)
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col">
                  <span className="text-xs text-gray-500">Boiler Temp</span>
                  <span className="font-medium">{machineStatus.brew_boiler_temperature.toFixed(1)}°C</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-xs text-gray-500">Boiler Pressure</span>
                  <span className="font-medium">{machineStatus.brew_boiler_pressure.toFixed(1)} bar</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-xs text-gray-500">萃取时间</span>
                  <span className="font-medium">{extractionTime}s</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-xs text-gray-500">Weight</span>
                  <span className="font-medium">{machineStatus.liquid_weight.toFixed(1)} g</span>
                </div>
              </div>
            </div>

            {/* Steam Section */}
            <div className={`col-span-2 p-2 rounded border ${isAlarmActive
              ? 'bg-red-100 border-red-300 animate-pulse'
              : 'bg-blue-50 border-blue-100'
              }`}>
              <div className={`font-semibold mb-2 flex items-center gap-1 ${isAlarmActive ? 'text-red-800' : 'text-blue-800'
                }`}>
                <Gauge className="w-3 h-3" /> Steam ({machineStatus.steam_run_status ? 'Running' : 'Stopped'})
                {isAlarmActive && (
                  <span className="ml-auto flex items-center gap-1 text-xs bg-red-600 text-white px-2 py-1 rounded">
                    <AlertCircle className="w-3 h-3" />
                    压力报警!
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col">
                  <span className="text-xs text-gray-500">Boiler Temp</span>
                  <span className="font-medium">{machineStatus.steam_boiler_temperature.toFixed(1)}°C</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-xs text-gray-500">Pressure</span>
                  <span className={`font-medium ${isAlarmActive ? 'text-red-700 font-bold' : ''
                    }`}>{machineStatus.steam_boiler_pressure.toFixed(1)} bar</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-xs text-gray-500">Water Level</span>
                  <span className="font-medium">{machineStatus.steam_boiler_water_level}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-xs text-gray-500">Milk Temp</span>
                  <span className="font-medium">{machineStatus.steam_milk_temperature.toFixed(1)}°C</span>
                </div>
              </div>
            </div>

            {/* Status Flags */}
            <div className="col-span-2 grid grid-cols-2 gap-2 text-xs">
              <div className={`p-1 rounded text-center border ${machineStatus.tray_postion_state ? 'bg-green-100 border-green-200 text-green-700' : 'bg-red-50 border-red-100 text-red-600'}`}>
                蓄水盘: {machineStatus.tray_postion_state ? 'In Place' : 'Missing'}
              </div>
              <div className={`p-1 rounded text-center border ${machineStatus.brew_handle_postion_state ? 'bg-green-100 border-green-200 text-green-700' : 'bg-red-50 border-red-100 text-red-600'}`}>
                手柄: {machineStatus.brew_handle_postion_state ? 'In Place' : 'Missing'}
              </div>
              <div className={`p-1 rounded text-center border ${machineStatus.tray_high_level_state ? 'bg-blue-100 border-blue-200 text-blue-700' : 'bg-gray-100 border-gray-200 text-gray-600'}`}>
                高水位: {machineStatus.tray_high_level_state ? 'Yes' : 'No'}
              </div>
              <div className={`p-1 rounded text-center border ${machineStatus.error_code !== 0 ? 'bg-red-100 border-red-200 text-red-700 font-bold' : 'bg-gray-50 border-gray-200 text-gray-500'}`}>
                错误代码: {machineStatus.error_code}
              </div>
            </div>

          </div>
        </div>
      )}

      {/* 数据发送区 */}
      <div className="p-4 bg-white border-b border-gray-200 flex-shrink-0">
        <h3 className="font-semibold mb-3">数据发送</h3>
        <div className="flex gap-2">
          <input
            type="text"
            value={sendData}
            onChange={(e) => setSendData(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="输入要发送的数据..."
            disabled={!isConnected}
            className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
          />
          <button
            onClick={handleSend}
            disabled={!isConnected}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed flex items-center gap-2"
          >
            <Send className="w-4 h-4" />
            发送1
          </button>
        </div>
        <div className="mt-3 flex gap-2">
          <input
            type="text"
            value={sendDataSticky}
            onChange={(e) => setSendDataSticky(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSendSticky()}
            placeholder="保留发送内容（发送后不清空）..."
            disabled={!isConnected}
            className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
          />
          <button
            onClick={handleSendSticky}
            disabled={!isConnected}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-md transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed flex items-center gap-2"
          >
            <Send className="w-4 h-4" />
            发送2
          </button>
        </div>
      </div>
    </div>
  );
}
