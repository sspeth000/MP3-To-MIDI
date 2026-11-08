# MP3 → MIDI

A browser-based experimental spectral audio-to-MIDI converter. It runs entirely on the client and is designed for static hosting with GitHub Pages.

## Features

- Decode browser-supported audio files locally using the Web Audio API.
- Analyze overlapping audio frames with a radix-2 FFT.
- Detect multiple spectral peaks per frame and map their frequencies to the nearest equal-tempered MIDI pitches.
- Merge consecutive detections into note events.
- Export a Standard MIDI File (.mid).

## Run locally

Open `index.html` in a modern browser, or serve this folder with any static HTTP server.

## GitHub Pages

In the repository settings, open **Pages** and configure deployment from the `main` branch and the `/(root)` folder. The site entry point is `index.html`.

## Notes and limitations

This is spectral transcription, not lossless audio-to-MIDI conversion. An FFT peak is not necessarily a played musical note: harmonics, percussion, noise, and overlapping instruments can all produce detected peaks. MIDI stores note events and cannot preserve the original waveform, timbre, effects, or full audio texture.

The current implementation is intentionally experimental. It limits input duration to five minutes, uses a fixed 120 BPM MIDI tempo, and estimates note pitch by rounding detected frequencies to the nearest equal-tempered semitone. Dense settings can create large MIDI files and may include extra notes.
