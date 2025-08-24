import express from 'express';
import cors from 'cors';
import axios from 'axios';

const app = express();
app.use(cors()); // libera CORS pro Flutter Web
app.use(express.json());

// CONFIG — ajuste aqui:
const CARTOLA_API = 'https://api.cartolafc.globo.com';
// Se você for usar endpoints autenticados, guarde seu token em variável de ambiente:
const GLB_TOKEN = process.env.GLB_TOKEN || ''; // opcional

// Helper: headers padrão
const headers = {
  'User-Agent': 'Mozilla/5.0',
  'Accept': 'application/json',
  ...(GLB_TOKEN ? { 'X-GLB-Token': GLB_TOKEN } : {})
};

// Cache simples em memória p/ escalar de cada time (minimiza chamadas)
const lineupCache = new Map(); // key: timeId, value: { ts, atletas: [ids] }
const CACHE_MS = 5 * 60 * 1000; // 5 min

async function getLeague(leagueIdOrSlug) {
  // Tenta por ID ou slug (deixe o seu fixo e pronto)
  const url = `${CARTOLA_API}/ligas/${leagueIdOrSlug}`;
  const { data } = await axios.get(url, { headers });
  return data; // contém lista de times/participantes
}

async function getPontuados() {
  const url = `${CARTOLA_API}/atletas/pontuados`;
  const { data } = await axios.get(url, { headers });
  // data.atletas = { "123456": { atleta_id: 123456, pontuacao: 5.2, ... }, ...}
  return data.atletas || {};
}

async function getTimeLineup(timeId) {
  const now = Date.now();
  const cached = lineupCache.get(timeId);
  if (cached && (now - cached.ts) < CACHE_MS) return cached.atletas;

  const url = `${CARTOLA_API}/time/id/${timeId}`;
  const { data } = await axios.get(url, { headers });
  // Normalmente, data.time, data.atletas[], etc (muda por temporada)
  const atletas = (data.atletas || []).map(a => a.atleta_id);
  lineupCache.set(timeId, { ts: now, atletas });
  return atletas;
}

app.get('/live/:leagueId', async (req, res) => {
  try {
    const leagueId = req.params.leagueId; // pode ser slug
    const liga = await getLeague(leagueId);
    const pontuados = await getPontuados(); // só funciona com mercado FECHADO

    // Mapeia participantes -> soma pontuação
    // Ajuste conforme estrutura da sua liga: alguns retornam "times" outros "times" dentro de "times".
    const participantes = liga?.times || liga?.times_participantes || [];
    const resultados = [];

    for (const t of participantes) {
      const timeId = t?.time_id || t?.time?.time_id;
      const nomeTime = t?.nome || t?.time?.nome || t?.nome_time || 'Time';
      if (!timeId) continue;

      const atletas = await getTimeLineup(timeId);
      let total = 0;
      atletas.forEach(id => {
        const p = pontuados[String(id)];
        if (p && typeof p.pontuacao === 'number') total += p.pontuacao;
      });

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
    console.error(e?.response?.status, e?.response?.data || e.message);
    res.status(500).json({ error: 'Falha ao obter parciais da liga.' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Proxy Cartola rodando na porta ${PORT}`));
