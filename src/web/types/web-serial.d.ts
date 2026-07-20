// Web Serial API type declarations (used for both USB and Bluetooth SPP ports)
// Refs: https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API
//
// Note: Web Serial types are included in recent TypeScript DOM lib versions,
// but we declare them here to guarantee availability across TS versions and
// to make intent explicit (this app uses Web Serial, not Web Bluetooth).

interface SerialPortRequestOptions {
  filters?: SerialPortFilter[]
}

interface SerialPortFilter {
  usbVendorId?: number
  usbProductId?: number
  bluetoothServiceClassId?: number | string
}

interface SerialPortInfo {
  usbVendorId?: number
  usbProductId?: number
  bluetoothServiceClassId?: number | string
}

interface SerialPort extends EventTarget {
  open(options: SerialOptions): Promise<void>
  close(): Promise<void>
  readable: ReadableStream<Uint8Array> | null
  writable: WritableStream<Uint8Array> | null
  getInfo(): Promise<SerialPortInfo>
  addEventListener(type: 'connect', listener: (this: SerialPort, ev: Event) => any): void
  addEventListener(type: 'disconnect', listener: (this: SerialPort, ev: Event) => any): void
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void
}

interface SerialOptions {
  baudRate: number
  dataBits?: number
  stopBits?: number
  parity?: 'none' | 'even' | 'odd'
  bufferSize?: number
  flowControl?: 'none' | 'hardware'
}

interface Serial extends EventTarget {
  getPorts(): Promise<SerialPort[]>
  requestPort(options?: SerialPortRequestOptions): Promise<SerialPort>
  addEventListener(type: 'connect', listener: (this: Serial, ev: Event) => any): void
  addEventListener(type: 'disconnect', listener: (this: Serial, ev: Event) => any): void
}

interface Navigator {
  serial?: Serial
}

interface Window {
  Serial?: new () => Serial
}
