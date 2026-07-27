import type { SVGProps } from 'react'

export type IconName =
  | 'dashboard' | 'settings' | 'sensor' | 'parameters' | 'message' | 'route'
  | 'log' | 'waveform' | 'firmware' | 'hardware' | 'rtk' | 'flight'
  | 'gamepad' | 'motor' | 'receiver' | 'plug' | 'home' | 'community'
  | 'shop' | 'sun' | 'moon' | 'external' | 'chevronDown' | 'refresh'
  | 'search' | 'battery' | 'satellite' | 'altitude' | 'check' | 'warning'
  | 'pause' | 'trash' | 'folder' | 'upload' | 'download' | 'grid' | 'list'
  | 'arrowLeft' | 'arrowRight' | 'arrowUp' | 'file' | 'play' | 'close'
  | 'copy' | 'maximize'

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  name: IconName
  size?: number
}

export default function Icon({ name, size = 20, strokeWidth = 1.8, ...props }: IconProps) {
  const shared = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    ...props,
  }

  switch (name) {
    case 'dashboard':
      return <svg {...shared}><rect x="3.5" y="3.5" width="7" height="7" rx="1" /><rect x="13.5" y="3.5" width="7" height="7" rx="1" /><rect x="3.5" y="13.5" width="7" height="7" rx="1" /><rect x="13.5" y="13.5" width="7" height="7" rx="1" /></svg>
    case 'settings':
      return <svg {...shared}><circle cx="12" cy="12" r="3.2" /><path d="M19.4 15a1.8 1.8 0 0 0 .36 2l.06.06-2.12 2.12-.06-.06a1.8 1.8 0 0 0-2-.36 1.8 1.8 0 0 0-1.09 1.65v.09h-3v-.09a1.8 1.8 0 0 0-1.09-1.65 1.8 1.8 0 0 0-2 .36l-.06.06-2.12-2.12.06-.06a1.8 1.8 0 0 0 .36-2 1.8 1.8 0 0 0-1.65-1.09H5v-3h.09A1.8 1.8 0 0 0 6.74 9.8a1.8 1.8 0 0 0-.36-2l-.06-.06 2.12-2.12.06.06a1.8 1.8 0 0 0 2 .36A1.8 1.8 0 0 0 11.59 4.4v-.09h3v.09a1.8 1.8 0 0 0 1.09 1.65 1.8 1.8 0 0 0 2-.36l.06-.06 2.12 2.12-.06.06a1.8 1.8 0 0 0-.36 2 1.8 1.8 0 0 0 1.65 1.09h.09v3h-.09A1.8 1.8 0 0 0 19.4 15Z" /></svg>
    case 'sensor':
      return <svg {...shared}><path d="M12 3v2M12 19v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M3 12h2M19 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /><circle cx="12" cy="12" r="4.2" /><circle cx="12" cy="12" r="1" fill="currentColor" /></svg>
    case 'parameters':
      return <svg {...shared}><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2" fill="var(--bg-secondary)" /><circle cx="15" cy="12" r="2" fill="var(--bg-secondary)" /><circle cx="8" cy="18" r="2" fill="var(--bg-secondary)" /></svg>
    case 'message':
      return <svg {...shared}><path d="M20.5 12a7.7 7.7 0 0 1-8 7.5 9.5 9.5 0 0 1-3.6-.7L4 20l1.2-4A7.3 7.3 0 0 1 4.5 12a7.7 7.7 0 0 1 8-7.5 7.7 7.7 0 0 1 8 7.5Z" /><path d="M8.5 12h.01M12 12h.01M15.5 12h.01" /></svg>
    case 'route':
      return <svg {...shared}><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="6" r="2.5" /><path d="M8.3 17c2.2-.3 5.1-1.5 6.4-4.8.55-1.4.83-2.9.83-4.4" /></svg>
    case 'log':
      return <svg {...shared}><path d="M7 3.5h7l3 3v14H7z" /><path d="M14 3.5v4h4M10 12h4M10 16h4" /></svg>
    case 'waveform':
      return <svg {...shared}><path d="M3 12h3l2.2-7 4.1 14L15.4 9l1.9 3H21" /></svg>
    case 'firmware':
      return <svg {...shared}><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 1.5v3M15 1.5v3M9 19.5v3M15 19.5v3M1.5 9h3M19.5 9h3M1.5 15h3M19.5 15h3M10 10h4v4h-4z" /></svg>
    case 'hardware':
      return <svg {...shared}><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z" /><path d="m4 7.5 8 4.5 8-4.5M12 12v9" /></svg>
    case 'rtk':
      return <svg {...shared}><path d="M12 21V10M8 21h8M10 10h4l1-5h-6zM4 8a8 8 0 0 1 16 0M7 8a5 5 0 0 1 10 0" /></svg>
    case 'flight':
      return <svg {...shared}><path d="m21 3-7.7 18-3-8.3L2 10.3z" /><path d="m10.3 12.7 4.2-4.2" /></svg>
    case 'gamepad':
      return <svg {...shared}><path d="M7 8h10a4 4 0 0 1 3.8 3l1 3.5A3.3 3.3 0 0 1 18.6 19a3.3 3.3 0 0 1-2.4-1l-1.5-1.7h-5.4L7.8 18A3.3 3.3 0 0 1 5.4 19a3.3 3.3 0 0 1-3.2-4.5l1-3.5A4 4 0 0 1 7 8Z" /><path d="M7 12v4M5 14h4M16 13h.01M18.5 15.5h.01" /></svg>
    case 'motor':
      return <svg {...shared}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" /></svg>
    case 'receiver':
      return <svg {...shared}><rect x="3" y="6" width="18" height="12" rx="3" /><path d="M8 12h4M10 10v4M16.5 10.5h.01M18.5 13.5h.01" /></svg>
    case 'plug':
      return <svg {...shared}><path d="M9 2v6M15 2v6M6 8h12l-1.5 6.5a3 3 0 0 1-2.9 2.5H10.4a3 3 0 0 1-2.9-2.5zM12 17v5" /></svg>
    case 'home':
      return <svg {...shared}><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" /></svg>
    case 'community':
      return <svg {...shared}><path d="M7 11a4 4 0 1 1 3.1 3.9L8.4 17H6.7L5 15.3A4 4 0 0 1 7 11ZM17 11a4 4 0 1 1-3.1 3.9l1.7 2.1h1.7l1.7-1.7A4 4 0 0 1 17 11Z" /></svg>
    case 'shop':
      return <svg {...shared}><path d="M4 5h16l-1.4 8.5H6.1zM9 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2ZM17 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" /><path d="M4 5 3 2H1.5" /></svg>
    case 'sun':
      return <svg {...shared}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></svg>
    case 'moon':
      return <svg {...shared}><path d="M20.5 15.1A8.5 8.5 0 0 1 8.9 3.5a8.5 8.5 0 1 0 11.6 11.6Z" /></svg>
    case 'external':
      return <svg {...shared}><path d="M14 3h7v7M21 3l-9 9" /><path d="M11 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" /></svg>
    case 'chevronDown':
      return <svg {...shared}><path d="m6 9 6 6 6-6" /></svg>
    case 'refresh':
      return <svg {...shared}><path d="M20 11a8 8 0 0 0-14.9-4L3 9m-1-5v5h5M4 13a8 8 0 0 0 14.9 4L21 15m1 5v-5h-5" /></svg>
    case 'search':
      return <svg {...shared}><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.4 4.4" /></svg>
    case 'battery':
      return <svg {...shared}><rect x="3" y="7" width="16" height="10" rx="2" /><path d="M21 10v4M6 10h7v4H6z" /></svg>
    case 'satellite':
      return <svg {...shared}><path d="M5 5 8 8M4 11a9 9 0 0 1 9 9M8 8a5.5 5.5 0 0 1 5 5M3 16h.01" /><rect x="12" y="3" width="8" height="8" rx="1" transform="rotate(45 16 7)" /></svg>
    case 'altitude':
      return <svg {...shared}><path d="M12 20V4M7 9l5-5 5 5M4 20h16" /></svg>
    case 'check':
      return <svg {...shared}><path d="m5 12 4.2 4.2L19 6.5" /></svg>
    case 'warning':
      return <svg {...shared}><path d="m12 3 9 16H3z" /><path d="M12 9v4M12 17h.01" /></svg>
    case 'pause':
      return <svg {...shared}><path d="M9 5v14M15 5v14" /></svg>
    case 'trash':
      return <svg {...shared}><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" /></svg>
    case 'folder':
      return <svg {...shared}><path d="M3 6.5h6l2 2h10v10.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M3 9h18" /></svg>
    case 'upload':
      return <svg {...shared}><path d="M12 16V4M7 9l5-5 5 5M4 20h16" /></svg>
    case 'download':
      return <svg {...shared}><path d="M12 4v12M7 11l5 5 5-5M4 20h16" /></svg>
    case 'grid':
      return <svg {...shared}><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></svg>
    case 'list':
      return <svg {...shared}><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" /></svg>
    case 'arrowLeft':
      return <svg {...shared}><path d="M19 12H5M11 6l-6 6 6 6" /></svg>
    case 'arrowRight':
      return <svg {...shared}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
    case 'arrowUp':
      return <svg {...shared}><path d="M12 19V5M6 11l6-6 6 6" /></svg>
    case 'file':
      return <svg {...shared}><path d="M7 3.5h7l3 3v14H7z" /><path d="M14 3.5v4h4" /></svg>
    case 'play':
      return <svg {...shared}><path d="m7 5 12 7-12 7z" /></svg>
    case 'close':
      return <svg {...shared}><path d="m6 6 12 12M18 6 6 18" /></svg>
    case 'copy':
      return <svg {...shared}><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>
    case 'maximize':
      return <svg {...shared}><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" /></svg>
    default:
      return null
  }
}
