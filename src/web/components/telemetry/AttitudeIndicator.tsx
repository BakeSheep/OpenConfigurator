import { useRef, useState, useEffect } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useTelemetryStore } from '../../stores/telemetryStore'
import { useConnectionStore } from '../../stores/connectionStore'

function DroneModel({ frozen }: { frozen: boolean }) {
  const meshRef = useRef<THREE.Group>(null)
  const attitude = useTelemetryStore((s) => s.attitude)

  useFrame(() => {
    // When the link is stale/disconnected, stop updating rotation so the model
    // freezes at the last known attitude instead of misleadingly tracking a
    // frozen value as if it were live.
    if (meshRef.current && attitude && !frozen) {
      meshRef.current.rotation.x = attitude.pitch
      meshRef.current.rotation.y = -attitude.yaw
      meshRef.current.rotation.z = attitude.roll
    }
  })

  return (
    <group ref={meshRef}>
      {/* Body */}
      <mesh>
        <boxGeometry args={[0.6, 0.15, 0.6]} />
        <meshStandardMaterial color="#3B82F6" metalness={0.3} roughness={0.7} />
      </mesh>
      {/* Arms */}
      {[[-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 0, 0.5], [-0.5, 0, 0.5]].map((pos, i) => (
        <group key={i} position={pos as [number, number, number]}>
          {/* Arm */}
          <mesh position={[pos[0] * 0.3, 0, pos[2] * 0.3]}>
            <cylinderGeometry args={[0.03, 0.03, 0.5, 8]} />
            <meshStandardMaterial color="#1C1C26" />
          </mesh>
          {/* Motor */}
          <mesh position={[0, 0.08, 0]}>
            <cylinderGeometry args={[0.08, 0.08, 0.06, 16]} />
            <meshStandardMaterial color={i < 2 ? '#22C55E' : '#EF4444'} />
          </mesh>
          {/* Propeller */}
          <mesh position={[0, 0.12, 0]} rotation={[0, i * 0.7, 0]}>
            <boxGeometry args={[0.4, 0.01, 0.04]} />
            <meshStandardMaterial color="#F0F0F5" transparent opacity={0.5} />
          </mesh>
        </group>
      ))}
      {/* Front indicator */}
      <mesh position={[0, 0.08, -0.35]}>
        <coneGeometry args={[0.05, 0.12, 8]} />
        <meshStandardMaterial color="#F59E0B" />
      </mesh>
    </group>
  )
}

function Grid() {
  return (
    <gridHelper args={[4, 20, '#24243A', '#13131A']} position={[0, -1, 0]} />
  )
}

export default function AttitudeIndicator() {
  const connected = useConnectionStore((s) => s.status === 'connected')
  const isStale = useTelemetryStore((s) => s.isStale)
  // Re-render every 1.5s so the stale overlay appears promptly once the
  // threshold is crossed, even if no new telemetry arrives to trigger it.
  const [, force] = useState(0)
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1500)
    return () => clearInterval(id)
  }, [])
  const frozen = !connected || isStale('attitude')

  return (
    <div
      className="mc-card w-full overflow-hidden relative"
      style={{ height: 224, background: 'var(--att3d-canvas-bg)' }}
    >
      <Canvas camera={{ position: [0, 2.5, 2.5], fov: 45 }}>
        <ambientLight intensity={0.4} />
        <directionalLight position={[5, 5, 5]} intensity={0.8} />
        <pointLight position={[-3, 2, -3]} intensity={0.3} color="#3B82F6" />
        <DroneModel frozen={frozen} />
        <Grid />
      </Canvas>
      {frozen && (
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none"
          style={{ background: 'rgba(0,0,0,.45)', backdropFilter: 'blur(1px)' }}
        >
          <div className="text-center">
            <div className="text-[12px] font-semibold tracking-wider" style={{ color: '#F59E0B' }}>
              ⏸ 信号丢失
            </div>
            <div className="text-[10px] mt-1" style={{ color: 'var(--text-disabled)' }}>
              {connected ? '数据已冻结' : '飞控未连接'}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
