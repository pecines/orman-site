const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

// 🔑 Supabase Bağlantı Bilgileriniz
const SUPABASE_URL = 'https://wwbpdxtqyapfdutrjpyf.supabase.co'; 

// 💡 Şifreniz koda yazılmadı. GitHub Secrets üzerinden güvenle okunacak:
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_KEY; 

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Kritik Hata: GitHub panelindeki SUPABASE_KEY sırrı (secret) bulunamadı!");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function startScraper() {
  console.log('🔄 EnUcuzGB fiyat botu başlatıldı...');
  
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 }
  });
  
  const page = await context.newPage();

  try {
    // 💡 Resmi EnUcuzGB API Entegrasyon Tanımı
    await page.setExtraHTTPHeaders({
      'X-API-Key': 'eugb_4a78ec3cab8178d25564d136ac5cfe0234420767c28e7b5b'
    });

    // Sitedeki fiyat sayfasına yönlendir (Tam adres güncellendi)
    await page.goto('https://enucuzgb.com', { waitUntil: 'networkidle', timeout: 60000 });
    
    // Tablonun yüklenmesini bekle
    await page.waitForSelector('table', { timeout: 15000 });

    const pricesArray = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tr'));
      const results = [];
      const seenServers = new Set(); // 💡 Çift kayıtları engellemek için kontrol seti
      
      rows.forEach(row => {
        const cells = Array.from(row.querySelectorAll('td')).map(c => c.innerText.trim());
        
        if (cells.length >= 3) {
          let serverName = cells[0].toUpperCase(); // Sunucu adını büyütüp standartlaştırıyoruz
          
          // Sayı temizleme mantığı
          const buyPrice = parseFloat(cells[1].replace(/[^\d,.-]/g, '').replace(',', '.')) || 0;
          const sellPrice = parseFloat(cells[2].replace(/[^\d,.-]/g, '').replace(',', '.')) || 0;
          
          // Başlık satırlarını ve boş verileri filtrele
          if (serverName && !serverName.includes('SERVER') && !serverName.includes('SUNUCU')) {
            
            // 💡 EĞER BU SUNUCU ADI DAHA ÖNCE EKLENMEDİYSE LİSTEYE AL
            if (!seenServers.has(serverName)) {
              seenServers.add(serverName);
              
              results.push({
                server_name: serverName,
                buy_price: buyPrice,
                sell_price: sellPrice,
                stock_status: 'Var',
                updated_at: new Date().toISOString()
              });
            }
          }
        }
      });
      
      return results;
    });

    console.log(`📦 Siteden ${pricesArray.length} adet benzersiz sunucu fiyatı çekildi.`);

    if (pricesArray.length > 0) {
      // Supabase'e şemayı belirterek temiz listeyi gönderiyoruz
      const { error } = await supabase
        .schema('public')
        .from('gb_prices')
        .upsert(pricesArray, { onConflict: 'server_name' });

      if (error) {
        console.error('❌ Supabase kayıt hatası:', error.message);
      } else {
        console.log('✅ Tüm fiyatlar Supabase üzerinde başarıyla güncellendi!');
      }
    } else {
      console.log('⚠️ Siteden geçerli veri okunamadı.');
    }

  } catch (err) {
    console.error('❌ Bot çalışırken kritik hata:', err.message);
  } finally {
    await browser.close();
    console.log('🔌 Tarayıcı kapatıldı.');
  }
}

startScraper();
