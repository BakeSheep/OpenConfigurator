"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AM32_SETTINGS_FIELDS = exports.AM32_SETTINGS_GROUPS = exports.AM32_SUPPORTED_LAYOUTS = exports.AM32_LAYOUT_SIZE = void 0;
exports.isSupportedAm32Layout = isSupportedAm32Layout;
exports.am32FieldsForRevision = am32FieldsForRevision;
exports.decodeAm32Eeprom = decodeAm32Eeprom;
exports.encodeAm32Eeprom = encodeAm32Eeprom;
const errors_1 = require("../errors");
exports.AM32_LAYOUT_SIZE = 0xb8;
exports.AM32_SUPPORTED_LAYOUTS = [1, 2, 3];
exports.AM32_SETTINGS_GROUPS = [
    { key: 'essentials', label: '基础设置', description: '输入协议、方向与双向控制' },
    { key: 'motor', label: '电机', description: '换相、启动、PWM 与电机参数' },
    { key: 'extended', label: '扩展设置', description: '油门响应与最低占空比' },
    { key: 'limits', label: '保护限制', description: '电压、温度和电流保护' },
    { key: 'current', label: '电流环', description: '电流控制器 P / I / D 参数' },
    { key: 'sine', label: '正弦启动', description: '低速正弦启动参数' },
    { key: 'brake', label: '制动', description: '停止、运行与主动制动' },
    { key: 'servo', label: '舵机输入', description: 'PWM 输入范围和中位死区' },
];
const bool = (key, label, group, offset, extra = {}) => ({
    key,
    label,
    group,
    offset,
    size: 1,
    kind: 'bool',
    scope: 'common',
    ...extra,
});
const number = (key, label, group, offset, min, max, step, extra = {}) => ({
    key,
    label,
    group,
    offset,
    size: 1,
    kind: 'number',
    scope: 'common',
    min,
    max,
    step,
    ...extra,
});
const enumeration = (key, label, group, offset, options, extra = {}) => ({
    key,
    label,
    group,
    offset,
    size: 1,
    kind: 'enum',
    scope: 'common',
    options,
    ...extra,
});
/**
 * AM32 EEPROM fields supported by the settings-only configurator.
 * Offsets and transforms follow the official AM32 Configurator EEPROM layout.
 * Unknown bytes are deliberately absent and are preserved during encoding.
 */
