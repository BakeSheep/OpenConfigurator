// Pure analysis primitives for ULog flight logs: dataset types, min/max
// downsampling, radix-2 FFT with Welch averaging, quaternion conversion,
// flight segmentation and PX4 log-name timestamp parsing. Framework-agnostic
// so the Web Worker and the node-run unit tests share one implementation.

export interface SeriesData {
  label: string
  /** Seconds since log start. */
  times: number[]
  values: number[]
  /** Stable palette slot used when a UI filters sibling series. */
  colorIndex?: number
}

export interface SegmentInfo {
  startSec: number
  endSec: number
  label: string
}

export interface UlogEvent {
  timeSec: number
  /** ULog log level (0 emerg .. 7 debug). */
  level: number
  message: string
}

export interface UlogParamEntry {
  name: string
  value: number
}

export interface VibrationSpectrum {
  freq: number[]
  /** Averaged amplitude per axis: [x, y, z]. */
  amp: [number[], number[], number[]]
  sampleRateHz: number
  segments: number
}

export interface TrackData {
  timesSec: number[]
  lat: number[]
  lon: number[]
  altM: Array<number | null>
}

export interface UlogOverview {
  durationSec: number
  /** UTC epoch ms of log start, when the log carries a UTC reference. */
  startTimeUtcMs: number | null
  startTimeSource: 'gps' | 'filename' | 'file-modified' | null
  firmware: string | null
  firmwareBranch: string | null
  hardware: string | null
  sysName: string | null
  totalArmedSec: number
  droppedMessages: number
}

export interface ActuatorSaturationInfo {
  /** Percentage (0-100) of samples with any actuator at its upper limit. */
  saturationPct: number
  motorCount: number
}

export interface UlogAnalysisDataset {
  overview: UlogOverview
  modeSegments: SegmentInfo[]
  armedSegments: SegmentInfo[]
  events: UlogEvent[]
  attitude: SeriesData[]
  rates: SeriesData[]
  actuators: SeriesData[]
  actuatorSaturation: ActuatorSaturationInfo | null
  battery: SeriesData[]
  gpsQuality: SeriesData[]
  altitude: SeriesData[]
  velocity: SeriesData[]
  vibration: VibrationSpectrum | null
  rawAcc: SeriesData[]
  params: UlogParamEntry[]
  track: TrackData | null
}

export interface UlogWorkerResult {
  dataset?: UlogAnalysisDataset
  error?: string
}

/** PX4 nav_state values (vehicle_status.nav_state) to display names. */
export const NAV_STATE_NAMES: Record<number, string> = {
  0: 'Manual',
  1: 'Altitude',
  2: 'Position',
  3: 'Mission',
  4: 'Hold',
  5: 'RTL',
  6: 'Slow',
  7: 'Free5',
  8: 'Free4',
  9: 'Free3',
  10: 'Acro',
  11: 'Free2',
  12: 'Descend',
  13: 'Termination',
  14: 'Offboard',
  15: 'Stabilized',
  16: 'Free1',
  17: 'Takeoff',
  18: 'Land',
  19: 'Follow',
  20: 'Precision Land',
  21: 'Orbit',
  22: 'VTOL Takeoff',
}

export const RAD_TO_DEG = 180 / Math.PI

/**
 * Filelike over an in-memory ArrayBuffer that returns COPIES from read().
 * @foxglove/ulog's own DataReader returns zero-copy subarrays whose
 * byteOffset is file-absolute, but ULog.#readParsedMessage treats
 * data.byteOffset as chunk-relative - once the internal chunk no longer
 * starts at offset 0 every parsed value is shifted (or reads out of bounds).
 * Copying restores the chunk-relative invariant the parser relies on.
 */
export class CopyingBufferReader {
  private readonly buffer: ArrayBuffer

  constructor(buffer: ArrayBuffer) {
    this.buffer = buffer
  }

  async open(): Promise<number> {
    return this.buffer.byteLength
  }

