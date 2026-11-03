const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

// Gizli bilgiler koda yazılmaz, GitHub Secrets'tan okunur.
const SUPABASE_URL = 'https://wwbpdxtqyapfdutrjpyf.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY;          // service_role / secret key
const ENUCUZGB_API_KEY = process.env.ENUCUZGB_API_KEY;  // opsiyonel

const SITE_NAME = 'EnUcuzGB';
const SITE_URL = 'https://enucuzgb.com';

if (!SUPABASE_KEY) {
  console.error('❌ SUPABASE_KEY secret bulunamadı.');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const norm = s => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();

// "1.250,50" -> 1250.5 | "98,5" -> 98.5 | "98.5" -> 98.5
function parsePrice(t) {
  let s = String(t || '').replace(/[^\d.,]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function scrape() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 }
    });
    // API anahtarı sadece enucuzgb.com isteklerine eklenir, üçüncü taraflara gitmez.
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
      const out = [];
      document.querySelectorAll('table tr').forEach(row => {
        const c = Array.from(row.querySelectorAll('td')).map(x => x.innerText.trim());
        if (c.length >= 3) out.push(c.slice(0, 3));
      });
      return out;
    });
  } finally {
    await browser.close();
  }
}

async function getSiteId() {
  const f = await sb.from('price_sites').select('id').eq('name', SITE_NAME).maybeSingle();
  if (f.error) throw f.error;
  if (f.data) return f.data.id;
  const c = await sb.from('price_sites').insert({ name: SITE_NAME, url: SITE_URL, sort: 99 }).select('id').single();
  if (c.error) throw c.error;
  return c.data.id;
}

(async () => {
  console.log('🔄 EnUcuzGB fiyat botu başlatıldı...');
  try {
    const rows = await scrape();
    const siteId = await getSiteId();
    const sv = await sb.from('servers').select('id,name');
    if (sv.error) throw sv.error;
    const byName = new Map(sv.data.map(s => [norm(s.name), s.id]));

    const seen = new Set(), upserts = [], missing = [];
    for (const [name, c1, c2] of rows) {
      const key = norm(name);
      if (!key || key.includes('SERVER') || key.includes('SUNUCU') || seen.has(key)) continue;
      seen.add(key);
      const serverId = byName.get(key);
      if (!serverId) { missing.push(name); continue; }
      // DİKKAT: sütun sırası enucuzgb.com tablosuna göre kontrol et (2. sütun alış, 3. sütun satış varsayıldı)
      upserts.push({
        site_id: siteId,
        server_id: serverId,
        buy: parsePrice(c1),
        sell: parsePrice(c2),
        updated_at: new Date().toISOString()
      });
    }

    console.log(`📦 ${rows.length} satır okundu, ${upserts.length} fiyat eşleşti.`);
    if (missing.length) console.warn('⚠️ servers tablosunda karşılığı olmayan sunucular:', missing.join(', '));
    if (!upserts.length) { console.log('⚠️ Yazılacak geçerli veri yok.'); process.exitCode = 1; return; }

    const { error } = await sb.from('gb_prices').upsert(upserts, { onConflict: 'site_id,server_id' });
    if (error) throw error;
    console.log('✅ Fiyatlar Supabase üzerinde güncellendi.');
  } catch (e) {
    console.error('❌ Hata:', e.message || e);
    process.exitCode = 1;
  }
})();
