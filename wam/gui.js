// The synth's GUI: panel-demo's synth panel, drawn by crazy-panels (WebGPU) in a canvas, and wired
// to the module's node.

import init, { mount } from './pkg/wam_synth.js';

let ready;

export async function createElement(wam) {
    ready ??= init({ module_or_path: new URL('./pkg/wam_synth_bg.wasm', import.meta.url) });
    await ready;

    const root = document.createElement('div');
    root.style.cssText = 'width: 900px; height: 440px; display: flex; max-width: 100%;';
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'flex: 1 1 auto; width: 100%; height: 100%; outline: none;';
    canvas.tabIndex = 0;
    root.append(canvas);

    const node = wam.audioNode;
    const context = wam.audioContext;
    const host = {
        setParam: (id, value) => node.setFromGui(id, value),
        midi: (status, data1, data2) =>
            node.scheduleEvents({ type: 'wam-midi', time: context.currentTime, data: { bytes: [status, data1, data2] }, fromGui: true }),
        level: () => node.level(),
        listen: (onParam, onMidi) => {
            node.paramListeners.add(onParam);
            // MIDI the sound played that did not come from the panel: a host's, a sequencer's
            node.addEventListener('wam-midi', (e) => {
                if (!e.detail.fromGui) onMidi(...e.detail.data.bytes);
            });
            // The panel starts from the sound's values
            for (const [id, value] of Object.entries(node.values)) onParam(id, value);
        },
    };
    mount(canvas, host).catch((e) => {
        root.textContent = `The panel cannot be shown: ${e}`;
    });
    return root;
}
