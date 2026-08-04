export interface TerminalQuickCommand {
  command: string
  description: string
}

export interface TerminalCommandCategory {
  title: string
  commands: TerminalQuickCommand[]
}

export const PX4_NSH_COMMANDS: readonly TerminalCommandCategory[] = [
  {
    title: '系统资源',
    commands: [
      { command: 'help', description: '列出当前固件可用命令' },
      { command: 'ver all', description: '查看固件与硬件版本' },
      { command: 'top', description: '查看任务与 CPU 占用' },
      { command: 'free', description: '查看内存使用情况' },
    ],
  },
  {
    title: 'MAVLink 与状态',
    commands: [
      { command: 'mavlink status', description: '查看所有 MAVLink 实例' },
      { command: 'mavlink status streams', description: '查看消息流及发送速率' },
      { command: 'commander status', description: '查看飞行状态机' },
      { command: 'sensors status', description: '查看传感器汇总状态' },
    ],
  },
  {
    title: 'uORB 主题',
    commands: [
      { command: 'uorb top', description: '监视主题发布频率' },
      { command: 'listener vehicle_status 1', description: '读取飞行器状态主题' },
      { command: 'listener sensor_combined 1', description: '读取组合惯导主题' },
      { command: 'listener estimator_status 1', description: '读取估计器状态主题' },
    ],
  },
  {
    title: '参数与日志',
    commands: [
      { command: 'param show SYS_*', description: '查询匹配的参数' },
      { command: 'param compare', description: '列出非默认参数' },
      { command: 'logger status', description: '查看 ULog 记录状态' },
      { command: 'dmesg', description: '查看系统日志缓冲区' },
      { command: 'ls /fs/microsd', description: '查看 SD 卡根目录' },
      { command: 'df', description: '查看文件系统容量' },
    ],
  },
]

// ArduPilot no longer exposes its old onboard CLI on current official
// firmware. These are reference-only MAVProxy commands for an external
// MAVProxy console, not commands that FlightControllerTerminal may send to the FC.
export const ARDUPILOT_MAVPROXY_COMMANDS: readonly TerminalCommandCategory[] = [
  {
    title: '连接与状态',
    commands: [
      { command: 'status', description: '显示最近收到的飞控状态包' },
      { command: 'link list', description: '列出 MAVLink 链路' },
      { command: 'time', description: '显示飞控与地面站时间' },
      { command: 'module list', description: '列出已加载 MAVProxy 模块' },
    ],
  },
  {
    title: '参数查询',
    commands: [
      { command: 'param show NAME', description: '查看指定参数值' },
      { command: 'param help NAME', description: '查看参数定义' },
      { command: 'param download', description: '下载参数说明文件' },
    ],
  },
  {
    title: '任务与围栏',
    commands: [
      { command: 'wp list', description: '下载并显示航点' },
      { command: 'fence list', description: '下载并显示地理围栏' },
      { command: 'rally list', description: '下载并显示集结点' },
    ],
  },
  {
    title: '模式查询',
    commands: [
      { command: 'mode', description: '列出当前机型可用模式' },
      { command: 'mode loiter', description: '切换 Loiter（外部工具执行）' },
      { command: 'mode rtl', description: '切换 RTL（外部工具执行）' },
    ],
  },
]
