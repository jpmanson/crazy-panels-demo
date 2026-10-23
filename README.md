# crazy-panels · WAM synth demo

A panel built with crazy-panels, a Rust UI framework for audio software drawn with WebGPU, working
as a Web Audio Module 2.0: a polyphonic synth and a drum kit in Rust, running in an AudioWorklet.

Open the page in a browser with WebGPU (Chrome, Edge, Safari 26+), press **Start audio**, and play
the keys, the pads or the computer keyboard. The buttons below the panel act as a WAM host: MIDI
events, scheduled automation, saving and restoring the state.

`panels/` is a gallery of other panels drawn by the same framework, each from a document: vacuum
tubes that glow and warm up, animated images (APNG, GIF, WebP), icon sets as widgets, themable SVG
drawings, a compressor with three skins, a mixer, analyzers and more (`panels/?tubes`,
`panels/?animations`, `panels/?symbols`, …).

This repository holds only the built site. It is published from the crazy-panels source, which is
not public yet.
