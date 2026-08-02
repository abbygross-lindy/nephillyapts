/**
 * Pulls live floor plans + pricing from lindyproperty.com and writes them into
 * the property pages in this repo. Run by .github/workflows/update-availability.yml
 *
 * Safety rules:
 *  - If a property returns no parseable plans, its page is LEFT UNTOUCHED and the
 *    run is marked failed for that property. We never publish an empty table.
 *  - A plan with no price renders "Contact for pricing", never a stale number.
 *  - Prices are written into the HTML (not fetched client-side) so they are
 *    crawlable and the page still works with JavaScript disabled.
 */
import { readFile, writeFile } from 'node:fs/promises';

const SLUGS = ['7400-roosevelt', 'joshua-house', 'longwood-manor', 'fountain-gardens'];
const SRC = s => `https://www.lindyproperty.com/properties/${s}/${s}-availability/`;
const AVAIL = s => `https://www.lindyproperty.com/properties/${s}/${s}-availability/?utm_source=web&amp;utm_medium=seo&amp;utm_campaign=nephilapts`;

const money = n => '$' + n.toLocaleString('en-US');

export function parse(html) {
  const chunks = html.split(/class="[^"]*jet-listing-grid__item[^"]*"/).slice(1);
  const plans = [];
  for (const c of chunks) {
    const rawName = (c.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/) || [])[1];
    const fields = [...c.matchAll(/jet-listing-dynamic-field__content"[^>]*>([\s\S]*?)<\/div>/g)]
      .map(m => m[1].replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim());
    if (!rawName || fields.length < 4) continue;
    const [beds, baths, sqft, price] = fields;
    const nums = (price.match(/\d[\d,]*/g) || []).map(n => +n.replace(/,/g, ''));
    plans.push({
      name: rawName.replace(/<[^>]*>/g, '').trim(),
      beds: beds.trim(), baths: baths.trim(), sqft: sqft.trim(),
      priceLabel: !nums.length ? 'Contact for pricing'
        : nums.length === 1 || nums[0] === nums[1] ? money(nums[0])
        : `${money(nums[0])}–${money(nums[1])}`,
    });
  }
  return plans;
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function renderRows(plans, slug) {
  return plans.map(p =>
    `<div class="fp-row"><div class="fp-name">${esc(p.name)}</div>` +
    `<div class="fp-spec">${esc(p.beds)} &nbsp;|&nbsp; ${esc(p.baths)} &nbsp;|&nbsp; ${esc(p.sqft)}</div>` +
    `<div class="fp-price">${esc(p.priceLabel)}</div>` +
    `<a class="btn btn-outline" href="${AVAIL(slug)}" target="_blank" rel="noopener">View Availability</a></div>`
  ).join('');
}

const stamp = () => new Date().toLocaleDateString('en-US',
  { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' });

let failed = [];
const summary = {};

for (const slug of SLUGS) {
  let plans = [];
  try {
    const res = await fetch(SRC(slug), { headers: { 'user-agent': 'nephillyapts-availability-bot' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    plans = parse(await res.text());
  } catch (e) {
    console.error(`✗ ${slug}: fetch/parse failed — ${e.message}`);
    failed.push(slug); continue;
  }
  if (!plans.length) {
    console.error(`✗ ${slug}: 0 floor plans parsed — markup probably changed. Page left untouched.`);
    failed.push(slug); continue;
  }

  const file = `properties/${slug}.html`;
  let html = await readFile(file, 'utf8');
  const table = /(<div class="fp-table">)[\s\S]*?(<\/div><\/div><\/section>)/;
  if (!table.test(html)) { console.error(`✗ ${slug}: fp-table markers not found`); failed.push(slug); continue; }

  html = html.replace(table, (_m, open, close) => open + renderRows(plans, slug) + close);
  html = html.replace(/(<span class="fp-updated">)[\s\S]*?(<\/span>)/,
    `$1Pricing and availability updated ${stamp()} from Lindy Communities$2`);
  await writeFile(file, html);

  summary[slug] = plans.map(p => `${p.name}: ${p.priceLabel}`);
  console.log(`✓ ${slug}: ${plans.length} floor plans`);
}

// Keep the sitemap's lastmod in step with the pages we just rewrote, so Google
// knows to recrawl. Only touches property URLs, and only ones that succeeded.
const updated = SLUGS.filter(s => !failed.includes(s));
if (updated.length) {
  const iso = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  let sm = await readFile('sitemap.xml', 'utf8');
  for (const slug of updated) {
    const re = new RegExp(`(<loc>https://phillynortheastapts\\.com/properties/${slug}\\.html</loc><lastmod>)[^<]*`);
    if (re.test(sm)) sm = sm.replace(re, `$1${iso}`);
  }
  await writeFile('sitemap.xml', sm);
  console.log(`\nsitemap.xml lastmod set to ${iso} for ${updated.length} property page(s)`);
}

console.log('\n' + JSON.stringify(summary, null, 1));
if (failed.length) {
  console.error(`\nFAILED: ${failed.join(', ')} — those pages keep their previous pricing.`);
  process.exit(1);
}
