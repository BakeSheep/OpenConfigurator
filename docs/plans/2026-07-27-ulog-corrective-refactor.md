# ULog Corrective Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Correct the completed ULog implementation without discarding its working parser infrastructure: restore real PX4 semantics, recover missing sensor/control data, eliminate false motor alarms, and replace the chart wall with one focused chart workspace per active analysis section.

**Architecture:** Preserve the container normalizer, `UlogDocument`, complete catalog, persistent Worker protocol, lazy raw queries, cache, and cancellation. Replace the faulty semantic and presentation boundary: normalize PX4 state/actuator/sensor fields in tested adapters, return chart families instead of a flat chart list, and render one selected chart view at a time. Every correction begins with a failing regression based on the real PX4 message shape that triggered the user-visible problem.

**Tech Stack:** React 19, TypeScript 6 strict mode, Vite Web Workers, `@foxglove/ulog`, uPlot, Node `assert`/`tsx` tests, existing CSS variables and MicoAir component primitives.

---

## Decision: selective refactor, not a full restart

Do **not** restart the feature from scratch. The following completed pieces are useful and must be preserved unless a new failing test proves a defect:

- `src/web/log-analysis/parser/normalizeUlogBuffer.ts`
- `src/web/log-analysis/parser/UlogDocument.ts`
- `src/web/log-analysis/parser/fieldPaths.ts`
- `src/web/log-analysis/workerProtocol.ts`
- `src/web/log-analysis/UlogAnalysisClient.ts`
- `src/web/log-analysis/seriesCache.ts`
- `src/web/log-analysis/rawQuery.ts`
- `src/web/workers/ulogAnalysisWorker.ts` session/cancellation/cache structure
- raw topic catalog, field browser and bounded lazy extraction
- appended-data, corrupt-file, cache, protocol and catalog tests

The following areas require targeted rewrite rather than incremental cosmetic patches:

- PX4 arming/flight-state interpretation in `flightOverview.ts` and `controlTracking.ts`;
- configured motor-channel discovery and NaN interpretation in `actuators.ts`;
- `sensor_combined` and dedicated-sensor extraction/downsampling in `sensors.ts`;
- flat `SectionResult.chartSeries` aggregation in `types.ts` and `runAnalysis.ts`;
- generic `SectionBody` chart rendering in `LogAnalysisPage.tsx`;
- default series selection in `chartModel.ts` and `MetricChartGroup.tsx`;
- synthetic tests that use invented fields or only assert that a module returned something.

Do not use `git reset`, `git checkout --`, or delete the current uncommitted implementation. Work on a new `codex/ulog-corrective-refactor` branch if branch creation is authorized, preserving the current working tree. Before editing, save `git status --short` and `git diff --stat` in the task notes so no prior work is lost.

## Non-negotiable acceptance criteria

The refactor is incomplete until all of these pass:

1. A real-shape `actuator_motors.control[12]` fixture with four finite controls and eight all-NaN controls reports exactly four motors and zero invalid-gap findings for channels 5–12.
2. Motor labels shown to users are 1-based. Internal array indices remain 0-based.
3. A real-shape `vehicle_status.arming_state` value of `2` produces an armed interval; value `1` closes it. No analysis module relies on `vehicle_status.armed`.
4. A log containing only `sensor_combined` for inertial data produces selectable acceleration XYZ and angular-rate XYZ chart views covering the complete log duration.
5. Dedicated `sensor_accel`, `sensor_gyro`, `sensor_mag`, and `sensor_baro` charts select semantic measurement fields, never “the first three numeric fields”.
6. Opening **控制**, **估计器**, **传感器与动力**, or **导航** mounts exactly one primary chart workspace. A text selector changes its category/view; it does not create another chart card.
7. A control attitude view defaults to one axis pair (actual + setpoint), not a single line and not all six lines. Motor output defaults to all configured motors when the count is at most six.
8. Charts use full-log bounded downsampling. They must not retain only the first N samples.
9. Metrics and findings remain visible when charts exist. They are not hidden by mutually exclusive rendering conditions.
10. Tests use official message fields and include at least one user-supplied or locally supplied real `.ulg` validation before release.

