import { create } from 'zustand'
import type { ImuData, BaroData, OpticalFlowData, DistanceSensorData } from '../../shared/types'

interface SensorState {
  imu: ImuData | null
  baro: BaroData | null
  opticalFlow: OpticalFlowData | null
  distanceSensor: DistanceSensorData | null
  magData: { x: number; y: number; z: number } | null
  sensorHealth: Record<string, 'ok' | 'warning' | 'error' | 'offline'>
  setImu: (data: ImuData) => void
  setBaro: (data: BaroData) => void
  setOpticalFlow: (data: OpticalFlowData) => void
  setDistanceSensor: (data: DistanceSensorData) => void
  setMag: (data: { x: number; y: number; z: number }) => void
  setSensorHealth: (sensor: string, status: 'ok' | 'warning' | 'error' | 'offline') => void
}

export const useSensorStore = create<SensorState>((set) => ({
  imu: null,
  baro: null,
  opticalFlow: null,
  distanceSensor: null,
  magData: null,
  sensorHealth: {
    imu: 'offline',
    mag: 'offline',
    baro: 'offline',
    gps: 'offline',
    opticalFlow: 'offline',
    rangefinder: 'offline',
    battery: 'offline',
  },
  setImu: (data) => set((state) => ({
    imu: data,
    magData: { x: data.xmag, y: data.ymag, z: data.zmag },
    sensorHealth: { ...state.sensorHealth, imu: 'ok', mag: 'ok' },
  })),
  setBaro: (data) => set((state) => ({
    baro: data,
    sensorHealth: { ...state.sensorHealth, baro: 'ok' },
  })),
  setOpticalFlow: (data) => set((state) => ({
    opticalFlow: data,
    sensorHealth: { ...state.sensorHealth, opticalFlow: data.quality > 0 ? 'ok' : 'warning' },
  })),
  setDistanceSensor: (data) => set((state) => ({
    distanceSensor: data,
    sensorHealth: { ...state.sensorHealth, rangefinder: 'ok' },
  })),
  setMag: (data) => set({ magData: data }),
  setSensorHealth: (sensor, status) => set((state) => ({
    sensorHealth: { ...state.sensorHealth, [sensor]: status },
  })),
}))
