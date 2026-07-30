// CRC16-XMODEM (ITU-T V.41): polynomial 0x1021, initial value 0x0000, no
// reflection, no final XOR. Used by the 4-way interface frames and the AM32
// bootloader protocol. Table-driven for throughput on flash verify paths.
// Provenance: public standard; see docs/ESC-PROTOCOL-SOURCES.md.

const CRC16_XMODEM_TABLE: Uint16Array = (() => {
  const table = new Uint16Array(256)
  for (let i = 0; i < 256; i++) {
    let crc = i << 8
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
    table[i] = crc
  }
  return table
})()

/**
 * Compute CRC16-XMODEM over `data`. Pass a previous return value as `seed`
 * to continue an incremental computation across chunks.
 */
export function crc16Xmodem(data: Uint8Array, seed = 0x0000): number {
  let crc = seed & 0xffff
  for (let i = 0; i < data.length; i++) {
    crc = ((crc << 8) & 0xffff) ^ CRC16_XMODEM_TABLE[((crc >> 8) ^ data[i]) & 0xff]
  }
  return crc & 0xffff
}
