import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { vehicleCapabilities } from '../../shared/vehicleProfiles'
import {
  pidGroups,
  type ParameterFieldDefinition,
  type ParameterGroupDefinition,
} from '../utils/parameterProfiles'
import Icon from '../components/ui/Icon'
import { Button } from '../components/ui/Button'
import { Badge } from '../components/ui/Feedback'
import { EmptyState } from '../components/ui/PageFrame'
import Toolbar from '../components/ui/Toolbar'
import { sendClientMessage } from '../hooks/useWebSocket'
import { useConnectionStore } from '../stores/connectionStore'
import { useParameterStore } from '../stores/parameterStore'
import { useTelemetryStore } from '../stores/telemetryStore'
import {
  formatParameterValue,
  parameterValuesEqual,
  roundParameterValue,
  sanitizeParameterFloat,
  shouldReleaseParameterDraft,
} from '../utils/parameterDisplay'

type PidDefinition = ParameterFieldDefinition
type PidGroup = ParameterGroupDefinition

const pidLikePattern = /(?:RATE_[PID]$|_(?:P|I|D)$|ATC_RAT_)/

function formatValue(value: number, step: number) {
  return formatParameterValue(value, step)
}

function valuesEqual(left: number, right: number, step: number) {
  return parameterValuesEqual(left, right, step)
}

// Toggle the scroll-fade hints of a card viewport straight on the DOM: this
// fires on every scroll frame and must not re-render the page.
function updateFades(element: HTMLDivElement | null) {
  if (!element?.parentElement) return
  const viewport = element.parentElement
  viewport.dataset.fadeTop = element.scrollTop > 2 ? 'true' : 'false'
  viewport.dataset.fadeBottom = element.scrollTop + element.clientHeight < element.scrollHeight - 2 ? 'true' : 'false'
}

