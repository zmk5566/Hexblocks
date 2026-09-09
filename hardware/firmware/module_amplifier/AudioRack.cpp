#include "AudioRack.h"

#include <math.h>

static const float WB_AUDIO_PI = 3.14159265358979323846f;
static const float WB_AUDIO_PHASE_SCALE = 4294967296.0f;
static const float WB_AUDIO_OUTPUT_PEAK = 20000.0f;

constexpr uint32_t AudioRack::SAMPLE_RATE;
constexpr uint16_t AudioRack::BLOCK_FRAMES;
constexpr uint16_t AudioRack::DELAY_SAMPLES;

AudioRack::AudioRack()
    : _phaseA(0),
      _phaseB(0),
      _phaseLfo(0),
      _noiseState(0x6D2B79F5UL),
      _delayWrite(0),
      _activeDelaySamples(0),
      _targetFrequency(440.0f),
      _currentFrequency(440.0f),
      _targetAmplitude(0.0f),
      _currentAmplitude(0.0f),
      _envelope(0.0f),
      _releaseStep(1.0f),
      _envelopeStage(ENV_IDLE),
      _filterB0(1.0f),
      _filterB1(0.0f),
      _filterB2(0.0f),
      _filterA1(0.0f),
      _filterA2(0.0f),
      _filterZ1(0.0f),
      _filterZ2(0.0f) {
    wbAudioPatchDefaults(_patch);
    memset(_sineTable, 0, sizeof(_sineTable));
    memset(_delay, 0, sizeof(_delay));
}

void AudioRack::begin() {
    for (uint16_t i = 0; i < 256; i++) {
        float phase = 2.0f * WB_AUDIO_PI * (float)i / 256.0f;
        _sineTable[i] = (int16_t)(sinf(phase) * 32767.0f);
    }
    setPatch(_patch);
}

void AudioRack::setPatch(const WBAudioPatch& patch) {
    if (!wbAudioPatchValidate(patch)) return;
    _patch = patch;
    uint32_t delaySamples = ((uint32_t)_patch.delayMs * SAMPLE_RATE) / 1000U;
    if (delaySamples >= DELAY_SAMPLES) delaySamples = DELAY_SAMPLES - 1;
    _activeDelaySamples = (uint16_t)delaySamples;
    _filterZ1 = 0.0f;
    _filterZ2 = 0.0f;
    clearDelay();
    updateFilter(0.0f);
}

void AudioRack::setTone(float frequencyHz, uint8_t amplitude) {
    _targetFrequency = clampf(frequencyHz, 20.0f, 8000.0f);
    float nextAmplitude = (float)amplitude / 255.0f;
    bool wasSilent = _targetAmplitude <= 0.0001f;
    _targetAmplitude = nextAmplitude;
    if (nextAmplitude <= 0.0001f) {
        noteOff();
    } else if (wasSilent) {
        enterEnvelopeStage((_patch.flags & WB_AUDIO_PATCH_FLAG_ENVELOPE)
                           ? ENV_ATTACK : ENV_SUSTAIN);
    }
}

void AudioRack::noteOff() {
    _targetAmplitude = 0.0f;
    if ((_patch.flags & WB_AUDIO_PATCH_FLAG_ENVELOPE) && _envelope > 0.0f) {
        enterEnvelopeStage(ENV_RELEASE);
    } else {
        _envelope = 0.0f;
        _envelopeStage = ENV_IDLE;
    }
}

void AudioRack::hardStop() {
    _targetAmplitude = 0.0f;
    _currentAmplitude = 0.0f;
    _envelope = 0.0f;
    _envelopeStage = ENV_IDLE;
    _filterZ1 = 0.0f;
    _filterZ2 = 0.0f;
    clearDelay();
}