exports.AM32_SETTINGS_FIELDS = [
    bool('disableStickCalibration', '禁用油门校准', 'essentials', 0x07, {
        minLayoutRevision: 3,
        description: '保留当前油门端点，不再在上电时重新学习。',
    }),
    enumeration('protocol', '输入协议', 'essentials', 0x2e, [
        { value: 0, label: '自动' },
        { value: 1, label: 'DShot' },
        { value: 2, label: 'Servo PWM' },
        { value: 3, label: '串行' },
        { value: 4, label: '扩展 DShot' },
    ]),
    enumeration('motorDirection', '电机方向', 'essentials', 0x11, [
        { value: 0, label: '正转' },
        { value: 1, label: '反转' },
    ]),
    bool('bidirectional', '双向模式', 'essentials', 0x12),
    bool('stuckRotorProtection', '堵转保护', 'motor', 0x16),
    bool('stallProtection', '失速保护', 'motor', 0x1d),
    bool('hallSensors', '霍尔传感器', 'motor', 0x27),
    bool('intervalTelemetry', '30ms 周期遥测', 'motor', 0x1f),
    bool('complementaryPwm', '互补 PWM', 'motor', 0x14),
    bool('autoTimingAdvance', '自动进角', 'motor', 0x2f),
    enumeration('pwmType', 'PWM 类型', 'motor', 0x15, [
        { value: 0, label: '固定' },
        { value: 1, label: '可变' },
        { value: 2, label: '随转速' },
    ]),
    number('timingAdvance', '进角', 'motor', 0x17, 0, 22.5, 7.5, {
        maxLayoutRevision: 2,
        unit: '°',
        precision: 1,
        scale: 7.5,
    }),
    number('timingAdvance', '进角', 'motor', 0x17, 0, 22.5, 0.9375, {
        minLayoutRevision: 3,
        unit: '°',
        precision: 4,
        scale: 0.9375,
        add: -9.375,
    }),
    number('startupPower', '启动功率', 'motor', 0x19, 50, 150, 1, { unit: '%' }),
    number('motorKv', '电机 KV', 'motor', 0x1a, 20, 10220, 40, {
        scale: 40,
        add: 20,
    }),
    number('motorPoles', '磁极数', 'motor', 0x1b, 2, 36, 1),
    number('beeperVolume', '蜂鸣器音量', 'motor', 0x1e, 0, 11, 1),
    number('pwmFrequency', 'PWM 频率', 'motor', 0x18, 8, 144, 1, {
        unit: 'kHz',
        disabledIf: { key: 'pwmType', equals: 2 },
    }),
    number('rampRate', '爬升速率', 'extended', 0x05, 0.1, 25.5, 0.1, {
        minLayoutRevision: 3,
        unit: '%/ms',
        precision: 1,
        scale: 0.1,
    }),
    number('minimumDutyCycle', '最低占空比', 'extended', 0x06, 0.5, 100, 0.5, {
        minLayoutRevision: 3,
        unit: '%',
        precision: 1,
        scale: 0.5,
    }),
    enumeration('lowVoltageCutoff', '低压保护', 'limits', 0x24, [
        { value: 0, label: '关闭' },
        { value: 1, label: '按电芯' },
        { value: 2, label: '绝对电压' },
    ]),
    number('temperatureLimit', '温度限制', 'limits', 0x2b, 70, 140, 1, {
        unit: '°C',
        disabledValue: 255,
    }),
    number('currentLimit', '电流限制', 'limits', 0x2c, 0, 200, 2, {
        unit: 'A',
        scale: 2,
        disabledValue: 404,
    }),
    number('lowVoltageThreshold', '单节截止电压', 'limits', 0x25, 2.5, 3.5, 0.01, {
        unit: 'V',
        precision: 2,
        scale: 0.01,
        add: 2.5,
        visibleIf: { key: 'lowVoltageCutoff', equals: 1 },
    }),
    number('absoluteVoltageThreshold', '绝对截止电压', 'limits', 0x08, 0.5, 50, 0.5, {
        minLayoutRevision: 3,
        unit: 'V',
        precision: 1,
        scale: 0.5,
        visibleIf: { key: 'lowVoltageCutoff', equals: 2 },
    }),
    number('currentP', '电流 P', 'current', 0x09, 0, 255, 1, {
        minLayoutRevision: 3,
        disabledIf: { key: 'currentLimit', equals: 404 },
    }),
    number('currentI', '电流 I', 'current', 0x0a, 0, 255, 1, {
        minLayoutRevision: 3,
        disabledIf: { key: 'currentLimit', equals: 404 },
    }),
    number('currentD', '电流 D', 'current', 0x0b, 0, 255, 1, {
        minLayoutRevision: 3,
        disabledIf: { key: 'currentLimit', equals: 404 },
    }),
    bool('sinusoidalStartup', '正弦启动', 'sine', 0x13),
    number('sineModeRange', '正弦模式范围', 'sine', 0x28, 5, 25, 1),
    number('sineModePower', '正弦模式功率', 'sine', 0x2d, 1, 10, 1),
    bool('carReverseBraking', '车模反向制动', 'brake', 0x26),
    enumeration('brakeOnStop', '停止制动', 'brake', 0x1c, [
        { value: 0, label: '关闭' },
        { value: 1, label: '停止时制动' },
        { value: 2, label: '主动制动' },
    ]),
    number('brakeStrength', '制动力度', 'brake', 0x29, 0, 10, 1),
    number('runningBrakeLevel', '运行制动级别', 'brake', 0x2a, 0, 10, 1),
    number('activeBrakePower', '主动制动功率', 'brake', 0x0c, 0, 10, 1, {
        minLayoutRevision: 3,
        disabledValue: 0,
    }),
    number('servoLowThreshold', '低端点', 'servo', 0x20, 750, 1258, 2, {
        unit: 'µs',
        scale: 2,
        add: 750,
        scope: 'perEsc',
    }),
    number('servoHighThreshold', '高端点', 'servo', 0x21, 1750, 2258, 2, {
        unit: 'µs',
        scale: 2,
        add: 1750,
        scope: 'perEsc',
    }),
    number('servoNeutral', '中位', 'servo', 0x22, 1374, 1629, 1, {
        unit: 'µs',
        add: 1374,
        scope: 'perEsc',
    }),
    number('servoDeadBand', '中位死区', 'servo', 0x23, 0, 255, 1, {
        unit: 'µs',
        scope: 'perEsc',
    }),
];
function isSupportedAm32Layout(revision) {
    return exports.AM32_SUPPORTED_LAYOUTS.includes(revision);
}
function am32FieldsForRevision(revision) {
    return exports.AM32_SETTINGS_FIELDS.filter((field) => {
        if (field.minLayoutRevision !== undefined && revision < field.minLayoutRevision)
            return false;
        if (field.maxLayoutRevision !== undefined && revision > field.maxLayoutRevision)
            return false;
        return true;
    });
}
function decodeAm32Eeprom(raw) {
    assertLayoutWindow(raw);
    const layoutRevision = raw[0x01];
    if (!isSupportedAm32Layout(layoutRevision)) {
        throw new errors_1.EscError('unsupported_signature_or_layout', `不支持 AM32 EEPROM 布局版本 ${layoutRevision}`);
    }
    const values = {};
    for (const field of am32FieldsForRevision(layoutRevision)) {
        const rawValue = readUnsigned(raw, field.offset, field.size);
        values[field.key] = rawValue * (field.scale ?? 1) + (field.add ?? 0);
    }
    return { layoutRevision, values };
}
function encodeAm32Eeprom(original, patch) {
    const { layoutRevision, values } = decodeAm32Eeprom(original);
    const fields = am32FieldsForRevision(layoutRevision);
    const encoded = original.slice();
    for (const [key, displayValue] of Object.entries(patch)) {
        const field = fields.find((candidate) => candidate.key === key);
        if (!field) {
            throw new errors_1.EscError('validation_failed', `当前 AM32 布局不支持参数 ${key}`);
        }
        if (!Number.isFinite(displayValue)) {
            throw new errors_1.EscError('validation_failed', `${field.label} 不是有效数值`);
        }
        if (field.kind === 'bool' && displayValue !== 0 && displayValue !== 1) {
            throw new errors_1.EscError('validation_failed', `${field.label} 只能为开启或关闭`);
        }
        if (field.kind === 'enum'
            && !field.options?.some((option) => option.value === displayValue)) {
            throw new errors_1.EscError('validation_failed', `${field.label} 选项无效`);
        }
        const isDisabledSentinel = field.disabledValue === displayValue;
        if (!isDisabledSentinel
            && ((field.min !== undefined && displayValue < field.min)
                || (field.max !== undefined && displayValue > field.max))) {
            throw new errors_1.EscError('validation_failed', `${field.label} 超出允许范围`);
        }
        const rawValue = Math.round((displayValue - (field.add ?? 0)) / (field.scale ?? 1));
        const rawMax = 2 ** (field.size * 8) - 1;
        if (rawValue < 0 || rawValue > rawMax) {
            throw new errors_1.EscError('validation_failed', `${field.label} 无法编码到 EEPROM`);
        }
        writeUnsigned(encoded, field.offset, field.size, rawValue);
        values[key] = displayValue;
    }
    return encoded;
}
function assertLayoutWindow(raw) {
    if (raw.length !== exports.AM32_LAYOUT_SIZE) {
        throw new errors_1.EscError('validation_failed', `AM32 EEPROM 数据长度应为 ${exports.AM32_LAYOUT_SIZE} 字节，实际为 ${raw.length}`);
    }
}
function readUnsigned(raw, offset, size) {
    let value = 0;
    for (let byte = 0; byte < size; byte++)
        value |= raw[offset + byte] << (byte * 8);
    return value >>> 0;
}
function writeUnsigned(raw, offset, size, value) {
    for (let byte = 0; byte < size; byte++)
        raw[offset + byte] = (value >>> (byte * 8)) & 0xff;
}
