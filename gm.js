const fs   = require('fs');
const path = require('path');

const IMAGE_DIR  = path.join(__dirname, 'assets', 'images');
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];

if (!fs.existsSync(IMAGE_DIR)) {
    console.error('ERROR: Folder not found: ' + IMAGE_DIR);
    process.exit(1);
}

const allFiles = fs.readdirSync(IMAGE_DIR)
    .filter(f => IMAGE_EXTS.includes(path.extname(f).toLowerCase()));

function getImages(prefix) {
    // prefix: 'p' = photography, 'ig' = instagram, '' = marketing (numbers only)
    return allFiles
        .filter(f => {
            const name = path.basename(f, path.extname(f));
            if (prefix === '') {
                // marketing: files that are just numbers e.g. 1.png, 34.png
                return /^\d+$/.test(name);
            } else {
                // photography: p1.png, p2.png ...
                // instagram: ig1.png, ig2.png ...
                const pattern = new RegExp('^' + prefix + '\\d+$', 'i');
                return pattern.test(name);
            }
        })
        .sort((a, b) => {
            const numA = parseInt(path.basename(a, path.extname(a)).replace(prefix, ''));
            const numB = parseInt(path.basename(b, path.extname(b)).replace(prefix, ''));
            return numA - numB;
        });
}

// ── MARKETING ───────────────────────────────────────────────────────────────
const marketingImages = getImages('');
const marketingCards = marketingImages
    .map(f => `        <div class="portfolio-card"><img src="assets/images/${f}" alt="" loading="lazy"></div>`)
    .join('\n');

const marketingHTML = `<section class="portfolio-section marketing-section" id="marketing">
    <h2 class="section-title">Marketing Collateral</h2>
    <div class="portfolio-grid">
        <!-- AUTO-GENERATED -->
${marketingCards}
    </div>
</section>
`;

fs.writeFileSync(path.join(__dirname, 'components', 'marketing.html'), marketingHTML, 'utf8');
console.log(`✅ marketing.html — ${marketingImages.length} image(s)`);

// ── PHOTOGRAPHY ─────────────────────────────────────────────────────────────
const photoImages = getImages('p');
const photoSpans = photoImages
    .map((f, i) => `        <span style="--i: ${i + 1}"><img src="assets/images/${f}" alt="" loading="lazy"></span>`)
    .join('\n');

const photoHTML = `<section class="portfolio-section photography-section" id="photography">
    <h2 class="section-title">Photography</h2>
    <div class="image-container">
        <!-- AUTO-GENERATED -->
${photoSpans}
    </div>
    <div class="btn-container">
        <button class="btn" id="prev">Prev</button>
        <button class="btn" id="next">Next</button>
    </div>
</section>
`;

fs.writeFileSync(path.join(__dirname, 'components', 'photography.html'), photoHTML, 'utf8');
console.log(`✅ photography.html — ${photoImages.length} image(s)`);

// ── INSTAGRAM ────────────────────────────────────────────────────────────────
const igImages = getImages('ig');
const igCards = igImages
    .map(f => `        <div class="instagram-img-c"><div class="instagram-img-w" style="background-image: url('assets/images/${f}')"></div></div>`)
    .join('\n');

const igHTML = `<section class="portfolio-section instagram-section" id="instagram">
    <h2 class="section-title">Instagram</h2>
    <div class="instagram-gallery">
        <!-- AUTO-GENERATED -->
${igCards}
    </div>
</section>
`;

fs.writeFileSync(path.join(__dirname, 'components', 'instagram.html'), igHTML, 'utf8');
console.log(`✅ instagram.html — ${igImages.length} image(s)`);
