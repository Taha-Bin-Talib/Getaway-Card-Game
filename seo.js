'use strict';
/* SEO layer: absolute URLs, canonical links, social tags, structured data, sitemap and robots.
   Everything is derived from the request host (or SITE_URL), so a custom domain works without edits. */

const SITE_NAME = 'Jack of All';
const PAGES = [   // [clean path, priority, change frequency]
  ['/', 1.0, 'weekly'], ['/games/bhabhi-thulla', 0.9, 'monthly'], ['/games/bluff', 0.9, 'monthly'], ['/games/jack-thief', 0.9, 'monthly'],
  ['/play', 0.8, 'monthly'], ['/play/bluff', 0.8, 'monthly'], ['/play/jack-thief', 0.8, 'monthly'],
  ['/blog', 0.6, 'weekly'], ['/about', 0.4, 'yearly'], ['/privacy', 0.2, 'yearly'], ['/terms', 0.2, 'yearly'],
];
const GAME_NAMES = { '/play': 'Bhabhi Thulla', '/play/bluff': 'Bluff', '/play/jack-thief': 'Jack Thief' };

const esc = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const attr = (html, re) => { const m = html.match(re); return m ? m[1] : ''; };
const ld = o => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`;

function origin(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto}://${req.headers.host}`;
}

/* adds only the tags a page does not already carry */
function enhance(html, cleanPath, base, mtime) {
  const url = base + (cleanPath === '/' ? '/' : cleanPath);
  const title = attr(html, /<title>([^<]*)<\/title>/);
  const desc = attr(html, /<meta name="description" content="([^"]*)"/);
  const has = re => re.test(html);
  const add = [];
  add.push(`<link rel="canonical" href="${url}">`);
  add.push(`<meta property="og:url" content="${url}">`, `<meta property="og:site_name" content="${SITE_NAME}">`, '<meta property="og:locale" content="en_US">');
  if (!has(/property="og:title"/)) add.push(`<meta property="og:title" content="${title}">`);
  if (!has(/property="og:description"/) && desc) add.push(`<meta property="og:description" content="${desc}">`);
  if (!has(/property="og:type"/)) add.push('<meta property="og:type" content="website">');
  if (!has(/name="theme-color"/)) add.push('<meta name="theme-color" content="#06402a">');
  if (!has(/name="twitter:card"/)) add.push('<meta name="twitter:card" content="summary_large_image">');
  add.push(`<meta name="twitter:title" content="${title}">`);
  if (desc) add.push(`<meta name="twitter:description" content="${desc}">`);
  add.push(`<meta name="twitter:image" content="${base}/img/og.jpg">`,
    `<meta property="og:image:width" content="1200">`, `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="${SITE_NAME}: Bhabhi Thulla, Bluff and Jack Thief card games online">`);
  add.push('<meta name="robots" content="index, follow, max-image-preview:large">');
  // search-console ownership tags: set GOOGLE_SITE_VERIFICATION / BING_SITE_VERIFICATION on the host (Render env vars) to the token only
  if (cleanPath === '/') {
    if (process.env.GOOGLE_SITE_VERIFICATION) add.push(`<meta name="google-site-verification" content="${esc(process.env.GOOGLE_SITE_VERIFICATION)}">`);
    if (process.env.BING_SITE_VERIFICATION) add.push(`<meta name="msvalidate.01" content="${esc(process.env.BING_SITE_VERIFICATION)}">`);
  }
  // structured data
  const crumbs = [['Home', base + '/']];
  if (cleanPath.startsWith('/games/')) crumbs.push(['Guides', null], [attr(html, /<h1>([^<]*)/).trim() || title, url]);
  else if (cleanPath !== '/' && !GAME_NAMES[cleanPath]) crumbs.push([title.split(/[|—:]/)[0].trim(), url]);
  const crumbLd = crumbs.filter(c => c[1]).map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c[0], item: c[1] }));
  if (cleanPath === '/') {
    add.push(ld({ '@context': 'https://schema.org', '@graph': [
      { '@type': 'WebSite', '@id': base + '/#site', url: base + '/', name: SITE_NAME, alternateName: ['Jack of All card games', 'JackOfAll'], description: desc, inLanguage: 'en' },
      { '@type': 'Organization', '@id': base + '/#org', name: SITE_NAME, url: base + '/', logo: base + '/img/logo-192.png' },
    ] }));
  } else if (cleanPath.startsWith('/games/')) {
    add.push(ld({ '@context': 'https://schema.org', '@type': 'Article', headline: title.split(' | ')[0], description: desc, mainEntityOfPage: url, image: base + '/img/og.jpg',
      inLanguage: 'en', author: { '@type': 'Organization', name: SITE_NAME }, publisher: { '@type': 'Organization', name: SITE_NAME, logo: { '@type': 'ImageObject', url: base + '/img/logo-192.png' } } }));
  } else if (GAME_NAMES[cleanPath]) {
    add.push(ld({ '@context': 'https://schema.org', '@type': 'WebApplication', name: `${GAME_NAMES[cleanPath]} Online`, url, description: desc, applicationCategory: 'GameApplication', operatingSystem: 'Any (web browser)',
      genre: 'Card game', numberOfPlayers: { '@type': 'QuantitativeValue', minValue: cleanPath === '/play/jack-thief' ? 2 : 3, maxValue: 8 }, isAccessibleForFree: true, offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' }, publisher: { '@type': 'Organization', name: SITE_NAME } }));
  }
  if (crumbLd.length > 1) add.push(ld({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: crumbLd }));
  // crawlable fallback for the JS game pages
  let out = html.replace('</head>', add.join('\n') + '\n</head>');
  if (GAME_NAMES[cleanPath] && !has(/<noscript>/)) {
    const guide = cleanPath === '/play' ? '/games/bhabhi-thulla' : cleanPath.replace('/play/', '/games/');
    out = out.replace(/<body([^>]*)>/, `<body$1><noscript><div style="padding:24px;font:16px Georgia,serif;color:#fff"><h1>${GAME_NAMES[cleanPath]} online</h1><p>${esc(desc)} This game needs JavaScript. Read the <a style="color:#f5c542" href="${guide}">${GAME_NAMES[cleanPath]} rules</a> or go back to <a style="color:#f5c542" href="/">${SITE_NAME}</a>.</p></div></noscript>`);
  }
  return out;
}

function sitemap(base) {
  const rows = PAGES.map(([p, pr, cf]) => {
    return `  <url><loc>${base}${p}</loc><changefreq>${cf}</changefreq><priority>${pr.toFixed(1)}</priority></url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join('\n')}\n</urlset>\n`;
}
const robots = base => `User-agent: *\nAllow: /\nDisallow: /ws/\n\nSitemap: ${base}/sitemap.xml\n`;

module.exports = { enhance, sitemap, robots, origin };
