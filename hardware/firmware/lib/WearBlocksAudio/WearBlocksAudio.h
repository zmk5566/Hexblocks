#ifndef WEARBLOCKS_AUDIO_H
#define WEARBLOCKS_AUDIO_H

#include <Arduino.h>

#define WB_AUDIO_PATCH_VERSION 1
#define WB_AUDIO_PATCH_ENCODED_LEN 42
#define WB_AUDIO_PATCH_MAX_ENCODED 64

#define WB_AUDIO_PATCH_FLAG_ENVELOPE 0x01
#define WB_AUDIO_PATCH_KNOWN_FLAGS WB_AUDIO_PATCH_FLAG_ENVELOPE

enum WBAudioWaveform : uint8_t {
    WB_AUDIO_WAVE_OFF = 0,
    WB_AUDIO_WAVE_SINE = 1,
    WB_AUDIO_WAVE_SAW = 2,
    WB_AUDIO_WAVE_SQUARE = 3,
    WB_AUDIO_WAVE_TRIANGLE = 4,
};

enum WBAudioFilterMode : uint8_t {
    WB_AUDIO_FILTER_BYPASS = 0,
    WB_AUDIO_FILTER_LOWPASS = 1,
};

enum WBAudioLfoTarget : uint8_t {
    WB_AUDIO_LFO_PITCH = 0x01,
    WB_AUDIO_LFO_FILTER = 0x02,
    WB_AUDIO_LFO_AMPLITUDE = 0x04,
};

struct WBAudioPatch {
    uint8_t version;
    uint8_t flags;
    uint32_t configRev;

    WBAudioWaveform oscAWave;
    WBAudioWaveform oscBWave;
    uint8_t oscMix;
    uint8_t noiseMix;
    int8_t oscBOctave;
    int8_t oscBDetuneCents;

    WBAudioFilterMode filterMode;
    uint16_t filterCutoffHz;
    uint8_t filterResonance;

    WBAudioWaveform lfoWave;
    uint8_t lfoTargetMask;
    uint16_t lfoRateCentiHz;
    uint8_t lfoDepth;

    uint16_t attackMs;
    uint16_t decayMs;
    uint8_t sustain;
    uint16_t releaseMs;

    uint16_t delayMs;
    uint8_t delayFeedback;
    uint8_t delayMix;
    uint8_t masterGain;
};

uint32_t wbAudioFnv1a32(const uint8_t* data, size_t len);
void wbAudioPatchDefaults(WBAudioPatch& patch);
bool wbAudioPatchIsPayload(const uint8_t* data, uint16_t len);
bool wbAudioPatchValidate(const WBAudioPatch& patch);
bool wbAudioPatchEncode(const WBAudioPatch& patch, uint8_t* buffer,
                        uint16_t maxLen, uint16_t& outLen);
bool wbAudioPatchDecode(const uint8_t* data, uint16_t len,
                        WBAudioPatch& patch);

#endif
