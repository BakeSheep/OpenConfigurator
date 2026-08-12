import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RcChannelsData } from '../../shared/types'
import { vehicleCapabilities } from '../../shared/vehicleProfiles'
import { setupRequestId, SetupNotice } from '../components/setup/SetupControls'
import ChannelBars from '../components/telemetry/ChannelBars'
import { Button } from '../components/ui/Button'
import ConfirmDialog from '../components/ui/ConfirmDialog'
import Field from '../components/ui/Field'
import { Notice } from '../components/ui/Feedback'
import { PageHeader, PageTabs } from '../components/ui/PageFrame'
import { TabPanel } from '../components/ui/Tabs'
import { sendClientMessage } from '../hooks/useWebSocket'
import { useQueryTab } from '../hooks/useQueryTab'
import { useConnectionStore } from '../stores/connectionStore'
import { useParameterStore } from '../stores/parameterStore'
import { useTelemetryStore } from '../stores/telemetryStore'
import { useVehicleSetupStore } from '../stores/vehicleSetupStore'
import FlightModeSetupPage from './FlightModeSetupPage'

const RECEIVER_TABS = ['calibration', 'flight-modes'] as const

interface RadioCommitment {
  epoch: number
  authorityId: string
  transmitterMode: 1 | 2 | 3 | 4
}

function rcValue(data: RcChannelsData | null, channel: number): number | null {
  const value = data?.[`ch${channel}` as keyof RcChannelsData]
  return typeof value === 'number' ? value : null
}

