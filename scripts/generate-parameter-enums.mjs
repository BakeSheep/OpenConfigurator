import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

// OCSA-012：参数枚举源必须锁定。上游内容变化时本脚本直接失败，这是有意设计——
// 刷新 pin 属于显式维护操作：人工 review 上游 diff 后，用 `--update-pin` 重新生成
// 并把新哈希更新到下面的常量中，再对输出 diff 执行 review。
//
// PX4 锁定到 QGC 具体 commit；ArduPilot 的 autotest.ardupilot.org 不提供按 commit
// 的固定 URL，只能锁定内容 SHA-256（内容 pin）。
const PX4_PIN = {
  url: 'https://raw.githubusercontent.com/mavlink/qgroundcontrol/130170966c0d063ae55a1f0cefb8ad71aa2ac5b5/src/FirmwarePlugin/PX4/PX4ParameterFactMetaData.json',
  ref: 'qgroundcontrol@130170966c0d063ae55a1f0cefb8ad71aa2ac5b5',
  sha256: '94bd6df4b48ee60329de0c4bd47124b4aa6fdc8948ad75b972f46ba1aceb23a9',
  pinnedAt: '2026-08-21',
}
const ARDUPILOT_PIN = {
  url: 'https://autotest.ardupilot.org/Parameters/Copter/apm.pdef.json',
  ref: 'ardupilot-autotest Copter apm.pdef.json (content pin)',
  sha256: '714f9ba09f7022e1470ed583eda968309820c9723afb6c693c2c0428ecb934c2',
  pinnedAt: '2026-08-21',
}

const outputDir = path.resolve('src/shared/data/parameterEnums')

function argumentValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : null
}

function hasFlag(name) {
  return process.argv.includes(name)
}

const updatePin = hasFlag('--update-pin')

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function describeMismatch(pin, actual) {
  return [
    `${pin.ref} 内容与锁定的 SHA-256 不匹配。`,
    `  期望: ${pin.sha256}`,
    `  实际: ${actual}`,
    `上游内容已变化。请人工 review 上游 diff（${pin.url}），确认可接受后执行`,
    `  node scripts/generate-parameter-enums.mjs --update-pin`,
    `并把新的 sha256/pinnedAt 更新到脚本顶部的 PIN 常量，再对输出 diff 做 review。`,
  ].join('\n')
}

async function loadPinned(pin, localPath, label) {
  let content
  let source
  if (localPath) {
    content = await readFile(path.resolve(localPath))
    source = `${pin.ref} (local: ${path.resolve(localPath)})`
  } else {
    const response = await fetch(pin.url)
    if (!response.ok) throw new Error(`Failed to download ${pin.url}: HTTP ${response.status}`)
    content = Buffer.from(await response.arrayBuffer())
    source = pin.url
  }
  const actual = sha256(content)
  if (actual !== pin.sha256 && !updatePin) {
    throw new Error(describeMismatch(pin, actual))
  }
  if (actual !== pin.sha256) {
    console.warn(`[${label}] pin 将更新: ${pin.sha256} -> ${actual}`)
  }
  return { json: JSON.parse(content.toString('utf8')), sha256: actual, source }
}

function compactCatalog(source, entries) {
  const sets = []
  const setIndices = new Map()
  const parameters = {}

  for (const [name, options] of [...entries].sort(([left], [right]) => left.localeCompare(right))) {
    const key = JSON.stringify(options)
    let setIndex = setIndices.get(key)
    if (setIndex === undefined) {
      setIndex = sets.length
      sets.push(options)
      setIndices.set(key, setIndex)
    }
    parameters[name] = setIndex
  }

  return { source, sets, parameters }
}

function px4Catalog(json, source) {
  const entries = []
  for (const parameter of json.parameters ?? []) {
    // Match QGC's editor rule: bitmasks are multi-select values, not enums.
    if (!Array.isArray(parameter.values) || Array.isArray(parameter.bitmask)) continue
    entries.push([
      parameter.name,
      parameter.values.map(({ value, description }) => [Number(value), String(description)]),
    ])
  }
  return compactCatalog(source, entries)
}

function ardupilotCatalog(json, source) {
  const entriesByName = new Map()
  for (const group of Object.values(json)) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) continue
    for (const [name, metadata] of Object.entries(group)) {
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) continue
      if (!metadata.Values || metadata.Bitmask) continue
      const options = Object.entries(metadata.Values)
        .map(([value, label]) => [Number(value), String(label)])
        .sort(([left], [right]) => left - right)
      const existing = entriesByName.get(name)
      if (existing && JSON.stringify(existing) !== JSON.stringify(options)) {
        throw new Error(`Conflicting ArduCopter enum metadata for ${name}`)
      }
      entriesByName.set(name, options)
    }
  }
  return compactCatalog(source, entriesByName.entries())
}

const px4Loaded = await loadPinned(PX4_PIN, argumentValue('--px4'), 'PX4')
const ardupilotLoaded = await loadPinned(ARDUPILOT_PIN, argumentValue('--ardupilot'), 'ArduPilot')
const px4 = px4Catalog(px4Loaded.json, PX4_PIN.ref)
const ardupilot = ardupilotCatalog(ardupilotLoaded.json, ARDUPILOT_PIN.ref)

await mkdir(outputDir, { recursive: true })
await Promise.all([
  writeFile(path.join(outputDir, 'px4.json'), `${JSON.stringify(px4)}\n`),
  writeFile(path.join(outputDir, 'arducopter.json'), `${JSON.stringify(ardupilot)}\n`),
  writeFile(
    path.join(outputDir, 'manifest.json'),
    `${JSON.stringify(
      {
        px4: { ref: PX4_PIN.ref, url: PX4_PIN.url, sha256: px4Loaded.sha256, pinnedAt: PX4_PIN.pinnedAt },
        ardupilot: {
          ref: ARDUPILOT_PIN.ref,
          url: ARDUPILOT_PIN.url,
          sha256: ardupilotLoaded.sha256,
          pinnedAt: ARDUPILOT_PIN.pinnedAt,
        },
      },
      null,
      2,
    )}\n`,
  ),
])

console.log(`PX4: ${Object.keys(px4.parameters).length} enum parameters, ${px4.sets.length} unique option sets`)
console.log(
  `ArduCopter: ${Object.keys(ardupilot.parameters).length} enum parameters, ${ardupilot.sets.length} unique option sets`,
)