  async close(): Promise<void> {
    // no-op
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    return new Uint8Array(this.buffer.slice(offset, offset + length))
  }

  size(): number {
    return this.buffer.byteLength
  }
}

/** Convert a PX4 attitude quaternion [w, x, y, z] to Euler angles (rad). */
export function quaternionToEuler(
  w: number,
  x: number,
  y: number,
  z: number,
): { roll: number; pitch: number; yaw: number } {
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y))
  const sinPitch = 2 * (w * y - z * x)
  const pitch = Math.abs(sinPitch) >= 1
    ? Math.sign(sinPitch) * Math.PI / 2
    : Math.asin(sinPitch)
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
  return { roll, pitch, yaw }
}

/**
 * Min/max bucket downsampling: keeps spikes visible, bounds every rendered
 * series to at most maxPoints. Points are emitted in time order.
 */
export function downsampleMinMax(
  times: number[],
  values: number[],
  maxPoints: number,
): { times: number[]; values: number[] } {
  const length = Math.min(times.length, values.length)
  if (length <= maxPoints || maxPoints < 4) {
    return { times: times.slice(0, length), values: values.slice(0, length) }
  }
  const bucketCount = Math.floor(maxPoints / 2)
  const bucketSize = length / bucketCount
  const outTimes: number[] = []
  const outValues: number[] = []
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const start = Math.floor(bucket * bucketSize)
    const end = Math.min(length, Math.floor((bucket + 1) * bucketSize))
    if (end <= start) continue
    let minIndex = start
    let maxIndex = start
    for (let index = start + 1; index < end; index++) {
      if (values[index] < values[minIndex]) minIndex = index
      if (values[index] > values[maxIndex]) maxIndex = index
    }
    const first = Math.min(minIndex, maxIndex)
    const second = Math.max(minIndex, maxIndex)
    outTimes.push(times[first])
    outValues.push(values[first])
    if (second !== first) {
      outTimes.push(times[second])
      outValues.push(values[second])
    }
  }
  return { times: outTimes, values: outValues }
}

/** In-place iterative radix-2 FFT. Lengths must be a power of two. */
export function fftRadix2(re: Float64Array, im: Float64Array): void {
  const n = re.length
  if (n !== im.length || (n & (n - 1)) !== 0) {
    throw new Error('FFT length must be a power of two')
  }
  // Bit reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr
      const ti = im[i]; im[i] = im[j]; im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = -2 * Math.PI / len
    const wRe = Math.cos(angle)
    const wIm = Math.sin(angle)
    for (let start = 0; start < n; start += len) {
      let curRe = 1
      let curIm = 0
      for (let offset = 0; offset < len / 2; offset++) {
        const even = start + offset
        const odd = even + len / 2
        const tRe = re[odd] * curRe - im[odd] * curIm
        const tIm = re[odd] * curIm + im[odd] * curRe
        re[odd] = re[even] - tRe
        im[odd] = im[even] - tIm
        re[even] += tRe
        im[even] += tIm
        const nextRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nextRe
      }
    }
  }
}

export function hannWindow(size: number): Float64Array {
  const window = new Float64Array(size)
  for (let index = 0; index < size; index++) {
    window[index] = 0.5 * (1 - Math.cos((2 * Math.PI * index) / (size - 1)))
  }
  return window
}

export const VIBRATION_FFT_SIZE = 2048

/**
 * Streaming Welch-style spectrum accumulator for the three accelerometer
 * axes. Bounded memory: only one FFT segment is buffered at a time, so even
 * multi-hundred-MB logs never hold the raw high-rate samples.
 */
export class VibrationAnalyzer {
  private readonly size: number
  private readonly window: Float64Array
  private readonly buffers: [Float64Array, Float64Array, Float64Array]
  private readonly sums: [Float64Array, Float64Array, Float64Array]
  private fill = 0
  private segmentStartSec = 0
  private lastSec = 0
  private segments = 0
  private rateSum = 0

