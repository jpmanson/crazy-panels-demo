// The crazy-panels synth as a Web Audio Module 2.0: this file's default export is the module's
// class, as WAM hosts expect. Written against the WAM 2.0 API (@webaudiomodules/api, MIT); it
// does not use the SDK's node and processor, so as to stay within permissive licenses.
//
// A host loads it with `const { default: Wam } = await import('…/wam/index.js')`, then
// `await Wam.createInstance(groupId, audioContext)`, connects `instance.audioNode`, and shows
// `await instance.createGui()`.

const here = (path) => new URL(path, import.meta.url).href;

/** The parameters: all normalized, 0 to 1, with the panel's defaults. */
const PARAMS = [
    { id: 'cutoff', label: 'Cutoff', defaultValue: 0.6, units: 'Hz', text: (v) => hz(v) },
    { id: 'resonance', label: 'Resonance', defaultValue: 0.3, units: '%', text: (v) => percent(v) },
    { id: 'attack', label: 'Attack', defaultValue: 0.1, units: '%', text: (v) => percent(v) },
    { id: 'release', label: 'Release', defaultValue: 0.4, units: '%', text: (v) => percent(v) },
    { id: 'volume', label: 'Volume', defaultValue: 0.8, units: '%', text: (v) => percent(v) },
];

function hz(v) {
    const f = 20 * Math.pow(1000, v);
    return f >= 1000 ? `${(f / 1000).toFixed(1)} kHz` : `${Math.round(f)} Hz`;
}

function percent(v) {
    return `${Math.round(v * 100)} %`;
}

/** A parameter's description, as `WamParameterInfo`. */
class ParameterInfo {
    constructor(p) {
        this.id = p.id;
        this.label = p.label;
        this.type = 'float';
        this.defaultValue = p.defaultValue;
        this.minValue = 0;
        this.maxValue = 1;
        this.discreteStep = 0;
        this.exponent = 0;
        this.choices = [];
        this.units = p.units;
        this.text = p.text;
    }

    normalize(value) {
        return value;
    }

    denormalize(value) {
        return value;
    }

    valueString(value) {
        return this.text(value);
    }
}

const INFO = Object.fromEntries(PARAMS.map((p) => [p.id, new ParameterInfo(p)]));

/** The sound's wasm, compiled once per page. */
let dspModule;
/** The processor's code, added once per audio context. */
const processorLoaded = new WeakMap();

/** The module's node: an AudioWorkletNode with the `WamNode` methods. */
export class CrazyPanelsSynthNode extends AudioWorkletNode {
    constructor(module, options) {
        super(module.audioContext, 'crazy-panels-synth', options);
        this.module = module;
        this.groupId = module.groupId;
        this.moduleId = module.moduleId;
        this.instanceId = module.instanceId;
        this.values = { ...options.processorOptions.values };
        const level = options.processorOptions.level;
        this.levelView = level ? new Float32Array(level) : null;
        this.lastLevel = 0;
        /** The GUI's listeners for parameter changes that did not come from it. */
        this.paramListeners = new Set();
        this.port.onmessage = (e) => this.onMessage(e.data);
    }

    onMessage(m) {
        if (m.type === 'level') {
            this.lastLevel = m.value;
        } else if (m.type === 'processed') {
            for (const event of m.events) {
                if (event.type === 'wam-automation') this.changed(event.data.id, event.data.value);
                this.dispatchEvent(new CustomEvent(event.type, { detail: event }));
            }
        }
    }

    changed(id, value) {
        if (!(id in INFO)) return;
        this.values[id] = value;
        for (const listener of this.paramListeners) listener(id, value);
    }

    // --- WamNode -----------------------------------------------------------------------------

    async getParameterInfo(...ids) {
        if (!ids.length) ids = Object.keys(INFO);
        return Object.fromEntries(ids.filter((id) => id in INFO).map((id) => [id, INFO[id]]));
    }

