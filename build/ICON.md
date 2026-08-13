# Panda Bench icon

`icon.png` is the 1024x1024 master. `icon.ico` is the multi-resolution Windows container
(16/24/32/48/64/128/256) that `electron-builder` and the `BrowserWindow` icon both point at.
`../renderer/brand-64.png` is the same art at 64px, used for the mark in the app's sidebar.

## Design

The Panda Eats companion iOS app icon, with its badge glyph swapped. Same panda, same 3D plush
render, same badge treatment - the companion carries a phone, this one carries a **wrench**,
because this is the workbench tool.

A gear variant was also produced and rejected: at 32px the teeth mush into an indistinct blob,
while the wrench keeps a readable silhouette.

## Badge colour

**Coral `#F05040`.** Not green.

The badge was originally built in emerald `#10B981` and that was wrong: green reads as Uber Eats.
The real Panda Eats accent was sampled from the brand art itself - the logo mark's tongue and the
mascot's paw pads both land on `#F05040`, with `#FF8070` and `#FF5040` as its neighbours.

The correction was applied as a **recolour, not a regeneration**: only green-dominant pixels were
remapped, preserving each pixel's luminance, so the panda, the wrench glyph, the shadow and every
antialiased edge are bit-for-bit the original artwork and only the hue moved.

Note that emerald is still correct *inside the app* for success states (a passing check, an "ok"
chip). That mirrors `AcceptGreen` in the order-taking app and `--color-brand-success` in the web
app. Green as a **success semantic** is right; green as a **brand accent** is not.

## Regenerating the .ico

The master is the source of truth. From any directory with `sharp` and `png-to-ico` available:

```js
const m = require('png-to-ico');
const pngToIco = typeof m === 'function' ? m : m.default;
const sharp = require('sharp');
const fs = require('fs');

const bufs = [];
for (const s of [16, 24, 32, 48, 64, 128, 256]) {
  bufs.push(await sharp('icon.png').resize(s, s, { kernel: sharp.kernel.lanczos3 }).png().toBuffer());
}
fs.writeFileSync('icon.ico', await pngToIco(bufs));
```

Verify the result is a real ICO container and not a renamed PNG - the first four bytes must be
`00 00 01 00`.