Official references:

- `ActuatorMotors`: https://docs.px4.io/main/en/msg_docs/ActuatorMotors
- `VehicleStatus`: https://docs.px4.io/main/en/msg_docs/VehicleStatus
- `ActuatorArmed`: https://docs.px4.io/main/en/msg_docs/ActuatorArmed
- `SensorCombined`: https://docs.px4.io/main/en/msg_docs/SensorCombined
- ULog format: https://docs.px4.io/main/en/dev_log/ulog_file_format

---

## Target presentation contract

Replace the flat list of chart cards with chart families:

```ts
export interface ChartView {
  id: string
  title: string
  description: string
  unit: string
  series: ChartSeries[]
  defaultVisibleSeriesIds: string[]
  thresholds?: ThresholdSpec[]
  xAxis: 'time' | 'frequency' | 'category'
  hasGaps: boolean
}

export interface ChartFamily {
  id: string
  moduleId: string
  title: string
  description: string
  views: ChartView[]
  defaultViewId: string
  order: number
}

export interface SectionResult {
  section: AnalysisSectionId
  available: boolean
  moduleResults: SectionModuleResult[]
  chartFamilies: ChartFamily[]
  findings: DiagnosticFinding[]
  warnings: string[]
}
```

Each active section renders one `SectionChartWorkspace`. It has two text-selector levels when needed:

- family selector: e.g. **控制跟踪 / 执行器**;
- view selector: e.g. **姿态 / 角速度**, then **横滚 / 俯仰 / 偏航** when the view model uses axis-specific views.

Only the selected `ChartView` mounts `UPlotChart`. Findings and compact metrics render below or beside the workspace; they do not become additional chart cards.

Required grouping:

- **控制:** 控制跟踪（姿态横滚/俯仰/偏航、角速度横滚/俯仰/偏航）; 执行器（电机输出、饱和摘要）.
- **估计器:** 状态与故障; 新息检验; 偏置与重置. Select estimator instance inside the workspace.
- **传感器与动力:** 惯性传感器; 振动频谱; 磁场与气压; 电池; 电调与推进. Select instance and metric, never one card per field.
- **导航:** GPS 质量; 位置与速度; 高度; 空速/风/光流/测距. Use metric selectors when units differ.
- **概览:** compact metrics, coverage, findings and timeline; no automatic wall of plots.
- **事件与原始数据:** paged events and raw explorer; raw plotting still uses one chart workspace.

---

### Task 1: Freeze the regression contract with real PX4 message shapes

**Files:**

- Create: `src/web/log-analysis/correctiveRegression.test.ts`
- Modify: `src/web/log-analysis/testing/ulogFixtureBuilder.ts`
- Modify: `src/web/log-analysis/controlAnalysis.test.ts`
- Modify: `src/web/log-analysis/healthAnalysis.test.ts`
- Modify: `src/web/log-analysis/uiModel.test.ts`
- Modify: `package.json` only if the test glob does not include the new file

**Step 1: Add a twelve-slot quad actuator fixture**

Generate `actuator_motors` with `control[12]`. For every armed sample, indices 0–3 contain finite normalized values and indices 4–11 contain IEEE float NaN. Include `CA_ROTOR_COUNT=4` when parameters are available, then add a second case with no `CA_ROTOR_COUNT` to exercise finite-value inference.

**Step 2: Write the failing quad assertions**

```ts
assert.equal(result.metrics.motorCount, 4)
assert.deepEqual(result.result.motorStats.map((m) => m.channelIndex), [0, 1, 2, 3])
assert.equal(result.findings.filter((f) => f.id.includes('nan-gap')).length, 0)
```

Also assert user-facing labels are `电机 1` through `电机 4`.

**Step 3: Add a real `vehicle_status` fixture**

