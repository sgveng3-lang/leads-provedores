// Utilidades pequenas sem dependência: .env, estado em disco, log enxuto.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export function carregarEnv(caminho = '.env') {
  if (!existsSync(caminho)) return;
  for (const linha of readFileSync(caminho, 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const ARQUIVO_ESTADO = '.dados/estado.json';

// { grupoJid, execucao: {runId, pedido, inicio, porQuem} | null, ultimoRunVisto, ultimaChecagemAgenda }
export function lerEstado() {
  try {
    return JSON.parse(readFileSync(ARQUIVO_ESTADO, 'utf8'));
  } catch {
    return { grupoJid: null, execucao: null, ultimoRunVisto: 0, ultimaChecagemAgenda: 0 };
  }
}

export function salvarEstado(estado) {
  mkdirSync('.dados', { recursive: true });
  writeFileSync(`${ARQUIVO_ESTADO}.tmp`, JSON.stringify(estado));
  renameSync(`${ARQUIVO_ESTADO}.tmp`, ARQUIVO_ESTADO); // escrita atômica
}

const hora = () => new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
export const log = {
  info: (...a) => console.log(hora(), ...a),
  erro: (...a) => console.error(hora(), 'ERRO', ...a),
};

// MEM_LOG=1: registra o uso de memória a cada 2 min (diagnóstico)
if (process.env.MEM_LOG) {
  setInterval(() => {
    const m = process.memoryUsage();
    const mb = (v) => Math.round(v / 1048576);
    console.log(`mem rss=${mb(m.rss)} heap=${mb(m.heapUsed)}/${mb(m.heapTotal)} ext=${mb(m.external)} buf=${mb(m.arrayBuffers)}`);
  }, 120_000).unref();
}
