import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '1mb' }));

// ============================================================
//  CONFIG — domínio corrigido
// ============================================================
const CONFIG = {
  baseUrl: process.env.SIGILOPAY_BASE_URL || 'https://app.sigilopay.com.br',
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
//  DEBUG — testa vários caminhos candidatos
// ============================================================
app.get('/api/debug', async (req, res) => {
  const candidates = [
    '/',
    '/docs/v1',
    '/docs',
    '/api',
    '/api/v1',
    '/api/v1/',
    '/api/v1/pix',
    '/api/v1/pix/charge',
    '/api/v1/pix/create',
    '/api/v1/transactions',
    '/api/v1/charges',
    '/api/v1/payments',
    '/api/pix',
    '/api/pix/create',
    '/api/pix/charge',
    '/api/transactions',
    '/api/charges',
    '/api/payments',
    '/v1',
    '/v1/',
    '/v1/pix',
    '/v1/pix/charge',
    '/v1/pix/create',
    '/v1/transactions',
    '/v1/charges',
    '/v1/payments',
    '/pix',
    '/pix/charge',
    '/pix/create',
    '/transactions',
    '/charges',
    '/payments',
    '/gateway',
    '/gateway/pix',
    '/gateway/pix/receive',
    '/gateway/transactions',
  ];

  const out = {
    baseUrl: CONFIG.baseUrl,
    authMode: CONFIG.authMode,
    clientId: CONFIG.clientId,
    hasSecret: !!CONFIG.clientSecret,
    tested: candidates.length,
    hits: [],      // só os que responderam
    misses: [],    // os que falharam
  };

  for (const p of candidates) {
    const url = CONFIG.baseUrl + p;
    try {
      const r = await fetch(url, {
        method: 'GET',
        headers: buildHeaders(),
        redirect: 'manual',
      });
      const txt = await r.text();
      const entry = {
        path: p,
        status: r.status,
        statusText: r.statusText,
        body: txt.slice(0, 180),
      };
      // 401/403 = existe mas auth errada (bom sinal!)
      // 404/405 = existe a rota mas método/caminho errado
      // 200 = existe e funciona
      if ([200, 201, 400, 401, 403, 405, 422].includes(r.status)) {
        out.hits.push(entry);
      } else {
        out.misses.push(entry);
      }
    } catch (e) {
      out.misses.push({ path: p, error: String(e).slice(0, 100) });
    }
  }
  res.json(out);
});

// ============================================================
//  CRIAR PIX — tenta vários paths até um funcionar
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

    // Tenta vários caminhos candidatos até um responder
    const paths = [
      '/api/v1/pix/charge',
      '/api/v1/pix',
      '/api/v1/pix/create',
      '/api/v1/transactions',
      '/api/v1/payments',
      '/api/pix/charge',
      '/api/pix/create',
      '/api/pix',
      '/v1/pix/charge',
      '/v1/pix',
      '/v1/transactions',
      '/v1/payments',
      '/pix/charge',
      '/pix/create',
      '/pix',
      '/gateway/pix/receive',
    ];

    const attempts = [];

    for (const p of paths) {
      const url = CONFIG.baseUrl + p;
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: buildHeaders(),
          body: JSON.stringify(payload),
        });
        const txt = await r.text();
        let data;
        try { data = JSON.parse(txt); } catch { data = { raw: txt }; }

        attempts.push({ path: p, status: r.status, body: txt.slice(0, 200) });

        // Se responder 200/201, achamos!
        if (r.status === 200 || r.status === 201) {
          const root = data.data || data;
          const qrBase64 =
            root.qr_code_image || root.qrCodeImage || root.qr_code_base64 ||
            root.qrCodeBase64 || root.qr_code || root.qrCode ||
            root.qrcode || root.qr_code_url || null;
          const copyPaste =
            root.pix_copia_e_cola || root.pixCopiaECola || root.qr_code_text ||
            root.emv || root.payload || root.copy_paste || root.qr_code_string ||
            root.brcode || root.pixCode || null;

          return res.json({
            ok: true,
            usedPath: p,
            transactionId: root.transactionId || root.id || root.txid || root.identifier || null,
            qrBase64,
            copyPaste,
            raw: data,
          });
        }
      } catch (e) {
        attempts.push({ path: p, error: String(e).slice(0, 120) });
      }
    }

    // Nenhum path funcionou — devolve todos os erros para debug
    return res.status(502).json({
      error: 'Nenhum endpoint da SigiloPay respondeu com sucesso',
      baseUrl: CONFIG.baseUrl,
      sent_payload: payload,
      attempts,
    });
  } catch (err) {
    return res.status(502).json({ error: 'Erro no proxy', detail: String(err) });
  }
});

// ============================================================
//  STATUS
// ============================================================
app.get('/api/pix/status/:id', async (req, res) => {
  const id = encodeURIComponent(req.params.id);
  const paths = [
    `/api/v1/pix/charge/${id}`,
    `/api/v1/pix/${id}`,
    `/api/v1/transactions/${id}`,
    `/api/v1/payments/${id}`,
    `/api/pix/${id}`,
    `/v1/pix/charge/${id}`,
    `/v1/transactions/${id}`,
    `/pix/${id}`,
    `/transactions/${id}`,
  ];

  for (const p of paths) {
    try {
      const r = await fetch(CONFIG.baseUrl + p, { headers: buildHeaders() });
      const txt = await r.text();
      let data; try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
      if (r.status === 200) {
        return res.json({ ok: true, usedPath: p, raw: data });
      }
    } catch (_) {}
  }
  return res.status(404).json({ error: 'Status não encontrado em nenhum endpoint' });
});

// ============================================================
//  STATIC
// ============================================================
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Rodando na porta ${PORT} | baseUrl=${CONFIG.baseUrl}`));