Use `arming_state`, `nav_state`, `armed_time`, and `takeoff_time`. Do not put an `armed` field in the format. Assert armed and control-tracking intervals are created for `arming_state === 2`.

**Step 4: Add a `sensor_combined`-only fixture**

Use official fields `gyro_rad[3]`, `accelerometer_m_s2[3]`, integral timestamps and clipping bitfields. Generate more samples than the chart point budget and put a recognizable signal near the end of the log.

Assert:

```ts
assert.ok(findView('imu-acceleration'))
assert.ok(findView('imu-angular-rate'))
assert.deepEqual(findView('imu-acceleration').series.map((s) => s.label), ['X', 'Y', 'Z'])
assert.ok(lastTime(findView('imu-acceleration')) > logDuration * 0.95)
```

**Step 5: Add a presentation-model test**

Given multiple control and sensor chart families, assert one active workspace model is returned, with families/views available through selectors. Explicitly assert the model does not return a render-card per `ChartView`.

**Step 6: Run the tests and verify they fail for the known reasons**

```bash
npx tsx --test src/web/log-analysis/correctiveRegression.test.ts
```

Expected failures: 12 motors reported, NaN critical findings exist, armed interval missing, `sensor_combined` views absent, and presentation remains flat.

**Step 7: Commit tests only**

```bash
git add src/web/log-analysis package.json
git commit -m "test: reproduce ULog motor sensor and layout regressions"
```

Do not weaken these assertions to make subsequent implementation easier.

---

### Task 2: Centralize PX4 flight-state normalization

**Files:**

- Create: `src/web/log-analysis/px4/flightState.ts`
- Create: `src/web/log-analysis/flightState.test.ts`
- Modify: `src/web/log-analysis/modules/flightOverview.ts`
- Modify: `src/web/log-analysis/modules/controlTracking.ts`
- Modify: `src/web/log-analysis/modules/failsafe.ts` if it duplicates arming logic

**Step 1: Write a focused state-adapter test**

Cover:

- `vehicle_status.arming_state` values 1 and 2;
- optional `actuator_armed.armed` boolean fallback;
- old/custom `commander_state.armed` fallback only when that field actually exists;
- unknown/missing state returns `null`, not false;
- `vehicle_land_detected.landed` transitions.

**Step 2: Implement one adapter**

```ts
export function readArmedState(
  topicName: string,
  values: Readonly<Record<string, unknown>>,
): boolean | null {
  if (topicName === 'vehicle_status' && typeof values.arming_state === 'number') {
    return values.arming_state === 2
  }
  if (topicName === 'actuator_armed' && typeof values.armed === 'boolean') {
    return values.armed
  }
  if ('armed' in values && typeof values.armed === 'boolean') return values.armed
  return null
}
```

Do not coerce a missing field to zero.

**Step 3: Add `actuator_armed` as an optional requirement**

Both overview and tracking modules may consume it as fallback. Prefer `vehicle_status.arming_state` when both exist.

**Step 4: Remove invented-field logic**

Replace every `sample.values['armed'] ?? 0` read associated with `vehicle_status`. Close intervals only on known transitions.

**Step 5: Re-run state, control and corrective tests**

Expected: real `arming_state` tests pass; unrelated actuator/sensor/layout assertions remain failing.

**Step 6: Commit**

```bash
git add src/web/log-analysis/px4 src/web/log-analysis/modules src/web/log-analysis/flightState.test.ts
git commit -m "fix: interpret PX4 arming state from real topic fields"
```

---

### Task 3: Rewrite configured motor discovery and gap semantics

**Files:**

- Create: `src/web/log-analysis/px4/actuatorLayout.ts`
- Create: `src/web/log-analysis/actuatorLayout.test.ts`
- Modify: `src/web/log-analysis/modules/actuators.ts`
- Modify: `src/web/log-analysis/types.ts`
- Modify: `src/web/log-analysis/controlAnalysis.test.ts`

**Step 1: Define channel evidence explicitly**