export default function ReceiverPage({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useQueryTab(RECEIVER_TABS, 'calibration')
  const rcChannels = useTelemetryStore((state) => state.rcChannels)
  const identity = useTelemetryStore((state) => state.vehicleIdentity)
  const armed = useTelemetryStore((state) => state.status?.armed)
  const vehicleReady = useConnectionStore((state) => state.vehicleReady)
  const canControl = useConnectionStore((state) => state.canControl)
  const clientId = useConnectionStore((state) => state.clientId)
  const safetyEpoch = useConnectionStore((state) => state.safetyEpoch)
  const safetyAuthorityId = useConnectionStore((state) => state.safetyAuthorityId)
  const params = useParameterStore((state) => state.params)
  const snapshot = useVehicleSetupStore((state) => state.radioSnapshot)
  const [transmitterMode, setTransmitterMode] = useState<1 | 2 | 3 | 4>(2)
  const [commitment, setCommitment] = useState<RadioCommitment | null>(null)
  const [contextError, setContextError] = useState<string | null>(null)
  const caps = vehicleCapabilities(identity)
  const sessionActive = Boolean(snapshot && !['done', 'failed', 'cancelled'].includes(snapshot.phase))
  const isOwner = Boolean(snapshot && snapshot.ownerClientId === clientId)
  const rssi = rcChannels?.rssi ?? null

  const mappedFunctions = useMemo(() => {
    const result = new Map<number, string>()
    const names = identity?.family === 'px4'
      ? { roll: 'RC_MAP_ROLL', pitch: 'RC_MAP_PITCH', throttle: 'RC_MAP_THROTTLE', yaw: 'RC_MAP_YAW' }
      : { roll: 'RCMAP_ROLL', pitch: 'RCMAP_PITCH', throttle: 'RCMAP_THROTTLE', yaw: 'RCMAP_YAW' }
    for (const [name, id] of Object.entries(names)) {
      const channel = Math.round(params.get(id)?.value ?? 0)
      if (channel > 0) result.set(channel, name)
    }
    snapshot?.channels.forEach((channel) => {
      if (channel.function && channel.function !== 'aux') result.set(channel.channel, channel.function)
    })
    return result
  }, [identity, params, snapshot])

  const channelLabels = Array.from({ length: 18 }, (_, index) => (
    mappedFunctions.has(index + 1)
      ? t(`receiver.channel.${mappedFunctions.get(index + 1)}`)
      : t('receiver.channel.aux', { index: index + 1 })
  ))
  const secondaryLabels = Array.from({ length: 18 }, (_, index) => {
    const calibration = snapshot?.channels[index]
    return calibration
      ? `CH${index + 1} · ${calibration.min}/${calibration.trim}/${calibration.max}`
      : `CH${index + 1}`
  })
  const canStart = vehicleReady
    && canControl
    && armed === false
    && caps.radioCalibration
    && Boolean(rcChannels)
    && !sessionActive
    && safetyAuthorityId !== null

  const openStartConfirmation = () => {
    const connection = useConnectionStore.getState()
    if (!canStart || connection.safetyAuthorityId === null) return
    setContextError(null)
    setCommitment({
      epoch: connection.safetyEpoch,
      authorityId: connection.safetyAuthorityId,
      transmitterMode,
    })
  }
  const start = () => {
    const confirmed = commitment
    const connection = useConnectionStore.getState()
    const liveArmed = useTelemetryStore.getState().status?.armed
    if (
      !confirmed
      || !connection.vehicleReady
      || !connection.canControl
      || liveArmed !== false
      || connection.safetyAuthorityId !== confirmed.authorityId
      || connection.safetyEpoch !== confirmed.epoch
      || confirmed.transmitterMode !== transmitterMode
    ) {
      setCommitment(null)
      setContextError(t('vehicleSetup.safetyContextChanged'))
      return
    }
    sendClientMessage({
      type: 'radio_calibration_start',
      requestId: setupRequestId('radio-start'),
      data: { transmitterMode: confirmed.transmitterMode },
      expectedSafetyEpoch: confirmed.epoch,
      expectedSafetyAuthorityId: confirmed.authorityId,
    })
    setCommitment(null)
  }
  const advance = () => snapshot && sendClientMessage({
    type: 'radio_calibration_advance',
    requestId: setupRequestId('radio-next'),
    data: { sessionId: snapshot.sessionId },
  })
  const cancel = () => snapshot && sendClientMessage({
    type: 'radio_calibration_cancel',
    requestId: setupRequestId('radio-cancel'),
    data: { sessionId: snapshot.sessionId },
  })

  return (
    <div className={embedded ? 'mc-setup-page mc-fade-in' : 'mc-workspace mc-setup-page mc-fade-in'}>
      {!embedded && <PageHeader title={t('common.receiver')} description={t('receiver.description')} />}
      <PageTabs
        tabs={[
          { id: 'calibration', label: t('receiver.calibration') },
          { id: 'flight-modes', label: t('settings.section.flightModes.label') },
        ]}
        active={activeTab}
        onChange={setActiveTab}
        ariaLabel={t('receiver.views')}
        idBase="receiver-tasks"
      />

      <TabPanel idBase="receiver-tasks" tabId={activeTab}>
        {activeTab === 'calibration' && (
          <div className="mc-setup-page mc-receiver-calibration">
            {!caps.radioCalibration && <SetupNotice state="warning">{t('vehicleSetup.readOnlyProfile')}</SetupNotice>}
            {!vehicleReady && <SetupNotice state="waiting">{t('receiver.waitingHint')}</SetupNotice>}
            {armed !== false && vehicleReady && (
              <SetupNotice state="warning">
                {armed ? t('vehicleSetup.disarmRequired') : t('vehicleSetup.armingUnknown')}
              </SetupNotice>
            )}
            {contextError && <SetupNotice state="warning">{contextError}</SetupNotice>}
            {sessionActive && !isOwner && (
              <Notice tone="warning">{t('receiver.calibrationOwnedElsewhere')}</Notice>
            )}

            <section className="mc-card mc-radio-live">
              <header>
                <div>
                  <span className="mc-eyebrow">RC INPUT</span>
                  <h3>{t('receiver.realtimeChannels')}</h3>
                  <p>{t('receiver.pwmRangeHint')}</p>
                </div>
                <div className="mc-radio-live__status" data-connected={vehicleReady && Boolean(rcChannels)}>
                  <i aria-hidden="true" />
                  <strong>{rcChannels ? '18 CH' : '— CH'}</strong>
                  <small>{rssi !== null ? t('receiver.rssi', { rssi }) : t('messages.waiting')}</small>
                </div>
              </header>
              <ChannelBars
                ariaLabel={t('receiver.realtimeChannels')}
                labels={channelLabels}
                secondaryLabels={secondaryLabels}
                values={Array.from({ length: 18 }, (_, index) => rcValue(rcChannels, index + 1))}
                connected={vehicleReady && Boolean(rcChannels)}
              />
            </section>

            <div className="mc-radio-layout">
              <section className="mc-card mc-radio-guide">
                <header>
                  <div>
                    <span className="mc-eyebrow">{t('receiver.calibration')}</span>
                    <h3>{snapshot && sessionActive ? t(`receiver.step.${snapshot.step}`) : t('receiver.calibrationReady')}</h3>
                  </div>
                  <code>{snapshot ? `${snapshot.stepIndex + 1}/${snapshot.stepCount}` : '—/—'}</code>
                </header>
                <div className="mc-radio-sticks" data-mode={transmitterMode} aria-label={t('receiver.transmitterMode', { mode: transmitterMode })}>
                  <div className="mc-radio-stick"><i /><span>{transmitterMode === 1 || transmitterMode === 3 ? t('receiver.pitchYaw') : t('receiver.throttleYaw')}</span></div>
                  <div className="mc-radio-stick"><i /><span>{transmitterMode === 1 || transmitterMode === 3 ? t('receiver.throttleRoll') : t('receiver.pitchRoll')}</span></div>
                </div>
                <p>{snapshot && sessionActive ? t(`receiver.stepHint.${snapshot.step}`) : t('receiver.calibrationIntro')}</p>
                {snapshot?.phase === 'failed' && <SetupNotice state="warning">{snapshot.failureReason ?? snapshot.failureCode}</SetupNotice>}
                {snapshot?.phase === 'done' && <SetupNotice state="detected">{t('receiver.calibrationDone')}</SetupNotice>}
                {snapshot?.phase === 'cancelled' && <SetupNotice state="warning">{t('receiver.calibrationCancelled')}</SetupNotice>}
                <footer>
                  {!sessionActive && (
                    <Field label={t('receiver.transmitterLayout')} controlId="radio-transmitter-mode">
                      <select
                        id="radio-transmitter-mode"
                        className="mc-select"
                        value={transmitterMode}
                        onChange={(event) => setTransmitterMode(Number(event.target.value) as 1 | 2 | 3 | 4)}
                      >
                        {[1, 2, 3, 4].map((mode) => <option key={mode} value={mode}>Mode {mode}</option>)}
                      </select>
                    </Field>
                  )}
                  <div className="mc-radio-guide__actions">
                    {sessionActive && isOwner && (
                      <Button tone="quiet" disabled={snapshot?.phase === 'writing'} onClick={cancel}>{t('common.cancel')}</Button>
                    )}
                    {sessionActive && isOwner
                      ? (
                          <Button tone="primary" disabled={snapshot?.phase === 'writing'} onClick={advance}>
                            {snapshot?.phase === 'review' ? t('receiver.saveCalibration') : t('receiver.nextStep')}
                          </Button>
                        )
                      : (
                          <Button tone="primary" disabled={!canStart} onClick={openStartConfirmation}>
                            {t('receiver.startCalibration')}
                          </Button>
                        )}
                  </div>
                </footer>
              </section>

              <section className="mc-card mc-radio-summary">
                <header><h3>{t('receiver.detectedMapping')}</h3><small>{snapshot?.detectedChannels ?? (rcChannels ? 18 : 0)} CH</small></header>
                <div className="mc-radio-mapping-grid">
                  {(['roll', 'pitch', 'throttle', 'yaw'] as const).map((fn) => (
                    <div key={fn}>
                      <span>{t(`receiver.channel.${fn}`)}</span>
                      <strong>{snapshot?.mapped[fn] ? `CH${snapshot.mapped[fn]}` : '—'}</strong>
                    </div>
                  ))}
                </div>
                <ul>
                  {snapshot?.channels.slice(0, snapshot.detectedChannels).map((channel) => (
                    <li key={channel.channel}>
                      <code>CH{channel.channel}</code>
                      <span>{channel.function ? t(`receiver.channel.${channel.function}`, { defaultValue: channel.function }) : '—'}</span>
                      <small>{channel.min} / {channel.trim} / {channel.max}{channel.reversed ? ` · ${t('receiver.reversed')}` : ''}</small>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          </div>
        )}

        {activeTab === 'flight-modes' && <FlightModeSetupPage />}
      </TabPanel>

      <ConfirmDialog
        open={commitment !== null}
        title={t('receiver.startCalibrationTitle')}
        consequence={t('receiver.startCalibrationConsequence')}
        commitmentLabel={t('receiver.propsRemovedCommitment')}
        confirmLabel={t('receiver.startCalibration')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('common.close')}
        tone="warning"
        confirmationKey={commitment
          ? `${commitment.authorityId}:${commitment.epoch}:${commitment.transmitterMode}:${safetyAuthorityId ?? '-'}:${safetyEpoch}`
          : ''}
        onCancel={() => setCommitment(null)}
        onConfirm={start}
      />
    </div>
  )
}
