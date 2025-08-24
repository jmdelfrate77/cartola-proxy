// index.js
import express from 'express';
import cors from 'cors';
import axios from 'axios';

const app = express();
app.use(cors());
app.use(express.json());

// ================== CONFIG ==================
const CARTOLA_API = 'https://api.cartolafc.globo.com';
// Se precisar de endpoints privados/ligas privadas, coloque seu token no Railway (Variables)
const GLB_TOKEN = process.env.GLB_TOKEN || ''; // opcional

const headers = {
  'User-Agent': 'Mozilla/5.0',
  'Accept': 'application/json',
  ...(GLB_TOKEN ? { 'X-GLB-Token': GLB_TOKEN } : {}),
};

// Cache simples em memória (alinha/lineup por time)
const lineupCache = new Map(); // key: timeId, value: { ts, atletas: [ids] }
const CACHE_MS = 5 * 60 * 1000; // 5 minutos

// ================== HELPERS ==================
async function getStatus() {
  const url = `${CARTOLA_API}/mercado/status`;
  const { data } = await axios.get(url, { headers });
  return data;
}

async function getPontuados() {
  const url = `${CARTOLA_API}/atletas/pontuados`;
  const { data } = await axios.get(url, { headers });
  // data.atletas = { "123": { atleta_id: 123, pontuacao: 5.2, ... }, ... }
  return data.atletas || {};
}

// tenta plural e singular + URL-Encode do slug
async function getLeague(idOrSlug) {
  const slug = encodeURIComponent(idOrSlug);
  const urls = [
    `${CARTOLA_API}/ligas/${slug}`, // plural
    `${CARTOLA_API}/liga/${slug}`,  // singular (fallback)
  ];

  let lastErr;
  for (const url of urls) {
    try {
      const { data } = await axios.get(url, { headers });
      return data;
    } catch (e) {
      lastErr = e;
      // tenta próxima variação
    }
  }
  throw lastErr;
}

async function getTimeLineup(timeId) {
  const now = Date.now();
  const cached = lineupCache.get(timeId);
  if (cached && (now - cached.ts) < CACHE_MS) return cached.atletas;

  const url = `${CARTOLA_API}/time/id/${timeId}`;
  const { data } = await axios.get(url, { headers });

  // Estruturas possíveis por temporada:
  // - data.atletas = [{ atleta_id }, ...]
  // - data.time?.atletas = [{ atleta_id }, ...]
  // - data?.time?.jogadores etc (ajuste se necessário)
  const arr =
    data?.atletas ||
    data?.time?.atletas ||
    [];

  const atletas = arr.map(a => a.atleta_id).filter(Boolean);
  lineupCache.set(timeId, { ts: now, atletas });
  return atletas;
}

// pega participantes da liga independente do shape
function extrairParticipantesLiga(ligaJson) {
  // alguns formatos comuns:
  // - ligaJson.times
  // - ligaJson.times_participantes
  // - ligaJson.participantes
  // - ligaJson.liga?.times
  // - etc.
  const candidates = [
    ligaJson?.times,
    ligaJson?.times_participantes,
    ligaJson?.participantes,
    ligaJson?.liga?.times,
  ].filter(Boolean);

  for (const c of candidates) {
    if (Array.isArray(c) && c.length) return c;
  }
  return []; // fallback
}

// normaliza cada item de participante → { time_id, nome }
function normalizarParticipante(p) {
  // tentar diversos jeitos
  const timeId = p?.time_id || p?.time?.time_id || p?.time?.id || p?.id_time;
  const nome =
    p?.nome_time ||
    p?.time?.nome ||
    p?.nome ||
    p?.time?.nome_cartola ||
    'Time';
  return { timeId, nome };
}

// ================== ROTAS ==================

// Saúde
app.get('/health', (req, res) => res.json({ ok: true }));

// Status do mercado (para você checar se está fechado/aberto)
app.get('/status', async (req, res) => {
  try {
    const st = await getStatus();
    res.json(st);
  } catch (e) {
    res.status(e?.response?.status || 500).json({
      error: 'STATUS FAIL',
      status: e?.response?.status || null,
      data: e?.response?.data || e.message || null,
    });
  }
});

// Debug da liga — mostra erro detalhado se der ruim
app.get('/debug/league/:league', async (req, res) => {
  try {
    const liga = await getLeague(req.params.league);
    res.json(liga);
  } catch (e) {
    res.status(e?.response?.status || 500).json({
      error: 'LEAGUE DEBUG FAIL',
      status: e?.response?.status || null,
      data: e?.response?.data || e.message || null,
      tried: {
        plural: `/ligas/${encodeURIComponent(req.params.league)}`,
        singular: `/liga/${encodeURIComponent(req.params.league)}`
      }
    });
  }
});

// Debug de lineup/time individual
app.get('/debug/time/:id', async (req, res) => {
  try {
    const atletas = await getTimeLineup(req.params.id);
    res.json({ time_id: req.params.id, atletas });
  } catch (e) {
    res.status(e?.response?.status || 500).json({
      error: 'TIME DEBUG FAIL',
      status: e?.response?.status || null,
      data: e?.response?.data || e.message || null,
    });
  }
});

// Live parciais da liga
app.get('/live/:leagueId', async (req, res) => {
  try {
    // 1) status — checa mercado
    const st = await getStatus();
    const fechado = Number(st?.status_mercado) === 2; // 2 == fechado

    // 2) liga
    const leagueId = req.params.leagueId;
    const liga = await getLeague(leagueId);

    // 3) se mercado está aberto, não há parciais — ainda assim devolvemos shape coerente
    if (!fechado) {
      return res.json({
        liga: liga?.liga || { id: leagueId },
        status_mercado: st?.status_mercado,
        bola_rolando: !!st?.bola_rolando,
        mensagem: 'Mercado aberto — sem parciais disponíveis.',
        resultados: [],
      });
    }

    // 4) parciais (pontuados)
    const pontuados = await getPontuados(); // key: atleta_id (string)

    // 5) participantes
    const participantes = extrairParticipantesLiga(liga);
    const resultados = [];

    for (const p of participantes) {
      const { timeId, nome } = normalizarParticipante(p);
      if (!timeId) continue;

      const atletas = await getTimeLineup(timeId);
      let total = 0;
      for (const id of atletas) {
        const parcial = pontuados[String(id)];
        if (parcial && typeof parcial.pontuacao === 'number') {
          total += parcial.pontuacao;
        }
      }

      resultados.push({
        time_id: timeId,
        nome,
        parcial: Number(total.toFixed(2)),
      });
    }

    resultados.sort((a, b) => b.parcial - a.parcial);

    res.json({
      liga: liga?.liga || { id: leagueId },
      status_mercado: st?.status_mercado,
      bola_rolando: !!st?.bola_rolando,
      atualizacao: new Date().toISOString(),
      resultados,
    });
  } catch (e) {
    console.error('LIVE ERROR:', e?.response?.status, e?.response?.data || e.message);
    res.status(500).json({ error: 'Falha ao obter parciais da liga.' });
  }
});

// ================== START ==================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Proxy Cartola rodando na porta ${PORT}`);
});