export default function PidTuningPage() {
  const { t, i18n } = useTranslation()
  const params = useParameterStore((state) => state.params)
  const loading = useParameterStore((state) => state.loading)
  const lastWriteResult = useParameterStore((state) => state.lastWriteResult)
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)
  const hasControl = useConnectionStore((state) => state.canControl)
  const connectedAndControllable = vehicleReady && hasControl
  const armed = useTelemetryStore((state) => state.status?.armed)
  const vehicleIdentity = useTelemetryStore((state) => state.vehicleIdentity)
  const pidWritable = vehicleCapabilities(vehicleIdentity).pidConfig
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({})
  const [pending, setPending] = useState<{
    requestId: string
    id: string
    value: number
    step: number
  } | null>(null)
  const [awaitingEcho, setAwaitingEcho] = useState<{
    id: string
    value: number
    step: number
  } | null>(null)
  const [feedback, setFeedback] = useState<{ id: string; kind: 'success' | 'error' } | null>(null)
  const timeoutRef = useRef<number | null>(null)
  const feedbackTimerRef = useRef<number | null>(null)
  // PID writes are capability-gated: an unadapted profile keeps the page
  // read-only instead of writing PX4 gains to a different stack.
  const canWrite = connectedAndControllable && armed === false && pidWritable

  // Card-corner result badge: success/error only, auto-dismissed shortly after.
  const flashFeedback = (id: string, kind: 'success' | 'error') => {
    if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current)
    setFeedback({ id, kind })
    feedbackTimerRef.current = window.setTimeout(() => setFeedback(null), 3500)
  }

  useEffect(() => {
    if (!pending || !lastWriteResult || lastWriteResult.requestId !== pending.requestId) return
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current)
    timeoutRef.current = null
    flashFeedback(pending.id, lastWriteResult.accepted ? 'success' : 'error')
    if (lastWriteResult.accepted) {
      setAwaitingEcho({
        id: pending.id,
        value: lastWriteResult.acceptedValue ?? pending.value,
        step: pending.step,
      })
    } else {
      setAwaitingEcho(null)
      setPending(null)
    }
  }, [lastWriteResult, pending])

  useEffect(() => {
    if (!awaitingEcho) return
    const echoed = params.get(awaitingEcho.id)
    if (!echoed || !parameterValuesEqual(echoed.value, awaitingEcho.value, awaitingEcho.step)) return
    setDrafts((current) => {
      if (!shouldReleaseParameterDraft(
        current[awaitingEcho.id],
        echoed.value,
        awaitingEcho.value,
        awaitingEcho.step,
      )) return current
      const next = { ...current }
      delete next[awaitingEcho.id]
      return next
    })
    setPending((current) => current?.id === awaitingEcho.id ? null : current)
    setAwaitingEcho(null)
  }, [awaitingEcho, params])

  useEffect(() => () => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current)
    if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current)
  }, [])

  // PID definitions follow the selected vehicle profile so ArduPilot gains
  // keep ArduPilot naming and are never renamed to PX4 semantics.
  const profileGroups = useMemo(() => pidGroups(vehicleIdentity), [vehicleIdentity, i18n.language])
  const knownIds = useMemo(
    () => new Set(profileGroups.flatMap((group) => group.params.map((field) => field.id))),
    [profileGroups],
  )
  const groupOfParam = useMemo(
    () => new Map(profileGroups.flatMap((group) => group.params.map((field) => [field.id, group.id] as const))),
    [profileGroups],
  )
  // Hide a whole group only when none of its parameters are present; keep
  // groups that have at least one field, marking absent fields unavailable.
  const availableGroups = useMemo(() => profileGroups
    .map((group) => ({ ...group, present: group.params.filter((field) => params.has(field.id)).length }))
    .filter((group) => group.present > 0), [profileGroups, params])

  const otherPidParams = useMemo(() => Array.from(params.values())
    .filter((param) => !knownIds.has(param.id) && pidLikePattern.test(param.id))
    .sort((a, b) => a.id.localeCompare(b.id)), [params])

  const requestParams = () => {
    if (!connectedAndControllable || loading) return
    useParameterStore.getState().clear()
    useParameterStore.getState().setLoading(true)
    sendClientMessage({ type: 'param_request_list' })
  }

  const commit = (definition: PidDefinition, value: number) => {
    const param = params.get(definition.id)
    if (!param || !canWrite || pending) return
    if (!Number.isFinite(value)) {
      setValidationErrors((current) => ({ ...current, [definition.id]: t('pidTuning.invalidInput') }))
      return
    }
    setValidationErrors((current) => {
      const next = { ...current }
      delete next[definition.id]
      return next
    })
    const boundedValue = roundParameterValue(Math.min(definition.max, Math.max(definition.min, value)), definition.step)
    if (valuesEqual(boundedValue, param.value, definition.step)) {
      setDrafts((current) => {
        const next = { ...current }
        delete next[definition.id]
        return next
      })
      return
    }
    const requestId = `pid-${definition.id}-${Date.now().toString(36)}`
    setFeedback(null)
    setAwaitingEcho(null)
    setPending({ requestId, id: definition.id, value: boundedValue, step: definition.step })
    setDrafts((current) => ({ ...current, [definition.id]: formatValue(boundedValue, definition.step) }))
    useParameterStore.getState().setWriteResult(null)
    const sent = sendClientMessage({
      type: 'param_set',
      requestId,
      data: { id: definition.id, value: boundedValue, paramType: param.type },
    })
    if (!sent) {
      setPending(null)
      flashFeedback(definition.id, 'error')
      return
    }
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current)
    timeoutRef.current = window.setTimeout(() => {
      setPending((current) => {
        if (current?.requestId === requestId) {
          setDrafts((draft) => {
            const next = { ...draft }
            delete next[definition.id]
            return next
          })
          flashFeedback(definition.id, 'error')
          return null
        }
        return current
      })
    }, 5000)
  }

  const nudge = (definition: PidDefinition, direction: 1 | -1) => {
    const param = params.get(definition.id)
    if (!param) return
    const draft = drafts[definition.id]
    const base = draft !== undefined && Number.isFinite(Number(draft)) ? Number(draft) : sanitizeParameterFloat(param.value)
    commit(definition, roundParameterValue(base + direction * definition.step, definition.step))
  }

  const totalCount = availableGroups.reduce((count, group) => count + group.present, 0)
  const writeStatus = !vehicleReady
    ? t('pidTuning.writeUnavailableNotReady')
    : !hasControl
      ? t('pidTuning.writeUnavailableNoControl')
      : !pidWritable
        ? t('pidTuning.writeUnavailableUnsupported')
        : armed === true
          ? t('pidTuning.writeDisabledArmed')
          : armed !== false
            ? t('pidTuning.writeDisabledArmUnknown')
            : t('pidTuning.writeEnabled')

  return (
    <div className="mc-pid-page mc-fade-in">
      <Toolbar
        summary={
          <>
            <Badge tone={canWrite ? 'success' : 'warning'}>
              {writeStatus}
            </Badge>
            <span>{totalCount}{t('pidTuning.tunableParamsLabel')}</span>
          </>
        }
      >
        <Button
          tone="secondary"
          leadingIcon={<Icon name="refresh" size={14} />}
          onClick={requestParams}
          disabled={!connectedAndControllable || loading}
        >
          {loading ? t('pidTuning.syncing') : t('pidTuning.resync')}
        </Button>
      </Toolbar>

      {params.size === 0 && !loading ? (
        <EmptyState icon="parameters" description={t('pidTuning.emptyConnect')} />
      ) : profileGroups.length === 0 && !loading ? (
        <EmptyState icon="parameters" description={t('pidTuning.emptyNotAdapted')} />
      ) : availableGroups.length === 0 && !loading ? (
        <EmptyState icon="parameters" description={t('pidTuning.emptyNoParams')} />
      ) : (
        <div className="mc-pid-grid">
          {availableGroups.map((group) => {
            const groupFeedback = feedback && groupOfParam.get(feedback.id) === group.id ? feedback : null
            return (
              <section key={group.id} className="mc-card mc-pid-group">
                <header>
                  <h3 id={`pid-group-${group.id}`}>{group.title}</h3>
                  {groupFeedback && (
                    <i
                      className="mc-pid-group__result"
                      data-kind={groupFeedback.kind}
                      title={groupFeedback.kind === 'success' ? t('pidTuning.writeSuccess') : t('pidTuning.writeFailed')}
                    >
                      <Icon name={groupFeedback.kind === 'success' ? 'check' : 'warning'} size={11} strokeWidth={2.4} />
                    </i>
                  )}
                  <span className="mc-mono">{group.present}</span>
                </header>
                <div className="mc-pid-viewport" data-fade-top="false" data-fade-bottom="false">
                  <div
                    className="mc-pid-scroll"
                    ref={updateFades}
                    role="region"
                    aria-labelledby={`pid-group-${group.id}`}
                    tabIndex={0}
                    onScroll={(event) => updateFades(event.currentTarget)}
                  >
                    {group.params.map((definition) => {
                      const param = params.get(definition.id)
                      if (!param) {
                        // Show an individual missing field as unavailable
                        // rather than hiding it silently.
                        return (
                          <div key={definition.id} className="mc-pid-item" data-missing>
                            <div className="mc-pid-item__top">
                              <label title={`${definition.id} — ${definition.hint}`}>
                                {definition.label}
                                {definition.unit && <small>{definition.unit}</small>}
                              </label>
                              <span className="mc-mono" style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{t('pidTuning.notProvided')}</span>
                            </div>
                          </div>
                        )
                      }
                      const draft = drafts[definition.id]
                      const displayValue = draft ?? formatValue(param.value, definition.step)
                      const numericDraft = Number(displayValue)
                      const sliderValue = Number.isFinite(numericDraft) ? numericDraft : sanitizeParameterFloat(param.value)
                      const progress = Math.min(100, Math.max(0, (sliderValue - definition.min) / (definition.max - definition.min) * 100))
                      const isPending = pending?.id === definition.id
                      const writeLocked = pending !== null && !isPending
                      const isDirty = draft !== undefined && !isPending
                      return (
                        <div
                          key={definition.id}
                          className="mc-pid-item"
                          data-pending={isPending || undefined}
                          data-write-locked={writeLocked || undefined}
                          data-error={validationErrors[definition.id] ? true : undefined}
                        >
                          <div className="mc-pid-item__top">
                            <label htmlFor={`pid-${definition.id}`} title={`${definition.id} — ${definition.hint}`}>
                              {definition.label}
                              {definition.unit && <small>{definition.unit}</small>}
                            </label>
                            <div className="mc-pid-stepper" data-dirty={isDirty || undefined}>
                              <button
                                type="button"
                                aria-label={t('pidTuning.decreaseAria', { label: definition.label })}
                                disabled={!canWrite || pending !== null}
                                onClick={() => nudge(definition, -1)}
                              >−</button>
                              <input
                                id={`pid-${definition.id}`}
                                type="text"
                                inputMode="decimal"
                                className="mc-mono"
                                value={displayValue}
                                disabled={!canWrite || (pending !== null && !isPending)}
                                onChange={(event) => {
                                  const value = event.target.value
                                  setDrafts((current) => ({ ...current, [definition.id]: value }))
                                  setValidationErrors((current) => {
                                    if (!current[definition.id]) return current
                                    const next = { ...current }
                                    delete next[definition.id]
                                    return next
                                  })
                                }}
                                onBlur={(event) => {
                                  if (isPending) return
                                  const raw = event.target.value.trim()
                                  commit(definition, raw === '' ? Number.NaN : Number(raw))
                                }}
                                onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
                              />
                              <button
                                type="button"
                                aria-label={t('pidTuning.increaseAria', { label: definition.label })}
                                disabled={!canWrite || pending !== null}
                                onClick={() => nudge(definition, 1)}
                              >+</button>
                            </div>
                          </div>
                          {validationErrors[definition.id] && <small role="alert">{validationErrors[definition.id]}</small>}
                          <input
                            type="range"
                            className="mc-pid-item__slider"
                            min={definition.min}
                            max={definition.max}
                            step={definition.step}
                            value={sliderValue}
                            disabled={!canWrite || pending !== null}
                            aria-label={t('pidTuning.sliderAria', { group: group.title, label: definition.label })}
                            style={{ '--pid-progress': `${progress}%` } as CSSProperties}
                            onChange={(event) => setDrafts((current) => ({ ...current, [definition.id]: event.target.value }))}
                            onPointerUp={(event) => commit(definition, Number(event.currentTarget.value))}
                            onKeyUp={(event) => commit(definition, Number(event.currentTarget.value))}
                          />
                        </div>
                      )
                    })}
                  </div>
                </div>
              </section>
            )
          })}
        </div>
      )}

      {otherPidParams.length > 0 && (
        <details className="mc-card mc-pid-other">
          <summary>{t('pidTuning.otherPidParams', { count: otherPidParams.length })} <span>{t('pidTuning.otherPidParamsHint')}</span></summary>
          <div>{otherPidParams.map((param) => <span key={param.id}><code>{param.id}</code><b>{formatParameterValue(param.value)}</b></span>)}</div>
        </details>
      )}
    </div>
  )
}
