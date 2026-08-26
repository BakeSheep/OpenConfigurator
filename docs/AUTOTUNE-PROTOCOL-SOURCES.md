# 自动调参协议来源

## PX4

- [Multicopter Auto-Tuning](https://docs.px4.io/v1.16/en/config/autotune_mc)：启动命令、轮询、进度和落地后应用语义。
- [PX4 MAVLink receiver](https://github.com/PX4/PX4-Autopilot/blob/main/src/modules/mavlink/mavlink_receiver.cpp)：命令 212 的模块检测、参数限制和 0/20/40/60/80/85/90/95/100 进度映射。
- [QGroundControl Autotune](https://github.com/mavlink/qgroundcontrol/blob/master/src/Vehicle/Autotune.cpp)：1 秒轮询间隔及 ACK 处理参考。

PX4 当前实现只接受 `param1=1` 且 `param2=0`。因此首版不通过 `AUTOTUNE_AXIS` 参数选轴，也不声称命令 212 可靠地支持远程取消。

## ArduCopter

- [AutoTune documentation](https://ardupilot.org/copter/docs/autotune.html)：进入条件、试飞流程、测试新增益与落地保存语义。
- [ArduCopter AutoTune mode](https://github.com/ArduPilot/ardupilot/blob/master/ArduCopter/mode_autotune.cpp)：模式 15 的已解锁、在飞、油门与入口模式检查。
- [AC_AutoTune](https://github.com/ArduPilot/ardupilot/blob/master/libraries/AC_AutoTune/AC_AutoTune.cpp)：`Started`、`Success`、`Pilot Testing`、`original gains restored`、`Saved gains`、`Failed` 状态文本及上锁保存逻辑。

ArduCopter 首版通过 AutoTune 模式 15 启动，不将 ArduPlane 中的 `MAV_CMD_DO_AUTOTUNE_ENABLE` 处理外推到 Copter。传统直升机的调参算法和步骤不同，首版显式排除。