void AudioRack::renderStereo(int16_t* output, uint16_t frames) {
    if (!output || frames == 0) return;

    // Control-rate calculations happen once per block. Sample-rate work below
    // uses only table lookup, additions, and a bounded number of multiplies.
    int16_t lfoRaw = oscillatorSample(_patch.lfoWave, _phaseLfo);
    float lfoValue = (float)lfoRaw / 32768.0f;
    _phaseLfo += phaseIncrement((float)_patch.lfoRateCentiHz / 100.0f) * frames;

    float pitchSemitones = 0.0f;
    if (_patch.lfoTargetMask & WB_AUDIO_LFO_PITCH) {
        pitchSemitones = lfoValue * ((float)_patch.lfoDepth / 255.0f) * 12.0f;
    }
    float pitchRatio = powf(2.0f, pitchSemitones / 12.0f);
    // Smooth control changes at block rate. ECA may update pitch more often
    // than the audio block, and phase is deliberately never reset.
    _currentFrequency += (_targetFrequency - _currentFrequency) * 0.25f;
    float blockFrequency = _currentFrequency * pitchRatio;
    float octaveAndDetune = (float)_patch.oscBOctave +
                            (float)_patch.oscBDetuneCents / 1200.0f;
    float frequencyB = blockFrequency * powf(2.0f, octaveAndDetune);
    uint32_t incrementA = phaseIncrement(blockFrequency);
    uint32_t incrementB = phaseIncrement(frequencyB);

    updateFilter(lfoValue);

    // ADSR release owns the fade duration. Keep the velocity multiplier
    // steady until the envelope reaches idle; otherwise the one-block
    // amplitude smoothing would truncate a multi-second release to ~3 ms.
    float ampTarget = ((_patch.flags & WB_AUDIO_PATCH_FLAG_ENVELOPE) &&
                       _envelopeStage == ENV_RELEASE)
                    ? _currentAmplitude : _targetAmplitude;
    float ampStep = (ampTarget - _currentAmplitude) / (float)frames;
    float mixB = (float)_patch.oscMix / 255.0f;
    float mixA = 1.0f - mixB;
    float noiseMix = (float)_patch.noiseMix / 255.0f;
    float tonalMix = 1.0f - noiseMix;
    float master = ((float)_patch.masterGain / 255.0f) * WB_AUDIO_OUTPUT_PEAK;
    float tremoloDepth = (_patch.lfoTargetMask & WB_AUDIO_LFO_AMPLITUDE)
                       ? (float)_patch.lfoDepth / 255.0f : 0.0f;
    float tremolo = 1.0f - tremoloDepth * (0.5f - 0.5f * lfoValue);

    for (uint16_t i = 0; i < frames; i++) {
        _currentAmplitude += ampStep;

        int16_t a = oscillatorSample(_patch.oscAWave, _phaseA);
        int16_t b = oscillatorSample(_patch.oscBWave, _phaseB);
        _phaseA += incrementA;
        _phaseB += incrementB;

        // xorshift32: deterministic, four bytes of state, no heap or tables.
        _noiseState ^= _noiseState << 13;
        _noiseState ^= _noiseState >> 17;
        _noiseState ^= _noiseState << 5;
        int16_t noise = (int16_t)(_noiseState >> 16);

        float tonal = ((float)a * mixA + (float)b * mixB) / 32768.0f;
        float sample = tonal * tonalMix + ((float)noise / 32768.0f) * noiseMix;
        sample = processFilter(sample);
        sample = processDelay(sample);

        float envelope = (_patch.flags & WB_AUDIO_PATCH_FLAG_ENVELOPE)
                       ? nextEnvelope()
                       : (_targetAmplitude > 0.0f ? 1.0f : 0.0f);
        float scaled = sample * master * _currentAmplitude * envelope * tremolo;
        int16_t pcm = clampSample(scaled);
        output[i * 2] = pcm;
        output[i * 2 + 1] = pcm;
    }
}

float AudioRack::clampf(float value, float lo, float hi) {
    if (value < lo) return lo;
    if (value > hi) return hi;
    return value;
}

int16_t AudioRack::clampSample(float value) {
    if (value > 32767.0f) return 32767;
    if (value < -32768.0f) return -32768;
    return (int16_t)value;
}

uint32_t AudioRack::phaseIncrement(float frequencyHz) {
    frequencyHz = clampf(frequencyHz, 0.0f, (float)SAMPLE_RATE * 0.45f);
    return (uint32_t)(frequencyHz * WB_AUDIO_PHASE_SCALE / (float)SAMPLE_RATE);
}

int16_t AudioRack::oscillatorSample(WBAudioWaveform waveform, uint32_t phase) const {
    switch (waveform) {
        case WB_AUDIO_WAVE_SINE:
            return _sineTable[phase >> 24];
        case WB_AUDIO_WAVE_SAW:
            return (int16_t)((int32_t)(phase >> 16) - 32768);
        case WB_AUDIO_WAVE_SQUARE:
            return (phase & 0x80000000UL) ? 32767 : -32768;
        case WB_AUDIO_WAVE_TRIANGLE: {
            uint16_t x = (uint16_t)(phase >> 16);
            int32_t y = (x < 32768)
                      ? -32768 + (int32_t)x * 2
                      : 32767 - (int32_t)(x - 32768) * 2;
            return (int16_t)y;
        }
        case WB_AUDIO_WAVE_OFF:
        default:
            return 0;
    }
}

