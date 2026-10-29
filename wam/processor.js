// The synth's AudioWorkletProcessor: runs the sound (wam-synth-dsp, a wasm module compiled on the
// main thread and passed in) and implements the processor side of the WAM 2.0 API.
//
// Events (MIDI, automation) are applied at their sample within the block. What the sound changes
// on its own (a host's automation) and the events it processed go back to the node; the output
// level goes through a SharedArrayBuffer when the page is cross-origin isolated, and in a message
// about 30 times a second when it is not.

const PARAMS = ['cutoff', 'resonance', 'attack', 'release', 'volume', 'bend', 'modulation'];
const LEVEL_INTERVAL = 1 / 30;

class CrazyPanelsSynthProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const o = options.processorOptions;
        this.groupId = o.groupId;
        this.moduleId = o.moduleId;
        this.instanceId = o.instanceId;
        this.alive = false;
        try {
            this.dsp = new WebAssembly.Instance(new WebAssembly.Module(o.dsp), {}).exports;
        } catch (e) {
            this.port.postMessage({ type: 'error', message: `the sound's wasm does not load: ${e}` });
            return;
        }
        this.synth = this.dsp.synth_new(sampleRate);
        this.values = PARAMS.map((id) => o.values[id]);
        this.values.forEach((v, i) => this.dsp.synth_set(this.synth, i, v));
        this.level = o.level ? new Float32Array(o.level) : null;
        this.lastLevel = 0;
        /** Pending events, by time. */
        this.events = [];
        /** Processed this block, for the node's listeners. */
        this.processed = [];
        this.alive = true;
        this.port.onmessage = (e) => this.onMessage(e.data);
        // Join the host's WAM environment, for events between modules (a sequencer playing it)
        try {
            globalThis.webAudioModules?.addWam(this);
        } catch (e) {
            console.warn('crazy-panels synth: not in a WAM group', e);
        }
    }

    onMessage(m) {
        switch (m.type) {
            case 'set':
                this.set(m.id, m.value);
                break;
            case 'events':
                this.scheduleEvents(...m.events);
                break;
            case 'clear':
                this.clearEvents();
                break;
            case 'connect':
                globalThis.webAudioModules?.connectEvents(this.groupId, this.instanceId, m.to, m.output);
                break;
            case 'disconnect':
                globalThis.webAudioModules?.disconnectEvents(this.groupId, this.instanceId, m.to, m.output);
                break;
            case 'destroy':
                this.destroy();
                break;
        }
    }

    set(id, value) {
        const i = PARAMS.indexOf(id);
        if (i < 0 || !Number.isFinite(value)) return;
        this.values[i] = Math.min(1, Math.max(0, value));
        this.dsp.synth_set(this.synth, i, this.values[i]);
    }

    // --- WamProcessor ------------------------------------------------------------------------

    getCompensationDelay() {
        return 0;
    }

    scheduleEvents(...events) {
        this.events.push(...events);
        this.events.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
    }

    emitEvents(...events) {
        globalThis.webAudioModules?.emitEvents(this, ...events);
    }

    clearEvents() {
        this.events.length = 0;
    }

    destroy() {
        if (!this.alive || !this.dsp) return;
        this.alive = false;
        try {
            globalThis.webAudioModules?.removeWam(this);
        } catch {
            // It never joined
        }
        this.dsp.synth_free(this.synth);
        this.port.close();
    }

    apply(event) {
        switch (event.type) {
            case 'wam-midi':
            case 'wam-mpe': {
                const [status, data1 = 0, data2 = 0] = event.data.bytes;
                this.dsp.synth_midi(this.synth, status, data1, data2);
                break;
            }
            case 'wam-automation': {
                const { id, value } = event.data;
                // Every parameter goes from 0 to 1: normalized and plain values are the same
                this.set(id, value);
                break;
            }
            default:
                return;
        }
        this.processed.push(event);
    }

    // --- Audio -------------------------------------------------------------------------------

    /** Renders `frames` samples into the outputs from `at`. */
    render(outputs, at, frames) {
        if (frames <= 0) return;
        const ptr = this.dsp.synth_process(this.synth, frames);
        // The module's memory may have grown: a fresh view each time
        const out = new Float32Array(this.dsp.memory.buffer, ptr, frames * 2);
        const [left, right] = outputs;
        for (let i = 0; i < frames; i++) {
            left[at + i] = out[2 * i];
            if (right) right[at + i] = out[2 * i + 1];
        }
    }

    process(inputs, outputs) {
        // Not loaded (or destroyed): silence, and no more calls
        if (!this.alive) return false;
        const output = outputs[0];
        if (!output || !output[0]) return true;
        const frames = output[0].length;
        // Events due in this block, each at its sample
        let at = 0;
        while (this.events.length) {
            const event = this.events[0];
            const offset = Math.round(((event.time ?? 0) - currentTime) * sampleRate);
            if (offset >= frames) break;
            const until = Math.max(at, Math.min(frames, offset));
            this.render(output, at, until - at);
            at = until;
            this.apply(this.events.shift());
        }
        this.render(output, at, frames - at);

        const level = this.dsp.synth_level(this.synth);
        if (this.level) {
            this.level[0] = level;
        } else if (currentTime - this.lastLevel >= LEVEL_INTERVAL) {
            this.lastLevel = currentTime;
            this.port.postMessage({ type: 'level', value: level });
        }
        if (this.processed.length) {
            this.port.postMessage({ type: 'processed', events: this.processed });
            this.processed = [];
        }
        return true;
    }
}

registerProcessor('crazy-panels-synth', CrazyPanelsSynthProcessor);