  constructor(size = VIBRATION_FFT_SIZE) {
    this.size = size
    this.window = hannWindow(size)
    this.buffers = [new Float64Array(size), new Float64Array(size), new Float64Array(size)]
    const bins = size / 2
    this.sums = [new Float64Array(bins), new Float64Array(bins), new Float64Array(bins)]
  }

  addSample(timeSec: number, x: number, y: number, z: number): void {
    if (this.fill === 0) this.segmentStartSec = timeSec
    this.buffers[0][this.fill] = x
    this.buffers[1][this.fill] = y
    this.buffers[2][this.fill] = z
    this.lastSec = timeSec
    this.fill++
    if (this.fill < this.size) return
    const duration = this.lastSec - this.segmentStartSec
    this.fill = 0
    if (duration <= 0) return
    const sampleRate = (this.size - 1) / duration
    this.rateSum += sampleRate
    this.segments++
    const im = new Float64Array(this.size)
    for (let axis = 0; axis < 3; axis++) {
      const re = new Float64Array(this.size)
      const buffer = this.buffers[axis]
      // Remove DC (gravity) so low-frequency bins reflect vibration only.
      let mean = 0
      for (let index = 0; index < this.size; index++) mean += buffer[index]
      mean /= this.size
      for (let index = 0; index < this.size; index++) {
        re[index] = (buffer[index] - mean) * this.window[index]
      }
      im.fill(0)
      fftRadix2(re, im)
      const sums = this.sums[axis]
      for (let bin = 0; bin < this.size / 2; bin++) {
        sums[bin] += Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin]) * (2 / this.size)
      }
    }
  }

  result(): VibrationSpectrum | null {
    if (this.segments === 0) return null
    const sampleRateHz = this.rateSum / this.segments
    const bins = this.size / 2
    const freq: number[] = new Array(bins)
    const amp: [number[], number[], number[]] = [
      new Array(bins),
      new Array(bins),
      new Array(bins),
    ]
    for (let bin = 0; bin < bins; bin++) {
      freq[bin] = (bin * sampleRateHz) / this.size
      for (let axis = 0; axis < 3; axis++) {
        amp[axis][bin] = this.sums[axis][bin] / this.segments
      }
    }
    return { freq, amp, sampleRateHz, segments: this.segments }
  }
}

/**
 * Streaming min/max envelope collector bucketed by time. Bounds memory for
 * high-rate topics while preserving spikes for the time-series panels.
 */
export class EnvelopeCollector {
  private readonly bucketSec: number
  readonly times: number[] = []
  readonly values: number[] = []
  private bucketStart = Number.NaN
  private minValue = 0
  private maxValue = 0
  private minTime = 0
  private maxTime = 0

  constructor(bucketSec: number) {
    this.bucketSec = bucketSec
  }

  add(timeSec: number, value: number): void {
    if (!Number.isFinite(value)) return
    if (Number.isNaN(this.bucketStart)) {
      this.bucketStart = timeSec
      this.minValue = this.maxValue = value
      this.minTime = this.maxTime = timeSec
      return
    }
    if (timeSec - this.bucketStart >= this.bucketSec) {
      this.flush()
      this.bucketStart = timeSec
      this.minValue = this.maxValue = value
      this.minTime = this.maxTime = timeSec
      return
    }
    if (value < this.minValue) {
      this.minValue = value
      this.minTime = timeSec
    }
    if (value > this.maxValue) {
      this.maxValue = value
      this.maxTime = timeSec
    }
  }

  private flush(): void {
    if (Number.isNaN(this.bucketStart)) return
    if (this.minTime <= this.maxTime) {
      this.times.push(this.minTime, this.maxTime)
      this.values.push(this.minValue, this.maxValue)
    } else {
      this.times.push(this.maxTime, this.minTime)
      this.values.push(this.maxValue, this.minValue)
    }
  }

