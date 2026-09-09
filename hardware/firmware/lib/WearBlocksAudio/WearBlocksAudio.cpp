#include "WearBlocksAudio.h"

static void writeU16LE(uint8_t* p, uint16_t v) {
    p[0] = (uint8_t)(v & 0xFF);
    p[1] = (uint8_t)((v >> 8) & 0xFF);
}

static void writeU32LE(uint8_t* p, uint32_t v) {
    p[0] = (uint8_t)(v & 0xFF);
    p[1] = (uint8_t)((v >> 8) & 0xFF);
    p[2] = (uint8_t)((v >> 16) & 0xFF);
    p[3] = (uint8_t)((v >> 24) & 0xFF);
}

static uint16_t readU16LE(const uint8_t* p) {
    return (uint16_t)p[0] | ((uint16_t)p[1] << 8);
}

static uint32_t readU32LE(const uint8_t* p) {
    return (uint32_t)p[0] |
           ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) |
           ((uint32_t)p[3] << 24);
}

uint32_t wbAudioFnv1a32(const uint8_t* data, size_t len) {
    uint32_t h = 2166136261UL;
    for (size_t i = 0; i < len; i++) {
        h ^= data[i];
        h *= 16777619UL;
    }
    return h;
}

void wbAudioPatchDefaults(WBAudioPatch& patch) {
    memset(&patch, 0, sizeof(patch));
    patch.version = WB_AUDIO_PATCH_VERSION;
    patch.flags = 0;
    patch.oscAWave = WB_AUDIO_WAVE_SINE;
    patch.oscBWave = WB_AUDIO_WAVE_OFF;
    patch.oscMix = 0;
    patch.noiseMix = 0;
    patch.filterMode = WB_AUDIO_FILTER_BYPASS;
    patch.filterCutoffHz = 2000;
    patch.filterResonance = 32;
    patch.lfoWave = WB_AUDIO_WAVE_SINE;
    patch.lfoTargetMask = 0;
    patch.lfoRateCentiHz = 200;
    patch.lfoDepth = 0;
    patch.attackMs = 5;
    patch.decayMs = 80;
    patch.sustain = 220;
    patch.releaseMs = 120;
    patch.delayMs = 0;
    patch.delayFeedback = 0;
    patch.delayMix = 0;
    patch.masterGain = 220;
}

bool wbAudioPatchIsPayload(const uint8_t* data, uint16_t len) {
    return data && len == WB_AUDIO_PATCH_ENCODED_LEN &&
           data[0] == 'W' && data[1] == 'B' &&
           data[2] == 'A' && data[3] == 'P';
}

bool wbAudioPatchValidate(const WBAudioPatch& patch) {
    if (patch.version != WB_AUDIO_PATCH_VERSION) return false;
    if ((patch.flags & ~WB_AUDIO_PATCH_KNOWN_FLAGS) != 0) return false;
    if (patch.oscAWave > WB_AUDIO_WAVE_TRIANGLE ||
        patch.oscBWave > WB_AUDIO_WAVE_TRIANGLE ||
        patch.lfoWave == WB_AUDIO_WAVE_OFF ||
        patch.lfoWave > WB_AUDIO_WAVE_TRIANGLE) return false;
    if (patch.oscBOctave < -2 || patch.oscBOctave > 2) return false;
    if (patch.oscBDetuneCents < -100 || patch.oscBDetuneCents > 100) return false;
    if (patch.filterMode > WB_AUDIO_FILTER_LOWPASS) return false;
    if (patch.filterCutoffHz < 40 || patch.filterCutoffHz > 8000) return false;
    if ((patch.lfoTargetMask & ~0x07) != 0) return false;
    if (patch.lfoRateCentiHz < 1 || patch.lfoRateCentiHz > 2000) return false;
    if (patch.attackMs > 5000 || patch.decayMs > 5000 ||
        patch.releaseMs > 5000) return false;
    if (patch.delayMs > 80) return false;
    return true;
}

