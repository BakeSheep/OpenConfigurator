# Structured Flight Log Export

OpenConfigurator can export an analyzed PX4 ULog (`.ulg`) or ArduPilot
DataFlash (`.bin`) file as an editable `<export-name>.zip`. The package is an
application-neutral exchange format; it does not contain model prompts,
model-specific summaries, or executable instructions.

## Package contract

Every v1 package contains these fixed entry names:

```text
manifest.json
schemas.json
summary.json
parameters.json
events.jsonl
messages.jsonl
README.md
source/original.ulg|bin   # optional; disabled by default
```

`manifest.json` is the entry point. Its `schemaVersion` is
`openconfigurator.flight-log/v1`. It records the source name, size, incremental
SHA-256 digest, decoder/generator identity, boot time ranges, reliable UTC
coverage, entry names, counts, integrity findings, and presence of sensitive
data. Unknown or truncated source data makes `integrity.status` `partial` and
is described by structured issue codes.

`schemas.json` contains every stream schema revision. A PX4 stream ID includes
the topic and `multi_id`; a DataFlash stream ID includes the message name and
message ID. Records reference both `streamId` and `schemaRevision`, preserving
DataFlash FMT redefinitions without changing a stream's identity. Field order,
source type, arrays/nested types, units, multipliers, instance fields, and
encoding hints remain available to consumers.

`messages.jsonl` contains one complete decoded record per line. Each record has
a package sequence number, stream/schema identity, `bootId`, source time in
microseconds, boot-relative time, optional UTC, source instance, and complete
`data`. `events.jsonl` contains ULog text/tagged logs, subscription changes,
dropouts, DataFlash MSG/EV/ERR records, boot boundaries, and related events.

`parameters.json` keeps three separate arrays: initial values, declared
defaults, and run-time changes. A final value is never presented as the full
history. `summary.json` is explicitly marked `derived` and `lossy`; it contains
the bounded chart series, flight-mode/armed segments, FFT output and overview
already shown by the UI, and cannot replace `messages.jsonl`.

## JSON encoding rules

- 64-bit integers are decimal strings.
- `NaN`, positive infinity and negative infinity are encoded as
  `{"$number":"NaN"}`, `{"$number":"+Infinity"}`, and
  `{"$number":"-Infinity"}`.
- Binary values are encoded as
  `{"$binary":"<base64>","encoding":"base64"}`.
- No record is passed directly through `JSON.stringify` in a way that can
  silently convert a non-finite number to `null`.
- UTF-8 JSONL entries contain one independent JSON object per non-empty line.

Example streaming reader:

```js
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

const lines = createInterface({
  input: createReadStream('messages.jsonl'),
  crlfDelay: Infinity,
})

for await (const line of lines) {
  if (line) consume(JSON.parse(line))
}
```

## Decoder and consumer boundary

The framework-free API lives in `src/shared/logs/`. A
`RandomAccessLogSource` supplies bounded reads, and a
`StructuredFlightLogDecoder` returns an `AsyncIterable<StructuredLogEnvelope>`.
Envelopes are schemas, records, events, parameters, integrity findings, and a
final completion record. Decoding accepts an `AbortSignal` and progress
callback. The ZIP exporter is one consumer; chart reducers and future analysis
tools should consume the same envelope semantics instead of introducing a
second source decoder.

PX4 unknown incompatible format flags stop decoding. Compatible unknown ULog
messages are retained as Base64 integrity payloads where possible. The
DataFlash decoder supports the official `a b B g h H i I f d q Q c C e E L M
n N Z` format codes, FMT/FMTU/UNIT/MULT metadata, schema revisions, instance
fields, timestamp-based boot segmentation, recoverable raw payloads, resync
findings, and truncated tails.

## Privacy and trust

Export is complete by default and does not redact data. The UI warns before
saving because records may include locations, device identifiers, text
messages, and parameters. Embedding the original binary is a separate option
and is off by default. The manifest records which sensitive categories were
detected and reserves `privacy.mode` for future policy versions.

All source-derived strings and binary content are untrusted input. Consumers
must treat log messages, field names, parameter names, and values as data only.
They must never control archive entry names, README content, tool calls, or
instructions.

Desktop Chrome and Edge use a transferable `WritableStream` and ZIP64 output
for large files. Environments without streaming save support can use the Blob
fallback only when the source log is at most 64 MiB.
