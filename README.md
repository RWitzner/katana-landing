# Katana landing page

A prototype landing page for Katana, an agentic workspace for macOS. Not an official release.

Katana's head is a cloud of 262,144 particles (16,384 on phones), drawn on the GPU with plain WebGL2 and no libraries. They fly in from across the window, settle into the face, and scatter when the cursor stirs them. Behind the head is a grid of katakana in very faint white, with slow beams of light moving across it.

The face is a rough reconstruction and its depth is guessed from the outline, so it is deliberately blurred.

## Run it

```bash
python3 -m http.server 4173
```

Then open http://localhost:4173/.

## Options

- `?n=128` sets the particle grid side (n x n particles).
- `?debug` shows the frame rate and renderer.
- `?v=hello` centres the head in front of big pixel letters.
- `?bg=none` leaves out the katakana background.

## Files

- `index.html`: the page and its styles.
- `main.js`: the particles, the fluid simulation and the camera. The values worth changing are in `TUNING` at the top.
- `glyphs.js`: the katakana background. `base` and `beam` at the top set how strong it is.
- `assets/`: the blurred face and its depth map.
