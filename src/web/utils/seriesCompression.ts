// Bounded time-series collectors shared by the log-analysis workers (ULog and
// DataFlash). A raw series compacts itself once it grows past the trigger,
// keeping worker memory bounded on multi-hour high-rate topics instead of
// accumulating millions of samples. Min/max downsampling preserves spikes;
// the target stays well above the final render resolution so repeated
// compaction barely affects the output.
import {
  EnvelopeCollector,
  downsampleMinMax,
  type SeriesData,
} from './ulogAnalysis'

export const MAX_SERIES_POINTS = 4000

const RAW_COMPACT_TRIGGER = MAX_SERIES_POINTS * 8
const RAW_COMPACT_TARGET = MAX_SERIES_POINTS * 2

export interface RawSeries {
  label: string
  times: number[]
  values: number[]
}

export function makeRaw(label: string): RawSeries {
  return { label, times: [], values: [] }
}

export function pushRaw(series: RawSeries, timeSec: number, value: number): void {
  if (!Number.isFinite(value)) return
  series.times.push(timeSec)
  series.values.push(value)
  if (series.times.length >= RAW_COMPACT_TRIGGER) {
    const compacted = downsampleMinMax(series.times, series.values, RAW_COMPACT_TARGET)
    series.times = compacted.times
    series.values = compacted.values
  }
}

export function finishRaw(series: RawSeries): SeriesData {
  const { times, values } = downsampleMinMax(series.times, series.values, MAX_SERIES_POINTS)
  return { label: series.label, times, values }
}

export function finishEnvelope(label: string, collector: EnvelopeCollector): SeriesData {
  const { times, values } = collector.finish()
  const bounded = downsampleMinMax(times, values, MAX_SERIES_POINTS)
  return { label, times: bounded.times, values: bounded.values }
}