```ts
interface MotorChannelState {
  channelIndex: number
  finiteSamples: number
  invalidSamplesAfterActivation: number
  firstFiniteSec: number | null
  lastFiniteSec: number | null
  times: number[]
  values: number[]
}
```

Do not create a configured motor merely because an array slot exists.

**Step 2: Implement motor-count precedence**

Use this order:

1. valid `CA_ROTOR_COUNT` in range 1–12;
2. configured output functions identifying Motor 1–12 if present in log parameters;
3. channels that have at least one finite sample during an armed interval;
4. channels that have at least one finite sample anywhere, marked as inferred.

All-NaN channels beyond the configured/inferred count are unused and produce no metrics, chart series, or findings.

**Step 3: Redefine an invalid gap**

A gap is reportable only when all are true:

- the channel is configured;
- it has already produced finite data;
- the vehicle is armed;
- invalidity persists longer than a duration threshold or exceeds a sample ratio threshold;
- the gap is not simply the final disarm transition.

A single NaN must not be `critical`. Use `notice` for short/low-ratio gaps, `warning` for sustained gaps, and reserve `critical` for measured loss of an active configured motor accompanied by relevant failure/ESC evidence.

**Step 4: Correct public numbering**

Keep `channelIndex` zero-based in evidence and storage. Format labels with `channelIndex + 1`.

**Step 5: Correct actuator chart output**

Return one “电机输出” view containing only configured motors. When motor count is 1–6, default all motor series visible. Put saturation durations in metrics/details or a category view, not a separate time-series chart pretending motor number is time.

**Step 6: Run the quad regression and actuator tests**

Expected: exactly four motors, no false gap findings for slots 4–11, labels 1–4.

**Step 7: Commit**

```bash
git add src/web/log-analysis/px4/actuatorLayout.ts src/web/log-analysis/actuatorLayout.test.ts src/web/log-analysis/modules/actuators.ts src/web/log-analysis/controlAnalysis.test.ts src/web/log-analysis/types.ts
git commit -m "fix: distinguish configured motors from unused NaN slots"
```

---

### Task 4: Rebuild sensor extraction around semantic field profiles

**Files:**

- Create: `src/web/log-analysis/px4/sensorProfiles.ts`
- Create: `src/web/log-analysis/sensorProfiles.test.ts`
- Modify: `src/web/log-analysis/modules/sensors.ts`
- Modify: `src/web/utils/ulogAnalysis.ts`
- Modify: `src/web/log-analysis/healthAnalysis.test.ts`

**Step 1: Define semantic profiles**

Profiles must list preferred topic aliases, vector fields, scalar fields and units. Minimum profiles:

```ts
sensor_combined:
  acceleration = accelerometer_m_s2[0..2], unit m/s²
  angularRate  = gyro_rad[0..2], unit rad/s

sensor_accel:
  acceleration = x/y/z or xyz[0..2], unit m/s²

sensor_gyro:
  angularRate = x/y/z or xyz[0..2], unit rad/s

sensor_mag:
  magneticField = x/y/z or magnetometer_ga[0..2], profile-defined unit

sensor_baro / vehicle_air_data:
  pressure, altitude, temperature as separate scalar views with explicit units
```

Never select fields by `Object.keys(...).slice(0, 3)`.

**Step 2: Replace first-N retention with streaming downsampling**

Use the existing min/max envelope/downsampling primitive or a new bounded streaming collector that covers the complete time range. Preserve first/last points and extrema. Do not cap by simply ignoring samples after 2000.

**Step 3: Recover `sensor_combined` views**

Generate:

- one acceleration XYZ time view;
- one angular-rate XYZ time view;
- vibration views only when sufficient contiguous data exists;
- clipping findings from the official clipping bitfields.

Do not return immediately after collecting combined data without producing output.

**Step 4: Handle dedicated instances without duplication**

If dedicated sensor topics exist, expose them as instance-selectable views. `sensor_combined` remains the calibrated primary IMU summary, not a duplicate card for every field.

