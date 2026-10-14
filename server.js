import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '1mb' }));

// ============================================================
//  CONFIG — SigiloPay
// ============================================================
const SIGILO = {
  baseUrl: 'https://app.sigilopay.com.br/api/v1',
  publicKey: 'lpaulohenrique93_zzh95kzihjcs7m2p',
  secretKey: 'm7nfb0didp313whvwwkgcl5hw3unw8xv750fmc9jof0l02ba0c4p15ed1fga996d',
};

function buildHeaders() {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'x-public-key': SIGILO.publicKey,
    'x-secret-key': SIGILO.secretKey,
  };
}

// ============================================================
//  HEALTH
// ============================================================
app.get('/health', (req, res) => {
  res.json({ ok: true, ts: Date.now(), baseUrl: SIGILO.baseUrl });
});

// ============================================================
//  DEBUG — testa credenciais e conectividade
// ============================================================
app.get('/api/debug', async (req, res) => {
  const out = { baseUrl: SIGILO.baseUrl, tests: [] };

  // 1) Testa credenciais (rota oficial de teste)
  try {
    const r = await fetch(`${SIGILO.baseUrl}/gateway/producer/credentials`, {
      headers: buildHeaders(),
    });
    const txt = await r.text();
    let d; try { d = JSON.parse(txt); } catch { d = { raw: txt }; }
    out.tests.push({
      step: 'credentials',
      url: `${SIGILO.baseUrl}/gateway/producer/credentials`,
      status: r.status,
      body: d,
    });
  } catch (e) {
    out.tests.push({ step: 'credentials', error: String(e) });
  }

  // 2) Testa saldo
  try {
    const r = await fetch(`${SIGILO.baseUrl}/gateway/producer/balance`, {
      headers: buildHeaders(),
    });
    const txt = await r.text();
    let d; try { d = JSON.parse(txt); } catch { d = { raw: txt }; }
    out.tests.push({
      step: 'balance',
      url: `${SIGILO.baseUrl}/gateway/producer/balance`,
      status: r.status,
      body: d,
    });
  } catch (e) {
    out.tests.push({ step: 'balance', error: String(e) });
  }

  // 3) Testa dados do produtor
  try {
    const r = await fetch(`${SIGILO.baseUrl}/gateway/producer`, {
      headers: buildHeaders(),
    });
    const txt = await r.text();
    let d; try { d = JSON.parse(txt); } catch { d = { raw: txt }; }
    out.tests.push({
      step: 'producer',
      url: `${SIGILO.baseUrl}/gateway/producer`,
      status: r.status,
      body: d,
    });
  } catch (e) {
    out.tests.push({ step: 'producer', error: String(e) });
  }

  res.json(out);
});

// ============================================================
//  CRIAR PIX — POST /gateway/pix/receive
// ============================================================
app.post('/api/pix/create', async (req, res) => {
  try {
    const { amount, description, client, identifier } = req.body || {};

    if (!amount || !client?.name || !client?.email) {
      return res.status(400).json({
        ok: false,
        error: 'Dados incompletos (amount, client.name, client.email)',
      });
    }

    const payload = {
      identifier: identifier || ('ID_' + Date.now()),
      amount: Number(amount),
      client: {
        name: client.name,
        email: client.email,
        phone: client.phone || '',
        document: client.document || '',
      },
      products: [
        {
          id: 'PROD_' + Date.now(),
          name: description || 'Compra',
          quantity: 1,
          price: Number(amount),
        },
      ],
      metadata: {
        provider: 'ColabHotPro',
        orderId: identifier || String(Date.now()),
      },
    };

    const url = `${SIGILO.baseUrl}/gateway/pix/receive`;
    console.log('[pix/create] POST', url);
    console.log('[pix/create] payload:', JSON.stringify(payload));

    const upstream = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify(payload),
    });

    const txt = await upstream.text();
    let data;
    try { data = JSON.parse(txt); } catch { data = { raw: txt }; }

    console.log('[pix/create] status:', upstream.status);
    console.log('[pix/create] response:', JSON.stringify(data));

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        ok: false,
        error: data?.message || 'SigiloPay recusou a requisição',
        status: upstream.status,
        sent_payload: payload,
        response: data,
      });
    }

    // Extrai QR e copia-e-cola da resposta oficial
    const root = data.data || data;
    const pix = root.pix || {};

    const qrUrl = pix.image || null;             // URL da imagem do QR
    const copyPaste = pix.code || null;          // Copia-e-cola PIX
    const base64 = pix.base64 || null;           // deprecated, geralmente vazio

    const transactionId =
      root.transactionId || root.id || root.txid ||
      root.identifier || null;

    const status = root.status || root.transactionStatus || null;

    return res.json({
      ok: true,
      transactionId,
      status,
      qrUrl,
      qrBase64: base64 && base64.length > 20 ? base64 : null,
      copyPaste,
      expiresAt: pix.expiresAt || null,
      fee: root.fee || null,
      raw: data,
    });
  } catch (err) {
    console.error('[/api/pix/create] erro:', err);
    return res.status(502).json({ ok: false, error: 'Erro no proxy', detail: String(err) });
  }
});

// ============================================================
//  STATUS PIX
// ============================================================
app.get('/api/pix/status/:id', async (req, res) => {
  try {
    const id = encodeURIComponent(req.params.id);
    const url = `${SIGILO.baseUrl}/gateway/transactions?id=${id}`;
    const r = await fetch(url, { headers: buildHeaders() });
    const txt = await r.text();
    let data; try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// ============================================================
//  STATIC
// ============================================================
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Rodando na porta ${PORT} | baseUrl=${SIGILO.baseUrl}`));
