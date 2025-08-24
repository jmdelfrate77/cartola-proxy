import express from 'express';
import cors from 'cors';
import axios from 'axios';

const app = express();
app.use(cors());
app.use(express.json());

// ===== CONFIG =====
const CARTOLA_API = 'https://api.cartola.globo.com'; // <- ajuste principal
const GLB_TOKEN = process.env.GLB_TOKEN || ''; // opcional se usar rotas autenticadas

const http = axios.create({
  baseURL: CARTOLA_API,
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0',
    'Accept': 'application/json',
    ...(GLB_TOKEN ? { 'X-GLB-Token': GLB_TOKEN } : {})
  }
});

// Cache simples p/ escalação
const lineupCache = new Map(); // key: timeId, value: { ts, atletas }
const CACHE_MS = 5 * 60 * 1000;

// ===== Helpers =====
async function getLeague(leagueIdOrSlug) {
  const { data } = await http.get(`/ligas/${leagueIdOrSlug}`);
  return data;
}

async function getMercadoStatus() {
  const { data } = await http.get('/mercado/status');
  return data; // { rodada_atual, status_mercado, ... }
}

async function getPontuados() {
  const { data } = await http.get('/atletas/pontuados');
  return data.atletas || {}; // { "1234": { atleta_id, pontuacao, ... }, ... }
}

async function getTimeLineup(timeId) {
  const now = Date.now();
  const cached = lineupCache.get(timeId);
  if (cached && (now - cached.ts) < CACHE_MS) return cached.atletas;

  const { data } = await http.get(`/time/id/${timeId}`);
  const atletas = Array.isArray(data?.atletas)
    ? data.atletas.map(a => a.atleta_id).filter(Boolean)
    : [];
  lineupCache.set(timeId, { ts: now, atletas });
  return atletas;
}

// Tenta extrair participantes de diferentes formatos
function extrairParticipantesLiga(liga) {
  // formatos comuns:
  // - liga.times (array)
  // - liga.times_participantes (array)
  // - liga.liga?.times (obj ou array)
  // Vamos ser flexíveis:
  if (Array.isArray(liga?.times)) return liga.times;
  if (Array.isArray(liga?.times_participantes)) return liga.times_participantes;

  // às vezes vem algo como { liga: { times: [...] } }
  if (Array.isArray(liga?.liga?.times)) return liga.liga.times;

  // fallback: nada
  return [];
}

// ===== Rotas utilitárias =====
app.get('/health', (req, res) => res.type('text').send('ok'));

app.get('/status', async (req, res) => {
  try {
    const st = await getMercadoStatus();
    res.json(st);
  } catch (e) {
    console.error('STATUS FAIL:', e?.response?.status, e?.response?.data || e.message);
    res.status(500).json({ error: 'Falha ao obter status do mercado.' });
  }
});

// ===== Live da liga =====
app.get('/live/:leagueId', async (req, res) => {
  const leagueId = req.params.leagueId;
  try {
    const [liga, statusMercado] = await Promise.all([
      getLeague(leagueId),
      getMercadoStatus(),
    ]);

    // Se o mercado estiver ABERTO, /atletas/pontuados costuma não retornar parciais
    // Ainda assim tentamos, mas avisamos no metadata
    const pontuados = await getPontuados();

    const participantes = extrairParticipantesLiga(liga);
    if (!Array.isArray(participantes) || participantes.length === 0) {
      console.warn('Liga sem participantes reconhecidos. Payload liga:', Object.keys(liga || {}));
      return res.json({
        liga: liga?.liga || { id: leagueId },
        mercado_status: statusMercado,
        atualizacao: new Date().toISOString(),
        resultados: [],
        aviso: 'Não consegui identificar participantes desta liga.'
      });
    }

    const resultados = [];
    for (const t of participantes) {
      const timeId = t?.time_id || t?.time?.time_id;
      const nomeTime = t?.nome || t?.time?.nome || t?.nome_time || 'Time';
      if (!timeId) continue;

      const atletas = await getTimeLineup(timeId);
      let total = 0;
      for (const id of atletas) {
        const p = pontuados[String(id)];
        if (p && typeof p.pontuacao === 'number') total += p.pontuacao;
      }

      resultados.push({
        time_id: timeId,
        nome: nomeTime,
        parcial: Number(total.toFixed(2)),
      });
    }

    resultados.sort((a, b) => b.parcial - a.parcial);

    res.json({
      liga: liga?.liga || { id: leagueId },
      mercado_status: statusMercado,
      atualizacao: new Date().toISOString(),
      resultados
    });
  } catch (e) {
    console.error('LIVE FAIL:', e?.response?.status, e?.response?.data || e.message);
    res.status(500).json({ error: 'Falha ao obter parciais da liga.' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Proxy Cartola rodando na porta ${PORT}`));
