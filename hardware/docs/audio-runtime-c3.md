# Audio Runtime V1 on the existing ESP32-C3 module

## Decision

Audio Runtime V1 keeps the current ESP32-C3-MINI-1, MAX98357A, CAN bus,
connector, and `AUDIO_SET_TONE` / `AUDIO_STOP` commands. It does not embed
Faust and it does not accept arbitrary native code.

Instead, the firmware contains a small, statically allocated subtractive
synthesis rack. A host-side tool validates a JSON patch, encodes it as a
compact `WBAP` profile, and sends it through the existing 224-byte
`SYS_CONFIG` transport. Updating a patch therefore does not rebuild or flash
firmware.

Faust remains a future build-time source for individual DSP nodes. The runtime
and wire format must not depend on Faust-generated class names, UI paths, or
compiler versions.

## Why V1 does not need Faust

The first engineering risks are transport, bounded resource use, real-time
scheduling, click-free parameter changes, persistence, and rollback. Faust
generates DSP implementations but does not solve these runtime contracts.
Introducing it before those contracts are stable would add another build and
debugging boundary without making patch replacement safer.

The first rack therefore uses handwritten nodes whose memory and execution
costs are easy to inspect. After the runtime is measured on hardware, one
complex node such as a ladder filter can be generated with Faust and wrapped
behind the same node interface for an A/B resource comparison.

## V1 signal path

```text
                    +-------------------- LFO -------------------+
                    |                                             |
Oscillator A ---+   |                                             v
                +-> Mixer -> optional low-pass -> optional Delay -> Gain -> I2S
Oscillator B ---+                         ^
Noise ----------+                         |
                                      patch state

CAN/ECA AUDIO_SET_TONE -> target pitch and amplitude -> local smoothing
SYS_CONFIG WBAP        -> validated patch -> block-boundary replacement
```

The rack is deliberately fixed. A patch changes waveform selection, mix,
detune, filter, LFO, delay, envelope, and master-gain values. It cannot create
an unbounded graph or allocate an arbitrary number of voices.

## Hard resource budget

| Resource | V1 bound |
|---|---:|
| Sample rate | 22,050 Hz |
| Audio block | 64 mono frames, duplicated to I2S stereo |
| Oscillators | 2 |
| Noise sources | 1 |
| Filters | 1 biquad |
| LFOs | 1 |
| Delay lines | 1, 2,048 `int16_t` samples (~92 ms maximum) |
| Patch payload | 42 bytes of the 224-byte `SYS_CONFIG` limit |
| Dynamic allocation in render path | 0 bytes |
| Large static audio storage | 4,096-byte delay + 512-byte sine table |

The render loop performs no CAN transmission, logging, NVS write, heap
allocation, or patch decoding. Configuration is decoded between blocks and a
complete validated struct replaces the active patch before the next block.

## AudioPatch V1 wire format

The binary profile is little-endian and starts with `WBAP`.

| Offset | Bytes | Field |
|---:|---:|---|
| 0 | 4 | magic `WBAP` |
| 4 | 1 | version (`1`) |
| 5 | 1 | flags |
| 6 | 4 | configuration revision |
| 10 | 6 | oscillator A/B waveform, mix, noise, octave, detune |
| 16 | 4 | filter mode, cutoff, resonance |
| 20 | 5 | LFO waveform, target mask, rate, depth |
| 25 | 7 | ADSR values |
| 32 | 4 | delay time, feedback, wet mix |
| 36 | 2 | master gain, reserved |
| 38 | 4 | FNV-1a checksum over bytes 0--37 |

Unknown versions, flags, enum values, out-of-range times/frequencies, incorrect
lengths, and incorrect checksums are rejected. A rejected patch never replaces
the active patch.

## Compatibility

- Existing ECA programs continue to send `AUDIO_SET_TONE(frequency, amplitude)`.
- Existing stop/lease behavior remains authoritative; `AUDIO_STOP` is a hard
  safety mute.