void AudioRack::enterEnvelopeStage(EnvelopeStage stage) {
    _envelopeStage = stage;
    if (stage == ENV_ATTACK && _patch.attackMs == 0) {
        _envelope = 1.0f;
        _envelopeStage = ENV_DECAY;
    } else if (stage == ENV_RELEASE) {
        uint32_t samples = max((uint32_t)1,
                               ((uint32_t)_patch.releaseMs * SAMPLE_RATE) / 1000U);
        _releaseStep = _envelope / (float)samples;
    } else if (stage == ENV_SUSTAIN) {
        _envelope = 1.0f;
    }
}

float AudioRack::nextEnvelope() {
    float sustain = (float)_patch.sustain / 255.0f;
    switch (_envelopeStage) {
        case ENV_ATTACK: {
            uint32_t samples = max((uint32_t)1,
                                   ((uint32_t)_patch.attackMs * SAMPLE_RATE) / 1000U);
            _envelope += 1.0f / (float)samples;
            if (_envelope >= 1.0f) {
                _envelope = 1.0f;
                _envelopeStage = ENV_DECAY;
            }
            break;
        }
        case ENV_DECAY: {
            uint32_t samples = max((uint32_t)1,
                                   ((uint32_t)_patch.decayMs * SAMPLE_RATE) / 1000U);
            _envelope -= (1.0f - sustain) / (float)samples;
            if (_envelope <= sustain) {
                _envelope = sustain;
                _envelopeStage = ENV_SUSTAIN;
            }
            break;
        }
        case ENV_SUSTAIN:
            _envelope = sustain;
            break;
        case ENV_RELEASE:
            _envelope -= _releaseStep;
            if (_envelope <= 0.0f) {
                _envelope = 0.0f;
                _envelopeStage = ENV_IDLE;
            }
            break;
        case ENV_IDLE:
        default:
            _envelope = 0.0f;
            break;
    }
    return _envelope;
}

void AudioRack::updateFilter(float lfoValue) {
    if (_patch.filterMode == WB_AUDIO_FILTER_BYPASS) {
        _filterB0 = 1.0f;
        _filterB1 = _filterB2 = _filterA1 = _filterA2 = 0.0f;
        return;
    }

    float cutoff = (float)_patch.filterCutoffHz;
    if (_patch.lfoTargetMask & WB_AUDIO_LFO_FILTER) {
        float octaves = lfoValue * ((float)_patch.lfoDepth / 255.0f) * 4.0f;
        cutoff *= powf(2.0f, octaves);
    }
    cutoff = clampf(cutoff, 40.0f, (float)SAMPLE_RATE * 0.42f);
    float q = 0.5f + ((float)_patch.filterResonance / 255.0f) * 7.5f;
    float omega = 2.0f * WB_AUDIO_PI * cutoff / (float)SAMPLE_RATE;
    float cosOmega = cosf(omega);
    float alpha = sinf(omega) / (2.0f * q);
    float a0 = 1.0f + alpha;
    _filterB0 = ((1.0f - cosOmega) * 0.5f) / a0;
    _filterB1 = (1.0f - cosOmega) / a0;
    _filterB2 = _filterB0;
    _filterA1 = (-2.0f * cosOmega) / a0;
    _filterA2 = (1.0f - alpha) / a0;
}

float AudioRack::processFilter(float input) {
    if (_patch.filterMode == WB_AUDIO_FILTER_BYPASS) return input;
    float output = _filterB0 * input + _filterZ1;
    _filterZ1 = _filterB1 * input - _filterA1 * output + _filterZ2;
    _filterZ2 = _filterB2 * input - _filterA2 * output;
    return clampf(output, -2.0f, 2.0f);
}

float AudioRack::processDelay(float input) {
    if (_activeDelaySamples == 0 || _patch.delayMix == 0) return input;
    uint16_t read = (uint16_t)((_delayWrite + DELAY_SAMPLES -
                                _activeDelaySamples) % DELAY_SAMPLES);
    float delayed = (float)_delay[read] / 32768.0f;
    float feedback = (float)_patch.delayFeedback / 255.0f * 0.92f;
    _delay[_delayWrite] = clampSample((input + delayed * feedback) * 32767.0f);
    _delayWrite = (uint16_t)((_delayWrite + 1) % DELAY_SAMPLES);
    float wet = (float)_patch.delayMix / 255.0f;
    return input * (1.0f - wet) + delayed * wet;
}

void AudioRack::clearDelay() {
    memset(_delay, 0, sizeof(_delay));
    _delayWrite = 0;
}
