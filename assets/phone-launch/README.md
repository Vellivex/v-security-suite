# Vellivex privacy-phone launch media

Created 12 November 2026 for the Vellivex phone launch. The SVG layouts and
stylised handset artwork are original Vellivex promotional artwork, using the
existing mark from `web/brand/vellivex-logo.svg`, the navy/baby-blue brand colours
and DejaVu Sans. The illustrated handset is explicitly labelled; it is not a
photograph of a finished or customer-owned device.

The artwork presents Pixel 9a 128GB prepared with GrapheneOS, the new £479 and
refurbished £375 options, paid preorders, and UK delivery within two weeks
included. Claims and prices must be reviewed whenever the storefront changes.
Pixel and GrapheneOS names describe the offered hardware and software; this
artwork does not imply sponsorship, affiliation or endorsement by Google or
GrapheneOS.

## Source and published files

| Vector source | Published rendering | Dimensions |
| --- | --- | --- |
| `vellivex-privacy-phones.svg` | `vellivex-privacy-phones.png` | 1200×630 |
| `vellivex-privacy-phones-vertical.svg` | `vellivex-privacy-phones-vertical.png` | 1080×1920 |
| `vellivex-phone-scene-2.svg` | Video scene 2 | 1080×1920 |
| `vellivex-phone-scene-3.svg` | Video scene 3 | 1080×1920 |

The vertical poster followed by scenes 2 and 3 forms the silent 15-second
`vellivex-privacy-phones.mp4`: H.264, yuv420p, 1080×1920, 12 fps, five seconds per
scene. The PNGs and MP4 are embedded exactly in `server/phone-shop-media.mjs`;
their byte lengths and SHA-256 digests are recorded in `PHONE_MEDIA` there.
Rendered binaries need not also be stored as duplicate Git objects.

## Official product photograph

`pixel-9a-obsidian.jpg` is an unchanged Google Store product photograph showing
the front, side and back of the Pixel 9a in Obsidian. It is used separately from
the promotional illustrations, including as the product structured-data image.
It shows the manufacturer's device appearance, not the installed GrapheneOS
interface or a photographed Vellivex-prepared handset.

- Copyright: Google. All rights remain with Google; no Google affiliation,
  sponsorship or endorsement is claimed.
- Source page: https://store.google.com/gb/product/pixel_9a?hl=en-GB
- Official gallery image: Obsidian-4, front/side/back.
- Exact image URL: https://lh3.googleusercontent.com/YfrFPJR3mybyPqN75HDidiLlY8Glx0pXXVQh2u2GRwDu3HUycABU_a35kdzgpWzLLJ1Ifa3yz8n5vVbdgIpOCzx5K-xg2IJYRCg
- Retrieved and visually checked: 12 November 2026.
- Media: JPEG, 512×383, 27,547 bytes; served at
  `/media/pixel-9a-obsidian.jpg` without image modification.
- SHA-256: `ac7b447987641f67670a234ea6dac2606043ce2e79b78c05a5c2b462021b9362`.

## Reproduction

Run from the repository root with Node, Sharp, DejaVu Sans and FFmpeg available.
The launch rendering used Sharp 0.35.5, libvips 8.18.7, librsvg 2.63.2, Pango
1.58.2 and FFmpeg 7.1.5. Different renderer/font/encoder versions can produce
different bytes; the SVGs remain the editable visual sources.

```sh
node <<'JS'
const sharp = require('sharp');
(async () => {
  for (const name of [
    'vellivex-privacy-phones', 'vellivex-privacy-phones-vertical',
    'vellivex-phone-scene-2', 'vellivex-phone-scene-3'
  ]) {
    await sharp(`assets/phone-launch/${name}.svg`)
      .png({compressionLevel: 9})
      .toFile(`assets/phone-launch/${name}.png`);
  }
})();
JS

cat > assets/phone-launch/video-scenes.txt <<'EOF'
file 'vellivex-privacy-phones-vertical.png'
duration 5
file 'vellivex-phone-scene-2.png'
duration 5
file 'vellivex-phone-scene-3.png'
duration 5
file 'vellivex-phone-scene-3.png'
EOF
ffmpeg -f concat -safe 0 -i assets/phone-launch/video-scenes.txt \
  -vf 'fps=12,tpad=stop_mode=clone:stop_duration=1' -t 15 \
  -c:v libx264 -crf 26 -preset slow -tune stillimage -pix_fmt yuv420p \
  -movflags +faststart -an -y assets/phone-launch/vellivex-privacy-phones.mp4
rm assets/phone-launch/video-scenes.txt
```

To recover the exact currently embedded public media instead of rerendering:

```sh
node --input-type=module <<'JS'
import {writeFile} from 'node:fs/promises';
import {PHONE_MEDIA, phoneMediaResponse} from './server/phone-shop-media.mjs';
for (const asset of Object.values(PHONE_MEDIA)) {
  const response = phoneMediaResponse(new Request('https://www.vellivex.com' + asset.path));
  await writeFile('assets/phone-launch/' + asset.path.split('/').at(-1),
    new Uint8Array(await response.arrayBuffer()));
}
JS
```

The repository's GPL code licence and any generated worker GPL header do not
relicense third-party photographs, fonts, trademarks or other independently
owned material. Original copyright and attribution remain with their owners.