**Step 5: Preserve invalid values as gaps**

Do not substitute missing field values with zero. Emit gaps/null metadata so charts break the line.

**Step 6: Run sensor and corrective tests**

Expected: `sensor_combined`-only fixture shows acceleration and angular rate through the end of the log; semantic XYZ fields are selected.

**Step 7: Commit**

```bash
git add src/web/log-analysis/px4/sensorProfiles.ts src/web/log-analysis/sensorProfiles.test.ts src/web/log-analysis/modules/sensors.ts src/web/log-analysis/healthAnalysis.test.ts src/web/utils/ulogAnalysis.ts
git commit -m "fix: restore complete semantic sensor chart extraction"
```

---

### Task 5: Replace flat chart aggregation with chart families

**Files:**

- Modify: `src/web/log-analysis/types.ts`
- Modify: `src/web/log-analysis/engine/AnalysisModule.ts`
- Modify: `src/web/log-analysis/engine/runAnalysis.ts`
- Modify: `src/web/log-analysis/engine/moduleRegistry.ts`
- Modify: every file under `src/web/log-analysis/modules/` that returns `chartSeries`
- Create: `src/web/log-analysis/chartFamilies.test.ts`
- Modify: `src/web/log-analysis/moduleRegistry.test.ts`

**Step 1: Add `ChartView` and `ChartFamily` contracts**

Use the target contract above. Add stable series IDs; labels alone are not identity.

**Step 2: Preserve module boundaries during section merge**

The current merge flattens all charts and overwrites the section-level `moduleId`. Replace it with `moduleResults[]` and concatenate ordered `chartFamilies`. Metrics remain associated with their source module/family.

**Step 3: Convert control families first**

- `control-tracking` family views: roll attitude pair, pitch attitude pair, yaw attitude pair, roll-rate pair, pitch-rate pair, yaw-rate pair.
- `actuators` family views: configured motor outputs; optional output/servo view; saturation summary view only if category-axis rendering is supported.

Each actual/setpoint view defaults to both related series.

**Step 4: Convert sensor/power families**

- `imu` family: acceleration, angular rate;
- `vibration` family: spectrum by sensor instance/measurement;
- `environment-sensors` family: magnetic field, pressure, altitude, temperature;
- `battery` family: voltage, current, remaining/consumption;
- `propulsion` family: RPM, ESC current/voltage/temperature.

Views with incompatible units must be separate selectors, not overlaid.

**Step 5: Convert estimator/navigation/system families**

Group related fields and instances. Never create a `ChartFamily` per scalar field. Use an instance selector or view selector.

**Step 6: Add aggregation tests**

Assert module identity, ordering, metrics ownership, and these upper bounds for fixture output:

- control: at most 2 families;
- estimator: at most 3 families;
- sensors-power: at most 5 families;
- navigation: at most 4 families.

These are selector families, not simultaneously mounted charts.

**Step 7: Run all analysis tests**

Update tests to inspect families/views semantically. Do not restore compatibility by recreating a flat `chartSeries` alias.

**Step 8: Commit**

```bash
git add src/web/log-analysis
git commit -m "refactor: preserve analysis modules as selectable chart families"
```

---

### Task 6: Build one focused chart workspace per active section

**Files:**

- Create: `src/web/components/logs/SectionChartWorkspace.tsx`
- Modify: `src/web/components/logs/MetricChartGroup.tsx`
- Modify: `src/web/components/logs/UPlotChart.tsx`
- Modify: `src/web/pages/LogAnalysisPage.tsx`
- Modify: `src/web/log-analysis/chartModel.ts`
- Modify: `src/web/log-analysis/uiModel.ts`
- Modify: `src/web/log-analysis/chartModel.test.ts`
- Modify: `src/web/log-analysis/uiModel.test.ts`
- Modify: `src/web/index.css`

**Step 1: Extract a deterministic workspace model**

```ts
interface ChartWorkspaceModel {
  families: ChartFamily[]
  activeFamilyId: string
  activeViewId: string
  activeView: ChartView | null
}
```

