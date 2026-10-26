// Generates the PNG app icons (run: npm run icons). Output is committed in public/icons.
import sharp from 'sharp';
const svg = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" fill="#0b4f8a"/>
<g transform="translate(${pad} ${pad}) scale(${(512 - 2 * pad) / 512})">
<rect x="186" y="60" width="140" height="392" rx="10" fill="#ffffff"/>
<rect x="206" y="80" width="100" height="352" fill="#0b4f8a"/>
<rect x="206" y="250" width="100" height="182" fill="#4fc3f7"/>
<path d="M206 250 q25 -18 50 0 t50 0" fill="#4fc3f7"/>
<g stroke="#ffffff" stroke-width="10">
<line x1="96" y1="250" x2="170" y2="250"/><line x1="342" y1="250" x2="416" y2="250"/></g>
<path d="M120 200 l26 -34 l26 34 z M340 200 l26 -34 l26 34 z" fill="#ffffff"/>
</g></svg>`;
const out = (size, pad, name) => sharp(Buffer.from(svg(pad))).resize(size, size).png().toFile(`public/icons/${name}`);
await out(192, 0, 'icon-192.png');
await out(512, 0, 'icon-512.png');
await out(512, 70, 'icon-512-maskable.png');
await out(180, 0, 'apple-touch-icon.png');
console.log('icons written');
