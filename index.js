import express from 'express';
import cors from 'cors';
import axios from 'axios';

const app = express();
app.use(cors());
app.use(express.json());

// ====== CONFIG ======
const CARTOLA_API = 'https://api.cartola.globo.com'; // <- domínio correto
const GLB_TOKEN = process.env.GLB_TOKEN || '';       // opcional, para endpoints autenticados

// Headers padrão
const headers = {
  'User-Agent': 'Mozilla/5.0',
  'Accept': 'application/json',
  ...(GLB_TOKEN ? { 'X-GLB-Token': GLB_TOKEN } : {})
};

// Cache simples do elenco dos times (minimiza chamadas ao /time/id/:id)
const lineupCache = new Map(); // key: timeId, value: { ts, atletas: [ids] }
const CACHE_MS = 5 * 60 * 1000; // 5 minutos

// ====== Helpers ======
async function getLeague(leagueIdOrSlug) {
  const url = `${CARTOLA_API}/ligas/${leagueIdOrSlug}`;
  const { data } = await axios.get(url, { headers });
  return data; // inclui infos da liga + times/participantes (estrutura varia)
}

async function getPontuados() {
  const url = `${CARTOLA_API}/atletas/pontuados`;
  const { data } = await axios.get(url, { headers });
  // formato: { atletas: { "123": { atleta_id, pontuacao, ... }, ... } }
  return data.atletas || {};
}

async function getTimeLineup(timeId) {
  const now = Date.now();
  const cached = lineupCache.get(timeId);
  if (cached && (now - cached.ts) < CACHE_MS) {
    return cached.atletas;
  }

  const url = `${CARTOLA_API}/time/id/${timeId}`;
  const { data } = await axios.get(url, { headers });
  // normalmente: data.atletas = [{ atleta_id, ... }]
  const atletas = (data.atletas || []).map(a => a.atleta_id);
  lineupCache.set(timeId, { ts: now, atletas });
  return atletas;
}

// Alguns formatos de resposta de liga diferem — tente várias chaves comuns
function extrairParticipantesLiga(liga) {
  return (
    liga?.times ||
    liga?.times_participantes ||
    liga?.participantes ||
    liga?.liga?.times ||
    []
  );
}

// ====== Rotas ======
app.get('/', (req, res) => {
  res.send('Cartola Proxy OK. Use /health, /status ou /live/:leagueId');
});

app.get('/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.get('/status', async (req, res) => {
  try {
    const { data } = await axios.get(`${CARTOLA_API}/mercado/status`, { headers });
    res.json(data);
  } catch (e) {
    console.error('STATUS FAIL:', e?.response?.status, e?.response?.data || e.message);
    res.status(500).json({ error: 'Falha ao obter status.' });
  }
});

app.get('/live/:leagueId', async (req, res) => {
  try {
    const leagueId = req.params.leagueId; // slug ou id da liga
    const liga = await getLeague(leagueId);
    const pontuados = await getPontuados(); // só responde quando mercado fechado

    const participantes = extrairParticipantesLiga(liga);
    if (!Array.isArray(participantes) || participantes.length === 0) {
      return res.json({
        aviso: 'Liga sem participantes reconhecidos neste formato.',
        liga: liga?.liga || { id: leagueId },
        resultados: []
      });
    }

    const resultados = [];
    for (const t of participantes) {
      // tente vários formatos
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

    // ordena do maior para o menor
    resultados.sort((a, b) => b.parcial - a.parcial);

    res.json({
      liga: liga?.liga || { id: leagueId },
      atualizacao: new Date().toISOString(),
      resultados
    });
  } catch (e) {
    console.error('LIVE FAIL:', e?.response?.status, e?.response?.data || e.message);
    res.status(500).json({ error: 'Falha ao obter parciais da liga.' });
  }
});

// ====== Start ======
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Proxy Cartola rodando na porta ${PORT}`);
});
