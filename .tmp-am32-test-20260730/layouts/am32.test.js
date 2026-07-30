"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const am32_1 = require("./am32");
function fixture() {
    const raw = new Uint8Array(am32_1.AM32_LAYOUT_SIZE).fill(0xa5);
    raw[0] = 0x01;
    raw[1] = 3;
    raw[3] = 2;
    raw[4] = 17;
    raw[0x05] = 160;
    raw[0x06] = 8;
    raw[0x17] = 25;
    raw[0x1a] = 82;
    raw[0x20] = 128;
    raw[0x21] = 128;
    raw[0x22] = 128;
    raw[0x23] = 50;
    raw[0x25] = 50;
    return raw;
}
(0, node_test_1.default)('decodes official AM32 revision 3 transforms', () => {
    const decoded = (0, am32_1.decodeAm32Eeprom)(fixture());
    strict_1.default.equal(decoded.layoutRevision, 3);
    strict_1.default.equal(decoded.values.rampRate, 16);
    strict_1.default.equal(decoded.values.minimumDutyCycle, 4);
    strict_1.default.equal(decoded.values.timingAdvance, 14.0625);
    strict_1.default.equal(decoded.values.motorKv, 3300);
    strict_1.default.equal(decoded.values.servoLowThreshold, 1006);
    strict_1.default.equal(decoded.values.servoHighThreshold, 2006);
    strict_1.default.equal(decoded.values.servoNeutral, 1502);
    strict_1.default.equal(decoded.values.servoDeadBand, 50);
    strict_1.default.equal(decoded.values.lowVoltageThreshold, 3);
});
(0, node_test_1.default)('encodes only patched bytes and preserves the rest of the EEPROM window', () => {
    const original = fixture();
    const encoded = (0, am32_1.encodeAm32Eeprom)(original, {
        rampRate: 12.5,
        motorKv: 2500,
        complementaryPwm: 1,
    });
    strict_1.default.equal(encoded[0x05], 125);
    strict_1.default.equal(encoded[0x1a], 62);
    strict_1.default.equal(encoded[0x14], 1);
    for (let index = 0; index < encoded.length; index++) {
        if ([0x05, 0x1a, 0x14].includes(index))
            continue;
        strict_1.default.equal(encoded[index], original[index], `byte 0x${index.toString(16)} changed`);
    }
});
(0, node_test_1.default)('rejects fields unavailable in the active layout', () => {
    const raw = fixture();
    raw[1] = 2;
    strict_1.default.throws(() => (0, am32_1.encodeAm32Eeprom)(raw, { rampRate: 10 }), /当前 AM32 布局不支持参数 rampRate/);
});