- With no stored `WBAP` profile, the module boots a conservative default patch.
- The patch is stored in the audio module's NVS and restored at boot.
- The Hub addresses patch uploads by stable module UID, never by public slot.

## Development tool

`frontend/tools/audio_patch.py` is the reference compiler and inspector:

```bash
# Validate and compile JSON; print the Hub command.
python frontend/tools/audio_patch.py compile \
  frontend/tools/audio_patches/moog_voice.json --uid C0FFEE01

# Write the binary profile as well.
python frontend/tools/audio_patch.py compile patch.json \
  --output patch.wbap --uid C0FFEE01

# Decode and inspect an existing profile.
python frontend/tools/audio_patch.py inspect patch.wbap

# Send directly when the bridge is not holding the serial port.
python frontend/tools/audio_patch.py upload patch.json \
  --uid C0FFEE01 --port /dev/cu.usbmodemXXXX
```

The generated Hub command is:

```text
$AP <uidHex> <base64-WBAP>
```

The Hub reports acceptance first and module persistence second:

```text
$OK AP <uid> rev=<revision> bytes=42
$AP,ACK,<uid>,0,<revision>
```

Audio-module ACK status `30` means the payload failed validation; status `31`
means the patch became active for the current boot but could not be persisted
to NVS.

## Faust-ready boundary

Future generated nodes should be wrapped behind a stable interface equivalent
to:

```cpp
class DspNode {
public:
    virtual void init(uint32_t sampleRate) = 0;
    virtual void reset() = 0;
    virtual void setParam(uint8_t paramId, float value) = 0;
    virtual void process(const float* input, float* output,
                         uint16_t frames) = 0;
};
```

The actual embedded implementation may use templates or function tables rather
than C++ virtual dispatch. The important contract is stable numeric node and
parameter IDs with caller-owned buffers and no allocation in `process()`.

Faust adoption is gated on measurements, not only successful compilation:

1. Flash and static RAM delta against the handwritten node.
2. Worst-case render time for a 64-frame block.
3. Audible equivalence or improvement.
4. No heap allocation or locks in the render path.
5. Identical patch and parameter semantics in browser preview and hardware.

## Current build verification

Using Arduino ESP32 core 3.3.10 and the `esp32:esp32:esp32c3` target, the first
V1 implementation compiles at:

| Firmware | Flash | Static/global RAM |
|---|---:|---:|
| Audio module | 1,028,559 bytes (78%) | 48,584 bytes (14%) |
| Wired Hub | 655,569 bytes (50%) | 68,732 bytes (20%) |
| Wi-Fi Hub | 1,265,745 bytes (96%) | 95,412 bytes (29%) |

These are compile-time totals, not on-hardware timing measurements. The Wi-Fi
Hub result is also a hard warning: future audio DSP and Faust-generated code
belong in the audio module or host tooling, never in the Hub image.

## Future work

1. Measure worst-case block render time, I2S short writes, and click/pop level
   on the physical C3/MAX98357A module.
2. Add a two-state patch handoff with a short gain ramp so filter/delay state
   resets cannot click during live patch changes.
3. Add live parameter messages for performance controls while retaining WBAP
   as the persisted snapshot.
4. Generate one bounded node (most likely a ladder-style low-pass) with Faust
   at development time, wrap it behind stable numeric parameters, and compare
   its Flash/RAM/block-time cost against the handwritten biquad.
5. Only after those measurements, decide whether a later hardware revision
   should raise sample rate, add polyphony/audio input, or host a larger graph.

## Deliberate V1 exclusions

- Arbitrary graph topology and feedback loops.
- Audio samples streamed over CAN.
- Polyphony beyond the two fixed oscillators.
- Audio input or effects on external audio (the current hardware is output-only).
- On-device Faust compilation, LLVM, WebAssembly, and dynamic native loading.
- Claims of seamless switching before click/pop and underrun tests pass on the
  physical module.