  finish(): { times: number[]; values: number[] } {
    this.flush()
    this.bucketStart = Number.NaN
    return { times: this.times, values: this.values }
  }
}

/**
 * Collapse a sampled state signal into labelled segments, merging repeats.
 * Samples must be time-ordered.
 */
export function buildSegments(
  samples: Array<{ timeSec: number; label: string }>,
  endSec: number,
): SegmentInfo[] {
  const segments: SegmentInfo[] = []
  for (const sample of samples) {
    const current = segments[segments.length - 1]
    if (current && current.label === sample.label) continue
    if (current) current.endSec = sample.timeSec
    segments.push({ startSec: sample.timeSec, endSec, label: sample.label })
  }
  return segments
}

/**
 * Percentage of samples whose largest motor output reaches the saturation
 * threshold. Takes the per-sample maximum so the caller can stream without
 * retaining every channel of every sample.
 */
export function computeSaturationPct(perSampleMax: number[]): number {
  if (perSampleMax.length === 0) return 0
  // Heuristic threshold: PWM-style outputs saturate near 2000 us, normalized
  // actuator_motors controls saturate at 1.0.
  let peak = 0
  for (const value of perSampleMax) {
    if (Number.isFinite(value)) peak = Math.max(peak, value)
  }
  const threshold = peak > 500 ? 1950 : 0.98
  let saturated = 0
  for (const value of perSampleMax) {
    if (value >= threshold) saturated++
  }
  return (saturated / perSampleMax.length) * 100
}

// ---------------------------------------------------------------------------
// PX4 log naming -> timestamps for the file explorer's "modified" column.
// PX4 lays logs out as /fs/microsd/log/<YYYY-MM-DD>/<HH_MM_SS>.ulg; sessNNN /
// logNNN fallbacks carry no date at all.
// ---------------------------------------------------------------------------

/** Parse a PX4 date directory name (2026-07-25) to a UTC epoch ms, or null. */
export function parsePx4DirectoryDate(name: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(name)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  // Date.UTC silently normalizes out-of-range values (month 13 -> next year),
  // so reject anything that is not a real calendar date.
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const timestamp = Date.UTC(year, month - 1, day)
  const date = new Date(timestamp)
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return timestamp
}

/**
 * Parse a PX4 log file name to a UTC epoch ms. `HH_MM_SS.ulg` needs the
 * parent date directory; `2026-07-25_10_30_00.ulg` style is self-contained.
 */
export function parsePx4FileDate(name: string, parentDirName?: string): number | null {
  const timeOnly = /^(\d{2})_(\d{2})_(\d{2})(?:\..+)?$/.exec(name)
  if (timeOnly && parentDirName) {
    const base = parsePx4DirectoryDate(parentDirName)
    if (base === null) return null
    const hours = Number(timeOnly[1])
    const minutes = Number(timeOnly[2])
    const seconds = Number(timeOnly[3])
    if (hours > 23 || minutes > 59 || seconds > 59) return null
    return base + hours * 3_600_000 + minutes * 60_000 + seconds * 1000
  }
  const full = /^(\d{4})-(\d{2})-(\d{2})[_T](\d{2})[_-](\d{2})[_-](\d{2})(?:\..+)?$/.exec(name)
  if (full) {
    const datePart = parsePx4DirectoryDate(`${full[1]}-${full[2]}-${full[3]}`)
    if (datePart === null) return null
    const hours = Number(full[4])
    const minutes = Number(full[5])
    const seconds = Number(full[6])
    if (hours > 23 || minutes > 59 || seconds > 59) return null
    return datePart + hours * 3_600_000 + minutes * 60_000 + seconds * 1000
  }
  return null
}

/** Parse the standard PX4 date-directory + log-name combination from a path. */
export function parsePx4LogPathDate(filePath: string): number | null {
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean)
  const name = parts.pop()
  if (!name) return null
  return parsePx4FileDate(name, parts.pop())
}