On family/view changes, retain a valid selection or use that family’s explicit default. Do not use array order as an undocumented default.

**Step 2: Correct default visible series**

Use `ChartView.defaultVisibleSeriesIds`:

- attitude/rates: actual + setpoint for one selected axis;
- acceleration/gyro/mag: X + Y + Z;
- motor outputs: every configured motor up to six, otherwise first six with a clear selector;
- batteries/GPS instances: all compatible instances up to six.

Remove the rule that shows only the first series whenever selection is empty.

**Step 3: Replace `SectionBody` mapping**

Delete this pattern:

```tsx
section.chartSeries.map((group) => (
  <MetricChartGroup seriesGroups={[group]} />
))
```

Render exactly one:

```tsx
<SectionChartWorkspace families={section.chartFamilies} />
```

Only the active view mounts `UPlotChart`.

**Step 4: Always render metrics and findings**

Remove the current `!hasCharts && !hasFindings` metrics condition. Layout:

1. compact section metrics;
2. chart workspace when families exist;
3. findings list;
4. warnings/details.

Do not turn metrics into a grid of large KPI cards; use a compact wrapping strip or details table.

**Step 5: Simplify CSS**

Remove `.analysis-groups-grid` as the chart-wall layout. The workspace is full width. Use a single card with horizontally scrollable text selectors, a stable chart height, and a details region below. At narrow widths, selectors scroll rather than wrap into dense rows.

**Step 6: Add a render-contract test**

Use a pure UI model test or `renderToStaticMarkup` to assert one chart workspace per active section. Do not add a new test framework solely for this assertion.

**Step 7: Manually verify interaction**

At 1440, 1024, 768 and 390 px:

- changing family/view updates the single chart;
- no layout jump from creating/destroying many cards;
- legends do not hide related default series;
- inactive sections do not mount uPlot instances;
- dark/light themes use project variables.

**Step 8: Commit**

```bash
git add src/web/components/logs src/web/pages/LogAnalysisPage.tsx src/web/log-analysis/chartModel.ts src/web/log-analysis/uiModel.ts src/web/log-analysis/*Model.test.ts src/web/index.css
git commit -m "refactor: render one focused chart workspace per log section"
```

---

### Task 7: Audit remaining modules for real fields, full-duration data, and honest diagnoses

**Files:**

- Modify: `src/web/log-analysis/modules/estimator.ts`
- Modify: `src/web/log-analysis/modules/navigation.ts`
- Modify: `src/web/log-analysis/modules/power.ts`
- Modify: `src/web/log-analysis/modules/propulsion.ts`
- Modify: `src/web/log-analysis/modules/systemHealth.ts`
- Modify: `src/web/log-analysis/modules/failsafe.ts`
- Modify: `src/web/log-analysis/modules/events.ts`
- Modify: relevant test files in `src/web/log-analysis/`

**Step 1: Build a field-audit table in the test file**

For every purpose-built metric, record topic aliases, exact fields, units, multi-instance behavior, missing-data behavior and confidence. Compare against the applicable PX4 message definition.

**Step 2: Remove zero substitution**

Search for patterns such as `?? 0` where absence means unknown rather than a measured zero. Replace with omission/gap and a coverage warning.

**Step 3: Replace first-N buffering**

Search every module for `length < MAX_CHART_POINTS`, `.slice(0, N)` and similar retention. Use bounded whole-log downsampling instead.

**Step 4: Correct units and chart axes**

Do not use a time-series component for categorical motor/channel summaries. Frequency views must set frequency axis/no time synchronization. Separate voltage/current/accuracy metrics by unit.

**Step 5: Downgrade unsupported causal conclusions**

Recommendations based only on thresholds remain heuristic. Do not label them measured or critical without corroborating evidence.

**Step 6: Add one regression per corrected behavior**

Tests must assert exact fields/units/view grouping, not merely `chartSeries.length > 0` or “section exists”.

**Step 7: Commit**

