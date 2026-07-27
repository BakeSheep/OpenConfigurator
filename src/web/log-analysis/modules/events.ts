import type { AnalysisModule, AnalysisContext, ResolvedSample, ModuleResult } from '../engine/AnalysisModule.js'

// ─── State ──────────────────────────────────────────────────────────────────

interface EventsState {
  /** Total events observed via structured event topic (if subscribed) */
  structuredEventCount: number
}

// ─── Result ─────────────────────────────────────────────────────────────────

interface EventsResult {
  /**
   * The events module does not own the full event list — that lives on
   * UlogDocument.events and is surfaced by the worker via
   * `dataset.events`.  The module result is intentionally minimal:
   * it only reports structured-event topic consumption.
   */
  structuredEventCount: number
  /** First page of events is available via the dataset; total count too */
  pagedEvents: {
    page: number
    pageSize: number
    totalCount: number
    events: never[]
  }
}

// ─── Constants ──────────────────────────────────────────────────────────────

const PAGE_SIZE = 100

// ─── Module ─────────────────────────────────────────────────────────────────

export const eventsModule: AnalysisModule<EventsState, EventsResult> = {
  id: 'events',
  section: 'events-raw',
  requirements: [
    {
      aliases: ['event'],
      required: false,
      bindAs: 'structuredEvents',
    },
  ],

  create(_context: AnalysisContext): EventsState {
    return { structuredEventCount: 0 }
  },

  consume(state: EventsState, _sample: ResolvedSample, bindName: string): void {
    if (bindName === 'structuredEvents') {
      state.structuredEventCount++
    }
  },

  finalize(state: EventsState, _context: AnalysisContext): ModuleResult<EventsState, EventsResult> {
    return {
      chartSeries: [],
      metrics: {
        structuredEventCount: state.structuredEventCount,
        eventPageSize: PAGE_SIZE,
      },
      findings: [],
      consumedTopics: [],
      missingRequirements: [],
      warnings: [],
      result: {
        structuredEventCount: state.structuredEventCount,
        pagedEvents: {
          page: 0,
          pageSize: PAGE_SIZE,
          totalCount: 0,
          events: [],
        },
      },
    }
  },
}
