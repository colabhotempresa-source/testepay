import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '1mb' }));

// ============================================================
//  CREDENCIAIS HARDCODED (você pediu, são de teste)
// ============================================================
const CONFIG = {
  baseUrl: process.env.SIGILOPAY_BASE_URL || 'https://api.sigilopay.com.br',
  clientId: 'lpaulohenrique93_zzh95kzihjcs7m2p',
  clientSecret: 'm7nfb0didp313whvwwkgcl5hw3unw8xv750fmc9jof0l02ba0c4p15ed1fga996d',
  authMode: process.env.SIGILOPAY_AUTH_MODE || 'basic',
};

function basicAuthHeader() {
  return 'Basic ' + Buffer.from(`${CONFIG.clientId}:${CONFIG.clientSecret}`).toString('base64');
}

function buildHeaders() {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': basicAuthHeader(),
    'User-Agent': 'ColabHotPro/1.0',
  };
}

// ============================================================
//  HEALTH
// ============================================================
app.get('/health', (req, res) => {
  res.json({ ok: true, ts: Date.now(), clientId: CONFIG.clientId });
});

// ============================================================
//  DEBUG — testa VÁRIOS endpoints candidatos e devolve tudo
// ============================================================
app.get('/api/debug', async (req, res) => {
  const candidates = [
    '/',
    '/v1',
    '/v1/',
    '/api',
    '/api/v1',
    '/v1/pix/charge',
    '/v1/pix',
    '/v1/transactions',
    '/v1/charges',
    '/pix/charge',
    '/pix',
    '/gateway/pix/receive',
    '/api/pix/create',
    '/charge',
    '/transactions',
  ];

  const out = {
    baseUrl: CONFIG.baseUrl,
    authMode: CONFIG.authMode,
    clientId: CONFIG.clientId,
    hasSecret: !!CONFIG.clientSecret,
    tests: [],
  };

  for (const p of candidates) {
    const url = CONFIG.baseUrl + p;
    try {
      const r = await fetch(url, { method: 'GET', headers: buildHeaders() });
      const txt = await r.text();
      out.tests.push({
        path: p,
        status: r.status,
        body: txt.slice(0, 200),
      });
    } catch (e) {
      out.tests.push({ path: p, error: String(e).slice(0, 150) });
    }
  }
  res.json(out);
});

// ============================================================
//  CRIAR PIX
// ============================================================
app.post('/api/pix/create', async (req, res) => {
  try {
    const { amount, description, client, identifier } = req.body || {};
    if (!amount || !client?.name || !client?.document) {
      return res.status(400).json({ error: 'Dados incompletos' });
    }

    const payload = {
      identifier: identifier || ('ID_' + Date.now()),
      amount: Number(amount),
      description: description || 'Compra',
      payment_method: 'pix',
      customer: {
        name: client.name,
        email: client.email,
        document: client.document,
        phone: client.phone,
      },
    };

    // Tenta o path padrão que chutamos
    const url = CONFIG.baseUrl + '/v1/pix/charge';
    const upstream = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify(payload),
    });

    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: 'SigiloPay recusou',
        status: upstream.status,
        sent_to: url,
        sent_payload: payload,
        response: data,
      });
    }

    const root = data.data || data;
    const qrBase64 =
      root.qr_code_image || root.qrCodeImage || root.qr_code_base64 ||
      root.qrCodeBase64 || root.qr_code || root.qrCode || null;
    const copyPaste =
      root.pix_copia_e_cola || root.pixCopiaECola || root.qr_code_text ||
      root.emv || root.payload || root.copy_paste || null;

    return res.json({
      ok: true,
      transactionId: root.transactionId || root.id || root.txid || root.identifier || null,
      qrBase64,
      copyPaste,
      raw: data,
    });
  } catch (err) {
    return res.status(502).json({ error: 'Erro no proxy', detail: String(err) });
  }
});

// ============================================================
//  STATUS
// ============================================================
app.get('/api/pix/status/:id', async (req, res) => {
  try {
    const url = `${CONFIG.baseUrl}/v1/pix/charge/${encodeURIComponent(req.params.id)}`;
    const r = await fetch(url, { headers: buildHeaders() });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
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
app.listen(PORT, () => console.log(`✅ Rodando na porta ${PORT}`));