bool wbAudioPatchEncode(const WBAudioPatch& patch, uint8_t* buffer,
                        uint16_t maxLen, uint16_t& outLen) {
    outLen = 0;
    if (!buffer || maxLen < WB_AUDIO_PATCH_ENCODED_LEN) return false;
    if (!wbAudioPatchValidate(patch)) return false;

    memset(buffer, 0, WB_AUDIO_PATCH_ENCODED_LEN);
    buffer[0] = 'W';
    buffer[1] = 'B';
    buffer[2] = 'A';
    buffer[3] = 'P';
    buffer[4] = patch.version;
    buffer[5] = patch.flags;
    writeU32LE(&buffer[6], patch.configRev);
    buffer[10] = (uint8_t)patch.oscAWave;
    buffer[11] = (uint8_t)patch.oscBWave;
    buffer[12] = patch.oscMix;
    buffer[13] = patch.noiseMix;
    buffer[14] = (uint8_t)patch.oscBOctave;
    buffer[15] = (uint8_t)patch.oscBDetuneCents;
    buffer[16] = (uint8_t)patch.filterMode;
    writeU16LE(&buffer[17], patch.filterCutoffHz);
    buffer[19] = patch.filterResonance;
    buffer[20] = (uint8_t)patch.lfoWave;
    buffer[21] = patch.lfoTargetMask;
    writeU16LE(&buffer[22], patch.lfoRateCentiHz);
    buffer[24] = patch.lfoDepth;
    writeU16LE(&buffer[25], patch.attackMs);
    writeU16LE(&buffer[27], patch.decayMs);
    buffer[29] = patch.sustain;
    writeU16LE(&buffer[30], patch.releaseMs);
    writeU16LE(&buffer[32], patch.delayMs);
    buffer[34] = patch.delayFeedback;
    buffer[35] = patch.delayMix;
    buffer[36] = patch.masterGain;
    buffer[37] = 0;
    writeU32LE(&buffer[38], wbAudioFnv1a32(buffer, 38));
    outLen = WB_AUDIO_PATCH_ENCODED_LEN;
    return true;
}

bool wbAudioPatchDecode(const uint8_t* data, uint16_t len,
                        WBAudioPatch& patch) {
    wbAudioPatchDefaults(patch);
    if (!wbAudioPatchIsPayload(data, len)) return false;
    if (data[4] != WB_AUDIO_PATCH_VERSION || data[37] != 0) return false;
    uint32_t gotCrc = readU32LE(&data[38]);
    if (gotCrc != wbAudioFnv1a32(data, 38)) return false;

    patch.version = data[4];
    patch.flags = data[5];
    patch.configRev = readU32LE(&data[6]);
    patch.oscAWave = (WBAudioWaveform)data[10];
    patch.oscBWave = (WBAudioWaveform)data[11];
    patch.oscMix = data[12];
    patch.noiseMix = data[13];
    patch.oscBOctave = (int8_t)data[14];
    patch.oscBDetuneCents = (int8_t)data[15];
    patch.filterMode = (WBAudioFilterMode)data[16];
    patch.filterCutoffHz = readU16LE(&data[17]);
    patch.filterResonance = data[19];
    patch.lfoWave = (WBAudioWaveform)data[20];
    patch.lfoTargetMask = data[21];
    patch.lfoRateCentiHz = readU16LE(&data[22]);
    patch.lfoDepth = data[24];
    patch.attackMs = readU16LE(&data[25]);
    patch.decayMs = readU16LE(&data[27]);
    patch.sustain = data[29];
    patch.releaseMs = readU16LE(&data[30]);
    patch.delayMs = readU16LE(&data[32]);
    patch.delayFeedback = data[34];
    patch.delayMix = data[35];
    patch.masterGain = data[36];
    return wbAudioPatchValidate(patch);
}
