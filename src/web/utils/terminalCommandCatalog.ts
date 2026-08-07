import type { TFunction } from 'i18next'

export interface TerminalQuickCommand {
  command: string
  description: string
}

export interface TerminalCommandCategory {
  title: string
  commands: TerminalQuickCommand[]
}

export function getPx4NshCommands(t: TFunction): readonly TerminalCommandCategory[] {
  return [
    {
      title: t('terminal.px4.cat.systemResources'),
      commands: [
        { command: 'help', description: t('terminal.px4.cmd.help') },
        { command: 'ver all', description: t('terminal.px4.cmd.verAll') },
        { command: 'top', description: t('terminal.px4.cmd.top') },
        { command: 'free', description: t('terminal.px4.cmd.free') },
      ],
    },
    {
      title: t('terminal.px4.cat.mavlinkAndStatus'),
      commands: [
        { command: 'mavlink status', description: t('terminal.px4.cmd.mavlinkStatus') },
        { command: 'mavlink status streams', description: t('terminal.px4.cmd.mavlinkStatusStreams') },
        { command: 'commander status', description: t('terminal.px4.cmd.commanderStatus') },
        { command: 'sensors status', description: t('terminal.px4.cmd.sensorsStatus') },
      ],
    },
    {
      title: t('terminal.px4.cat.uorbTopics'),
      commands: [
        { command: 'uorb top', description: t('terminal.px4.cmd.uorbTop') },
        { command: 'listener vehicle_status 1', description: t('terminal.px4.cmd.listenerVehicleStatus') },
        { command: 'listener sensor_combined 1', description: t('terminal.px4.cmd.listenerSensorCombined') },
        { command: 'listener estimator_status 1', description: t('terminal.px4.cmd.listenerEstimatorStatus') },
      ],
    },
    {
      title: t('terminal.px4.cat.paramsAndLogs'),
      commands: [
        { command: 'param show SYS_*', description: t('terminal.px4.cmd.paramShow') },
        { command: 'param compare', description: t('terminal.px4.cmd.paramCompare') },
        { command: 'logger status', description: t('terminal.px4.cmd.loggerStatus') },
        { command: 'dmesg', description: t('terminal.px4.cmd.dmesg') },
        { command: 'ls /fs/microsd', description: t('terminal.px4.cmd.lsMicrosd') },
        { command: 'df', description: t('terminal.px4.cmd.df') },
      ],
    },
  ]
}

// ArduPilot no longer exposes its old onboard CLI on current official
// firmware. These are reference-only MAVProxy commands for an external
// MAVProxy console, not commands that FlightControllerTerminal may send to the FC.
export function getArduPilotMavproxyCommands(t: TFunction): readonly TerminalCommandCategory[] {
  return [
    {
      title: t('terminal.ap.cat.connectionAndStatus'),
      commands: [
        { command: 'status', description: t('terminal.ap.cmd.status') },
        { command: 'link list', description: t('terminal.ap.cmd.linkList') },
        { command: 'time', description: t('terminal.ap.cmd.time') },
        { command: 'module list', description: t('terminal.ap.cmd.moduleList') },
      ],
    },
    {
      title: t('terminal.ap.cat.paramQuery'),
      commands: [
        { command: 'param show NAME', description: t('terminal.ap.cmd.paramShow') },
        { command: 'param help NAME', description: t('terminal.ap.cmd.paramHelp') },
        { command: 'param download', description: t('terminal.ap.cmd.paramDownload') },
      ],
    },
    {
      title: t('terminal.ap.cat.missionAndFence'),
      commands: [
        { command: 'wp list', description: t('terminal.ap.cmd.wpList') },
        { command: 'fence list', description: t('terminal.ap.cmd.fenceList') },
        { command: 'rally list', description: t('terminal.ap.cmd.rallyList') },
      ],
    },
    {
      title: t('terminal.ap.cat.modeQuery'),
      commands: [
        { command: 'mode', description: t('terminal.ap.cmd.mode') },
        { command: 'mode loiter', description: t('terminal.ap.cmd.modeLoiter') },
        { command: 'mode rtl', description: t('terminal.ap.cmd.modeRtl') },
      ],
    },
  ]
}
