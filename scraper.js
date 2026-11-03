const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

// Gizli bilgiler koda yazılmaz, GitHub Secrets'tan okunur.
const SUPABASE_URL = 'https://wwbpdxtqyapfdutrjpyf.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY;          // secret / service_role anahtarı
const ENUCUZGB_API_KEY = process.env.ENUCUZGB_API_KEY;  // opsiyonel
const SITE_URL = 'https://enucuzgb.com';

if (!SUPABASE_KEY) {
  console.error('❌ SUPABASE_KEY secret bulunamadı.');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const norm = s => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();

// "294.99" -> 294.99 | "1.250,50" -> 1250.5 | "-" -> null
function parsePrice(t) {
  let s = String(t || '').replace(/[^\d.,]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Sunucu adı eşleştirme: tam eşleşme, boşluksuz, sonra NEW/KAS ekleri atılmış hâli
const LEVELS = [x => x, x => x.replace(/\s/g, ''), x => x.replace(/\s|NEW|KAS/g, '')];

async function scrape() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 }
    });
    // API anahtarı sadece enucuzgb.com isteklerine eklenir.
    if (ENUCUZGB_API_KEY) {
      await context.route('**/*', route => {
        const req = route.request();
        if (new URL(req.url()).hostname.endsWith('enucuzgb.com')) {
          route.continue({ headers: { ...req.headers(), 'X-API-Key': ENUCUZGB_API_KEY } });
        } else route.continue();
      });
    }
    const page = await context.newPage();
    await page.goto(SITE_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForSelector('table', { timeout: 15000 });

    return await page.evaluate(() => {
      const table = document.querySelector('table');
      const trs = Array.from(table.querySelectorAll('tr'));
      const cellsOf = r => Array.from(r.children);

      // 1) Sunucu adları: ilk satır, ilk hücre ("SİTE / SERVER") hariç
      const servers = cellsOf(trs[0]).slice(1).map(c => c.innerText.trim()).filter(Boolean);

      // 2) Veri satırları: fiyatlar <td> içinde, site adı satırın <th> (logo) hücresinde
      const sites = [];
      const html = [];
      trs.forEach(r => {
        const tds = Array.from(r.querySelectorAll('td'));
        if (tds.length < 3) return;
        const first = r.querySelector('th') || (cellsOf(r)[0] !== tds[0] ? cellsOf(r)[0] : null);
        let name = '', url = '';
        if (first) {
          const img = first.querySelector('img');
          const a = first.querySelector('a');
          const lab = first.querySelector('[alt],[title],[aria-label],[data-name],[data-site]');
          let host = '';
          try { host = a && a.href ? new URL(a.href).hostname.replace(/^www\./, '') : ''; } catch (e) {}
          let file = '';
          if (img && img.src) file = decodeURIComponent(img.src.split('/').pop().split('?')[0].replace(/\.[a-z0-9]+$/i, ''));
          name = first.innerText.trim()
            || (lab && (lab.getAttribute('alt') || lab.getAttribute('title') || lab.getAttribute('aria-label') || lab.getAttribute('data-name') || lab.getAttribute('data-site')))
            || first.getAttribute('title') || first.getAttribute('aria-label')
            || r.getAttribute('data-site') || r.getAttribute('data-name') || r.getAttribute('aria-label')
            || host || file || '';
          url = a && a.href ? a.href : '';
        }
        if (html.length < 3) html.push({ siteHucresi: first ? first.outerHTML.slice(0, 400) : null, fiyatHucreSayisi: tds.length });
        sites.push({ name: String(name).trim(), url, vals: tds.map(c => c.innerText.trim()) });
      });
      return { servers, sites, html };
    });
  } finally {
    await browser.close();
  }
}

async function getSiteId(name, url, cache) {
  if (cache.has(name)) return cache.get(name);
  const f = await sb.from('price_sites').select('id').eq('name', name).maybeSingle();
  if (f.error) throw f.error;
  let id = f.data && f.data.id;
  if (!id) {
    const c = await sb.from('price_sites').insert({ name, url: /^https:\/\//.test(url) ? url : null, sort: 99 }).select('id').single();
    if (c.error) throw c.error;
    id = c.data.id;
  }
  cache.set(name, id);
  return id;
}

(async () => {
  console.log('🔄 EnUcuzGB fiyat botu başlatıldı...');
  try {
    const { servers, sites, html } = await scrape();
    console.log(`📦 ${servers.length} sunucu, ${sites.length} site satırı okundu.`);
    console.log('🔎 Site hücresi örnekleri:', JSON.stringify(html, null, 1));

    const sv = await sb.from('servers').select('id,name');
    if (sv.error) throw sv.error;
    console.log('🗂  servers tablosu:', sv.data.map(s => s.name).join(', '));

    // Sayfadaki her sunucu başlığını servers tablosundaki id ile eşle
    const numOf = t => { const m = String(t).split('\n')[0].trim().toUpperCase().match(/SERVER\s*(\d+)\s*$/); return m ? m[1] : null; };
    const byNum = new Map(sv.data.map(s => [numOf(s.name), s.id]).filter(([n]) => n));
    const colId = servers.map(h => {
      for (const lv of LEVELS) {
        const m = new Map(sv.data.map(s => [lv(norm(s.name)), s.id]));
        const id = m.get(lv(norm(h)));
        if (id) return id;
      }
      const n = numOf(h);                 // "SERVER1 12 KAS" -> "Yeni Server 1"
      return n && byNum.get(n) || null;
    });
    const unmatched = servers.filter((_, i) => !colId[i]);
    if (unmatched.length) console.warn('⚠️ servers tablosunda karşılığı olmayan sunucular:', unmatched.join(', '));

    const cache = new Map(), seen = new Set(), upserts = [];
    const now = new Date().toISOString();
    for (const s of sites) {
      if (!s.name || /^[\d.,\s-]+$/.test(s.name)) { console.warn('⚠️ Site adı bulunamadı, satır atlandı:', JSON.stringify(s.name)); continue; }
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      const siteId = await getSiteId(s.name, s.url, cache);
      servers.forEach((_, i) => {
        if (!colId[i]) return;
        const sell = parsePrice(s.vals[2 * i]);      // 1. sütun: Satış
        const buy = parsePrice(s.vals[2 * i + 1]);   // 2. sütun: Alış
        if (sell == null && buy == null) return;
        upserts.push({ site_id: siteId, server_id: colId[i], sell, buy, updated_at: now });
      });
    }

    console.log(`✍️  ${upserts.length} fiyat yazılacak (${seen.size} site).`);
    if (!upserts.length) { console.log('⚠️ Yazılacak geçerli veri yok.'); process.exitCode = 1; return; }

    const { error } = await sb.from('gb_prices').upsert(upserts, { onConflict: 'site_id,server_id' });
    if (error) throw error;
    console.log('✅ Fiyatlar Supabase üzerinde güncellendi.');
  } catch (e) {
    console.error('❌ Hata:', e.message || e);
    process.exitCode = 1;
  }
})();
