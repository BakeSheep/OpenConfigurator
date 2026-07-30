import type { EscDeviceInfo, EscFirmwareKind } from '../../../shared/esc'
import Icon from '../ui/Icon'

const FIRMWARE_LABELS: Record<EscFirmwareKind, string> = {
  am32: 'AM32',
  blheli_s: 'BLHeli_S',
  bluejay: 'Bluejay',
  unknown: '未识别',
}

const REASON_LABELS: Record<string, string> = {
  unsupported_signature_or_layout: '固件签名/布局未识别，仅可只读',
  not_validated: '该组合尚未通过硬件验证，仅可只读',
  detect_failed: 'ESC 未响应（检查供电、信号线与 bootloader）',
}

function formatSignature(signature: number | null): string {
  if (signature === null) return '—'
  return `0x${signature.toString(16).toUpperCase().padStart(4, '0')}`
}

/** Read-only identity card for a single detected ESC. */
export default function EscDeviceCard({ esc }: { esc: EscDeviceInfo }) {
  const rows: Array<{ label: string; value: string }> = [
    { label: '固件', value: FIRMWARE_LABELS[esc.firmwareKind] },
    { label: '固件名称', value: esc.firmwareName ?? '—' },
    { label: '固件版本', value: esc.firmwareVersion ?? '—' },
    { label: 'MCU', value: esc.mcuName ?? formatSignature(esc.mcuSignature) },
    { label: 'Bootloader', value: esc.bootloaderVersion ?? '—' },
  ]

  return (
    <section className="mc-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ color: 'var(--accent)' }}><Icon name="motor" size={22} /></span>
        <div>
          <div className="mc-eyebrow">电调 #{esc.index + 1}</div>
          <strong>{FIRMWARE_LABELS[esc.firmwareKind]}</strong>
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
          <span>{esc.reason ? REASON_LABELS[esc.reason] ?? '仅可只读' : '仅可只读'}</span>
        </div>
      )}
    </section>
  )
}
