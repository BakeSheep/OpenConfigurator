import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { vehicleCapabilities } from '../../../shared/vehicleProfiles'
import { LOCAL_RUNTIME_OWNER_ID } from '../../../shared/localRuntime'
import type { AutotunePhase } from '../../../shared/types'
import { sendRuntimeCommand } from '../../hooks/useLocalRuntime'
import { useAutotuneStore } from '../../stores/autotuneStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { useParameterStore } from '../../stores/parameterStore'
import { useTelemetryStore } from '../../stores/telemetryStore'
import { Button } from '../ui/Button'
import { Card, CardBody, CardFooter, CardHeader } from '../ui/Card'
import { Badge, Notice } from '../ui/Feedback'

const ACTIVE_PHASES = new Set<AutotunePhase>([
  'starting', 'tuning', 'paused', 'verifying', 'applying', 'awaiting_disarm',
  'completed', 'testing', 'save_pending',
])

function isSessionActive(family: 'px4' | 'ardupilot', phase: AutotunePhase): boolean {
  return ACTIVE_PHASES.has(phase) && !(family === 'px4' && phase === 'completed')
}

export default function AutotunePanel() {
  const { t } = useTranslation()
  const snapshot = useAutotuneStore((state) => state.snapshot)
  const resetSnapshot = useAutotuneStore((state) => state.reset)
  const params = useParameterStore((state) => state.params)
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)
  const canControl = useConnectionStore((state) => state.canControl)
  // Single-client local runtime: this tab is always the session owner.
  const clientId = LOCAL_RUNTIME_OWNER_ID
  const safetyEpoch = useConnectionStore((state) => state.safetyEpoch)
  const safetyAuthorityId = useConnectionStore((state) => state.safetyAuthorityId)
  const status = useTelemetryStore((state) => state.status)
  const identity = useTelemetryStore((state) => state.vehicleIdentity)
  const lastOperationError = useTelemetryStore((state) => state.lastOperationError)
  const [confirmed, setConfirmed] = useState(false)
  const [requestId, setRequestId] = useState<string | null>(null)

  const capability = vehicleCapabilities(identity).autotune
  const active = snapshot ? isSessionActive(snapshot.family, snapshot.phase) : false
  const isOwner = Boolean(snapshot && clientId && snapshot.ownerClientId === clientId)
  const supported = capability !== 'none'
  const canStart = vehicleReady && canControl && status?.armed === true
    && supported && confirmed && !active && safetyAuthorityId !== null

  useEffect(() => {
    setConfirmed(false)
  }, [safetyEpoch, safetyAuthorityId, identity?.autopilotId, identity?.vehicleTypeId])

  useEffect(() => {
    if (snapshot?.requestId === requestId) setRequestId(null)
  }, [requestId, snapshot])

  const requestError = requestId && lastOperationError?.requestId === requestId
    ? lastOperationError.message
    : null

  const changes = useMemo(() => {
    if (!snapshot || (snapshot.phase !== 'completed' && snapshot.phase !== 'saved')) return []
    return Object.entries(snapshot.baselineParameters).flatMap(([id, before]) => {
      const after = params.get(id)?.value
      if (after === undefined || Math.abs(after - before) <= Math.max(1e-8, Math.abs(before) * 1e-6)) return []
      return [{ id, before, after }]
    })
  }, [params, snapshot])

  const start = () => {
    if (!canStart || !safetyAuthorityId) return
    const nextRequestId = `autotune-${Date.now().toString(36)}`
    setRequestId(nextRequestId)
    setConfirmed(false)
    if (!sendRuntimeCommand({
      type: 'autotune_start',
      requestId: nextRequestId,
      safetyConfirmation: 'autotune_in_flight',
      expectedSafetyEpoch: safetyEpoch,
      expectedSafetyAuthorityId: safetyAuthorityId,
    })) setRequestId(null)
  }

  const action = (value: 'abort' | 'test_gains' | 'restore_gains') => {
    if (!snapshot || !isOwner) return
    const nextRequestId = `autotune-${value}-${Date.now().toString(36)}`
    setRequestId(nextRequestId)
    if (!sendRuntimeCommand({
      type: 'autotune_action',
      requestId: nextRequestId,
      data: { sessionId: snapshot.sessionId, action: value },
    })) setRequestId(null)
  }

  if (!snapshot) {
    return (
      <div className="space-y-4">
        {!supported && (
          <Notice tone="warning" title={t('pidTuning.autotune.unsupported')}>
            {t('pidTuning.autotune.supportedProfiles')}
          </Notice>
        )}
        <Card density="compact">
          <CardHeader
            title={t('pidTuning.autotune.readyTitle')}
            actions={(
              <div className="flex flex-wrap gap-2">
                <Badge tone="warning">{t('pidTuning.autotune.experimental')}</Badge>
                <Badge tone={status?.armed ? 'warning' : 'neutral'}>{status?.armed ? t('pidTuning.autotune.inFlight') : t('pidTuning.autotune.notInFlight')}</Badge>
              </div>
            )}
          />
          <CardBody className="space-y-4">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 shrink-0"
                style={{ accentColor: 'var(--mc-color-accent-fg)' }}
                checked={confirmed}
                disabled={!vehicleReady || !supported}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>{t('pidTuning.autotune.safetyConfirmation')}</span>
            </label>
            {requestError && <Notice tone="danger">{requestError}</Notice>}
          </CardBody>
          <CardFooter>
            <Button tone="primary" size="default" onClick={start} disabled={!canStart} loading={requestId !== null}>
              {t('pidTuning.autotune.start')}
            </Button>
          </CardFooter>
        </Card>
      </div>
    )
  }

  const phaseLabel = t(`pidTuning.autotune.phase.${snapshot.phase}`)
  const progressLabel = snapshot.progress === null ? null : `${snapshot.progress}%`
  const stateLabel = progressLabel
    ?? (snapshot.axis
      ? t(`pidTuning.autotune.axis.${snapshot.axis}`)
      : snapshot.verification === 'parameters_saved'
        ? t('pidTuning.autotune.parametersSaved')
        : snapshot.verification === 'firmware_completed'
          ? t('pidTuning.autotune.firmwareCompleted')
          : active ? t('pidTuning.autotune.running') : t('pidTuning.autotune.ended'))
  return (
    <div className="space-y-4">
      <Card density="compact">
        <CardHeader
          title={phaseLabel}
          actions={<Badge tone={snapshot.phase === 'saved' || snapshot.phase === 'completed' ? 'success' : snapshot.phase === 'failed' || snapshot.phase === 'interrupted' ? 'danger' : 'info'}>{stateLabel}</Badge>}
        />
        <CardBody className="space-y-4">
          {snapshot.progress !== null && <progress className="w-full" max={100} value={snapshot.progress} aria-label={phaseLabel} />}
          {snapshot.failureReason && <Notice tone="danger">{snapshot.failureReason}</Notice>}
          {snapshot.family === 'px4' && active && !snapshot.cancelSupported && (
            <Notice tone="warning">{t('pidTuning.autotune.px4Exit')}</Notice>
          )}
          {snapshot.family === 'ardupilot' && snapshot.phase === 'completed' && (
            <Notice tone="warning">{t('pidTuning.autotune.completedAction')}</Notice>
          )}
          {snapshot.family === 'ardupilot' && snapshot.phase === 'testing' && (
            <Notice tone="warning">{t('pidTuning.autotune.testingAction')}</Notice>
          )}
          {requestError && <Notice tone="danger">{requestError}</Notice>}
          {changes.length > 0 && (
            <details>
              <summary>{t('pidTuning.autotune.parameterChanges', { count: changes.length })}</summary>
              <dl className="mt-3 grid gap-2">
                {changes.map((change) => (
                  <div key={change.id} className="flex items-center justify-between gap-4">
                    <dt><code>{change.id}</code></dt>
                    <dd className="mc-mono">{change.before} → {change.after}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
        </CardBody>
        {isOwner && snapshot.family === 'ardupilot'
          && ['starting', 'tuning', 'paused', 'completed', 'testing'].includes(snapshot.phase) && (
          <CardFooter className="flex flex-wrap gap-2">
            {(snapshot.phase === 'starting' || snapshot.phase === 'tuning' || snapshot.phase === 'paused') && (
              <Button tone="danger" onClick={() => action('abort')}>{t('pidTuning.autotune.abort')}</Button>
            )}
            {snapshot.phase === 'completed' && (
              <>
                <Button tone="primary" onClick={() => action('test_gains')}>{t('pidTuning.autotune.testGains')}</Button>
                <Button tone="secondary" onClick={() => action('restore_gains')}>{t('pidTuning.autotune.restore')}</Button>
              </>
            )}
            {snapshot.phase === 'testing' && (
              <Button tone="secondary" onClick={() => action('restore_gains')}>{t('pidTuning.autotune.restore')}</Button>
            )}
          </CardFooter>
        )}
        {!active && (
          <CardFooter>
            <Button tone="secondary" onClick={resetSnapshot}>{t('pidTuning.autotune.newRun')}</Button>
          </CardFooter>
        )}
      </Card>
    </div>
  )
}
