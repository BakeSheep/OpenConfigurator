import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const PX4_SOURCE = 'https://github.com/mavlink/qgroundcontrol/raw/refs/heads/master/src/FirmwarePlugin/PX4/PX4ParameterFactMetaData.json'
const ARDUPILOT_SOURCE = 'https://autotest.ardupilot.org/Parameters/Copter/apm.pdef.json'
const outputDir = path.resolve('src/shared/data/parameterEnums')

function argumentValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : null
}

async function loadJson(localPath, source) {
  if (localPath) return JSON.parse(await readFile(path.resolve(localPath), 'utf8'))
  const response = await fetch(source)
  if (!response.ok) throw new Error(`Failed to download ${source}: HTTP ${response.status}`)
  return response.json()
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

function px4Catalog(json) {
  const entries = []
  for (const parameter of json.parameters ?? []) {
    // Match QGC's editor rule: bitmasks are multi-select values, not enums.
    if (!Array.isArray(parameter.values) || Array.isArray(parameter.bitmask)) continue
    entries.push([
      parameter.name,
      parameter.values.map(({ value, description }) => [Number(value), String(description)]),
    ])
  }
  return compactCatalog(PX4_SOURCE, entries)
}

function ardupilotCatalog(json) {
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
  return compactCatalog(ARDUPILOT_SOURCE, entriesByName.entries())
}

const px4 = px4Catalog(await loadJson(argumentValue('--px4'), PX4_SOURCE))
const ardupilot = ardupilotCatalog(await loadJson(argumentValue('--ardupilot'), ARDUPILOT_SOURCE))

await mkdir(outputDir, { recursive: true })
await Promise.all([
  writeFile(path.join(outputDir, 'px4.json'), `${JSON.stringify(px4)}\n`),
  writeFile(path.join(outputDir, 'arducopter.json'), `${JSON.stringify(ardupilot)}\n`),
])

console.log(`PX4: ${Object.keys(px4.parameters).length} enum parameters, ${px4.sets.length} unique option sets`)
console.log(`ArduCopter: ${Object.keys(ardupilot.parameters).length} enum parameters, ${ardupilot.sets.length} unique option sets`)
