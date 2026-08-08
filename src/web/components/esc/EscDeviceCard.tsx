import { useTranslation } from 'react-i18next'
import type { EscDeviceInfo, EscFirmwareKind } from '../../../shared/esc'
import Icon from '../ui/Icon'

const FIRMWARE_LABELS: Record<EscFirmwareKind, string> = {
  am32: 'AM32',
  blheli_s: 'BLHeli_S',
  bluejay: 'Bluejay',
  unknown: 'escDevice.firmwareUnknown',
}

const REASON_LABELS: Record<string, string> = {
  unsupported_signature_or_layout: 'escDevice.reasonUnsupportedLayout',
  not_validated: 'escDevice.reasonNotValidated',
  detect_failed: 'escDevice.reasonDetectFailed',
}

function formatSignature(signature: number | null): string {
  if (signature === null) return '—'
  return `0x${signature.toString(16).toUpperCase().padStart(4, '0')}`
}

/** Read-only identity card for a single detected ESC. */
export default function EscDeviceCard({ esc }: { esc: EscDeviceInfo }) {
  const { t } = useTranslation()
  const rows: Array<{ label: string; value: string }> = [
    { label: t('escDevice.firmware'), value: t(FIRMWARE_LABELS[esc.firmwareKind]) },
    { label: t('escDevice.firmwareName'), value: esc.firmwareName ?? '-' },
    { label: t('escDevice.firmwareVersion'), value: esc.firmwareVersion ?? '-' },
    { label: t('escDevice.mcu'), value: esc.mcuName ?? formatSignature(esc.mcuSignature) },
    { label: t('escDevice.bootloader'), value: esc.bootloaderVersion ?? '-' },
  ]

  return (
    <section className="mc-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ color: 'var(--accent)' }}><Icon name="motor" size={22} /></span>
        <div>
          <div className="mc-eyebrow">{t('escDevice.escNumber', { index: esc.index + 1 })}</div>
          <strong>{t(FIRMWARE_LABELS[esc.firmwareKind])}</strong>
        </div>
      </div>
      <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', margin: 0 }}>
        {rows.map((row) => (
          <div key={row.label} style={{ display: 'contents' }}>
            <dt style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{row.label}</dt>
            <dd className="mc-mono" style={{ margin: 0, fontSize: 12, textAlign: 'right' }}>{row.value}</dd>
          </div>
        ))}
      </dl>
      {!esc.writable && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            color: 'var(--warning)',
          }}
        >
          <Icon name="warning" size={14} />
          <span>{esc.reason ? t(REASON_LABELS[esc.reason] ?? 'escDevice.readonly') : t('escDevice.readonly')}</span>
        </div>
      )}
    </section>
  )
}