    async getParameterValues(normalized, ...ids) {
        if (!ids.length) ids = Object.keys(INFO);
        return Object.fromEntries(
            ids.filter((id) => id in INFO).map((id) => [id, { id, value: this.values[id], normalized: !!normalized }]),
        );
    }

    async setParameterValues(values) {
        for (const { id, value, normalized } of Object.values(values)) {
            const info = INFO[id];
            if (!info) continue;
            const v = normalized ? value : info.normalize(value);
            this.port.postMessage({ type: 'set', id, value: v });
            this.changed(id, v);
        }
    }

    async getState() {
        return { values: { ...this.values } };
    }

    async setState(state) {
        const values = state?.values ?? {};
        await this.setParameterValues(
            Object.fromEntries(Object.entries(values).map(([id, value]) => [id, { id, value, normalized: true }])),
        );
    }

    async getCompensationDelay() {
        return 0;
    }

    scheduleEvents(...events) {
        this.port.postMessage({ type: 'events', events });
    }

    clearEvents() {
        this.port.postMessage({ type: 'clear' });
    }

    connectEvents(to, output = 0) {
        this.port.postMessage({ type: 'connect', to, output });
    }

    disconnectEvents(to, output) {
        this.port.postMessage({ type: 'disconnect', to, output });
    }

    destroy() {
        this.port.postMessage({ type: 'destroy' });
        this.disconnect();
        this.paramListeners.clear();
    }

    // --- For the GUI ---------------------------------------------------------------------------

    /** A value from the panel: to the sound, without telling the panel back. */
    setFromGui(id, value) {
        if (!(id in INFO)) return;
        this.values[id] = value;
        this.port.postMessage({ type: 'set', id, value });
    }

    /** The output level now. */
    level() {
        return this.levelView ? this.levelView[0] : this.lastLevel;
    }
}

/** The module, as `WebAudioModule`. */
export default class CrazyPanelsSynth {
    static isWebAudioModuleConstructor = true;

    static async createInstance(groupId, audioContext, initialState) {
        return new this(groupId, audioContext).initialize(initialState);
    }

    constructor(groupId, audioContext) {
        this.groupId = groupId;
        this.audioContext = audioContext;
        this.audioNode = null;
        this.initialized = false;
        this.descriptor = null;
        this._instanceId = null;
    }

    get isWebAudioModule() {
        return true;
    }

    get moduleId() {
        return this.descriptor?.identifier ?? 'com.crazy-panels.synth';
    }

    get instanceId() {
        this._instanceId ??= `${this.moduleId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        return this._instanceId;
    }

    get name() {
        return this.descriptor?.name ?? 'crazy-panels synth';
    }

    get vendor() {
        return this.descriptor?.vendor ?? 'crazy-panels';
    }

    async initialize(state) {
        this.descriptor ??= await (await fetch(here('./descriptor.json'))).json();
        this.audioNode = await this.createAudioNode(state);
        this.initialized = true;
        return this;
    }

    async createAudioNode(state) {
        dspModule ??= WebAssembly.compileStreaming(fetch(here('./dsp.wasm')));
        if (!processorLoaded.has(this.audioContext)) {
            processorLoaded.set(this.audioContext, this.audioContext.audioWorklet.addModule(here('./processor.js')));
        }
        const [module] = await Promise.all([dspModule, processorLoaded.get(this.audioContext)]);
        const values = Object.fromEntries(PARAMS.map((p) => [p.id, p.defaultValue]));
        Object.assign(values, state?.values ?? {});
        // The level is shared memory where the page allows it (cross-origin isolation)
        const level = globalThis.crossOriginIsolated ? new SharedArrayBuffer(4) : null;
        return new CrazyPanelsSynthNode(this, {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            processorOptions: {
                groupId: this.groupId,
                moduleId: this.moduleId,
                instanceId: this.instanceId,
                module,
                values,
                level,
            },
        });
    }

    async createGui() {
        const { createElement } = await import('./gui.js');
        return createElement(this);
    }

    destroyGui(gui) {
        gui.remove();
    }
}
