#ifndef WEARBLOCKS_AUDIO_RACK_H
#define WEARBLOCKS_AUDIO_RACK_H

#include <Arduino.h>
#include <WearBlocksAudio.h>

class AudioRack {
public:
    static constexpr uint32_t SAMPLE_RATE = 22050;
    static constexpr uint16_t BLOCK_FRAMES = 64;
    static constexpr uint16_t DELAY_SAMPLES = 2048;

    AudioRack();

    void begin();
    void setPatch(const WBAudioPatch& patch);
    const WBAudioPatch& patch() const { return _patch; }

    void setTone(float frequencyHz, uint8_t amplitude);
    void noteOff();
    void hardStop();
    void renderStereo(int16_t* output, uint16_t frames);

private:
    enum EnvelopeStage : uint8_t {
        ENV_IDLE = 0,
        ENV_ATTACK,
        ENV_DECAY,
        ENV_SUSTAIN,
        ENV_RELEASE,
    };

    static float clampf(float value, float lo, float hi);
    static int16_t clampSample(float value);
    static uint32_t phaseIncrement(float frequencyHz);

    int16_t oscillatorSample(WBAudioWaveform waveform, uint32_t phase) const;
    float nextEnvelope();
    void enterEnvelopeStage(EnvelopeStage stage);
    void updateFilter(float lfoValue);
    float processFilter(float input);
    float processDelay(float input);
    void clearDelay();

    WBAudioPatch _patch;
    int16_t _sineTable[256];
    int16_t _delay[DELAY_SAMPLES];

    uint32_t _phaseA;
    uint32_t _phaseB;
    uint32_t _phaseLfo;
    uint32_t _noiseState;
    uint16_t _delayWrite;
    uint16_t _activeDelaySamples;

    float _targetFrequency;
    float _currentFrequency;
    float _targetAmplitude;
    float _currentAmplitude;
    float _envelope;
    float _releaseStep;
    EnvelopeStage _envelopeStage;

    float _filterB0;
    float _filterB1;
    float _filterB2;
    float _filterA1;
    float _filterA2;
    float _filterZ1;
    float _filterZ2;
};

#endif
