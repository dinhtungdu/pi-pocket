// Capture mono PCM16 at Parakeet's 16 kHz, even when the device uses 44.1 or 48 kHz.
class VoiceCapture extends AudioWorkletProcessor {
    constructor() {
        super();
        this.ratio = sampleRate / 16000;
        this.phase = 0;
        this.sum = 0;
        this.count = 0;
        this.pcm = new Int16Array(320);
        this.used = 0;
    }

    process(inputs) {
        const input = inputs[0]?.[0];

        if (!input) {
            return true;
        }

        for (const sample of input) {
            this.sum += sample;
            this.count++;
            this.phase++;

            if (this.phase >= this.ratio) {
                const value = Math.max(-1, Math.min(1, this.sum / this.count));

                this.pcm[this.used++] = Math.round(value * 32767);
                this.phase -= this.ratio;
                this.sum = 0;
                this.count = 0;

                if (this.used === this.pcm.length) {
                    // DataView keeps the wire format little-endian on every device.
                    const bytes = new ArrayBuffer(this.pcm.length * 2);
                    const view = new DataView(bytes);

                    for (let i = 0; i < this.pcm.length; i++) {
                        view.setInt16(i * 2, this.pcm[i], true);
                    }

                    this.port.postMessage(bytes, [bytes]);
                    this.used = 0;
                }
            }
        }

        return true;
    }
}

registerProcessor("voice-capture", VoiceCapture);