```bash
git add src/web/log-analysis/modules src/web/log-analysis/*.test.ts
git commit -m "fix: align remaining ULog modules with PX4 field semantics"
```

---

### Task 8: Validate against the user’s real log and visual expectations

**Files:**

- Modify: `test/fixtures/ulog/manifest.json` only for redistributable fixtures
- Modify: `src/web/log-analysis/realLogs.test.ts`
- Create or modify: `docs/LOG_ANALYSIS.md`
- Modify: `docs/ARCHITECTURE.md`

**Step 1: Use the problem log locally**

Ask for or locate the exact `.ulg` that showed four installed motors and eight false alarms. Keep it outside git unless the user explicitly permits committing a sanitized version. Point `ULOG_FIXTURE_DIR` to it.

**Step 2: Record the acceptance observations**

For that log verify:

- detected motor count is 4;
- visible motor labels are 1–4;
- no unused-channel gap finding exists;
- armed/flight duration is nonzero when appropriate;
- `sensor_combined` acceleration and angular-rate views exist;
- each view spans at least 95% of the relevant logged time range;
- the control section has one mounted primary chart workspace;
- the sensors-power section has one mounted primary chart workspace;
- selecting categories/views recovers every expected sensor, battery and navigation graph.

**Step 3: Capture comparison screenshots**

Capture control and sensors-power at 1440 and 768 px in dark theme, plus one light-theme overview. Review for chart wall, excessive selector wrapping, empty whitespace, clipped legends and icon proliferation.

**Step 4: Update real-log tests**

Add invariant checks derived from the real log without snapshotting private data. If the log cannot be committed, document the optional fixture hash and expected result in the local validation note.

**Step 5: Update documentation honestly**

Document configured-motor inference, NaN semantics, state provenance, sensor topic precedence, chart-family navigation and known unsupported data. Remove “Flight Review 级全面分析” unless the real-log matrix justifies it.

**Step 6: Run the complete verification suite**

```bash
npm run test:log-analysis
npm run test:server
npm run test:protocol
npm run typecheck
npm run build
git diff --check
```

Expected: all commands exit 0 and the manual acceptance observations above pass.

**Step 7: Review for scope and privacy**

```bash
git status --short
git diff --stat
```

Ensure no private `.ulg`, GPS path, system UUID, downloaded log, temporary CSV, screenshot containing private coordinates, or generated `dist/` is staged.

**Step 8: Commit**

```bash
git add docs src/web/log-analysis/realLogs.test.ts test/fixtures/ulog/manifest.json
git commit -m "test: validate corrected ULog analysis on real PX4 logs"
```

---

## Review gates

### Gate A — Semantic correctness

Tasks 1–4 complete. Stop and review the user’s quad log before touching general UI polish. Four motors must remain four; arming and `sensor_combined` must work.

### Gate B — Information architecture

Tasks 5–6 complete. Stop and review screenshots. Every active section must have one primary chart workspace, with related data available through text selectors.

### Gate C — Broader compatibility

Tasks 7–8 complete. Only then claim the corrective refactor finished.

## Explicit prohibitions for the executing agent

- Do not restart or replace the parser stack without a failing parser test.
- Do not fix the motor issue by hardcoding four motors.
- Do not treat every NaN as corruption; interpret it using the topic’s specification and configured-channel evidence.
- Do not invent PX4 fields in fixtures.
- Do not restore missing sensor plots by rendering every catalog field automatically.
- Do not generate one chart card per field, axis, instance or battery.
- Do not hide extra curves by default without providing a semantic default selection.
- Do not silently cap samples to the first N records.
- Do not add decorative icons to chart families, metrics or findings.
- Do not mark work complete using only synthetic tests; validate the reported real log.

## Handoff note

This is a corrective refactor, not another feature-expansion pass. Execute in order. The first delivery checkpoint is the user’s four-motor log and `sensor_combined`, not the number of modules or tests. If a proposed abstraction does not directly help one of the ten acceptance criteria, defer it.
