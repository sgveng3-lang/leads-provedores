// Cliente WhatsApp (zapo-js) enxuto: só a sessão fica em disco (.auth/);
// nenhum histórico de mensagens, conversas ou contatos é guardado.
import { existsSync, mkdirSync } from 'node:fs';
import { ConsoleLogger, createStore, WaClient } from 'zapo-js';
import { createSqliteStore } from '@zapo-js/store-sqlite';
import { log } from './base.js';

const BANCO_AUTH = '.auth/state.sqlite';
export const idsEnviadosPeloBot = new Set(); // pra ignorar o eco das próprias mensagens

let cliente = null;
let store = null;
// motivos de desconexão que indicam conta banida/restrita/desconectada (não é queda de rede)
const MOTIVOS_GRAVES = ['failure_banned', 'failure_locked', 'failure_not_authorized', 'stream_error_device_removed'];
const CODIGOS_GRAVES = [401, 402, 403, 406];
let aoProblemaGrave = () => {};
export function quandoProblemaGrave(fn) { aoProblemaGrave = fn; }

export async function conectar() {
  mkdirSync('.auth', { recursive: true });
  const primeiraVez = !existsSync(BANCO_AUTH);
  const sqlite = createSqliteStore({ path: BANCO_AUTH, driver: 'auto' });
  store = createStore({
    backends: { sqlite },
    providers: {
      auth: 'sqlite', signal: 'sqlite', preKey: 'sqlite', session: 'sqlite', identity: 'sqlite',
      senderKey: 'sqlite', appState: 'sqlite', privacyToken: 'sqlite',
      messages: 'memory', threads: 'none', contacts: 'none',
    },
    memory: { limits: { messages: 20, groupMetadataGroups: 5, chatMetadataChats: 5, deviceListUsers: 100 } },
  });

  cliente = new WaClient({ store, sessionId: 'default' }, new ConsoleLogger(process.env.LOG_LEVEL || 'warn'));
  cliente.on('connection', (e) => {
    log.info(`whatsapp: ${e.status} ${e.reason ?? ''} ${e.code ?? ''}`);
    if (e.status === 'close' && (e.isLogout || MOTIVOS_GRAVES.includes(e.reason) || CODIGOS_GRAVES.includes(e.code))) {
      Promise.resolve(aoProblemaGrave(`${e.reason}${e.code ? ` (${e.code})` : ''}`)).catch(() => {});
    }
  });
  await cliente.connect();

  if (primeiraVez) {
    const codigo = await cliente.auth.requestPairingCode(process.env.WHATSAPP_NUMERO);
    log.info(`>>> CÓDIGO DE PAREAMENTO: ${codigo.match(/.{1,4}/g)?.join('-') ?? codigo} <<<`);
    log.info('No celular do número do bot: WhatsApp > Dispositivos conectados > Conectar com número de telefone.');
  }
  return cliente;
}

// Desligamento limpo (o Discloud manda SIGTERM ao atualizar/reiniciar): fecha o WhatsApp e o
// SQLite da sessão ANTES de sair. Sem isso o processo saía com o banco aberto e o better-sqlite3
// às vezes quebrava na saída (código 139, 06/10/2026), e o Discloud não religava sozinho.
export async function encerrar() {
  if (cliente) await cliente.disconnect().catch(() => {});
  if (store) await store.destroy().catch(() => {});
  cliente = null;
  store = null;
}

export async function acharGrupo(nome) {
  const grupos = await cliente.group.queryAllGroups();
  const alvo = nome.trim().toLowerCase();
  return grupos.find((g) => (g.subject || '').trim().toLowerCase() === alvo)?.jid ?? null;
}

export async function enviar(jid, texto) {
  const r = await cliente.message.send(jid, texto);
  if (r?.id) {
    idsEnviadosPeloBot.add(r.id);
    setTimeout(() => idsEnviadosPeloBot.delete(r.id), 60_000);
  }
}

export function textoDa(message) {
  return message?.conversation ?? message?.extendedTextMessage?.text ?? '';
}

// Quais destes celulares (só dígitos, com DDD, sem 55) têm WhatsApp. Não manda mensagem nenhuma.
// Devolve [{ numero, pn, lid }] na mesma ordem, só os que existem (pn = número canônico do servidor).
export async function comWhatsapp(numeros) {
  const r = await cliente.profile.getLidsByPhoneNumbers(numeros.map((n) => `55${n}`));
  return numeros.map((n) => {
    const x = r.find((y) => usuario(y.queriedJid) === `55${n}`) || r.find((y) => usuario(y.phoneJid).endsWith(n.slice(-8)));
    return x && x.exists ? { numero: n, pn: usuario(x.phoneJid), lid: x.lidJid ? usuario(x.lidJid) : null } : null;
  }).filter(Boolean);
}

// Tipo de conta de cada número (pn = só dígitos com 55), sem mandar mensagem:
// 'pessoal' (WhatsApp comum — no provedor pequeno, geralmente o celular de uma pessoa),
// 'empresa' (WhatsApp Business) ou 'api' (plataforma de atendimento: quase sempre robô).
export async function tiposDeConta(pns) {
  const r = await cliente.business.getVerifiedNames(pns.map((pn) => `${pn}@s.whatsapp.net`));
  const porPn = new Map(r.map((x) => [usuario(x.jid), x.verifiedName]));
  return pns.map((pn) => {
    const vn = porPn.get(pn);
    return !vn ? 'pessoal' : vn.isApi ? 'api' : 'empresa';
  });
}

// Documento lido do disco só na hora (a biblioteca abre o arquivo e transmite em partes).
export async function enviarDocumento(jid, caminho, nomeArquivo, legenda) {
  await cliente.message.send(jid, { type: 'document', media: caminho, mimetype: 'application/pdf', fileName: nomeArquivo, caption: legenda });
}

// "5511999998888:3@s.whatsapp.net" → "5511999998888"; "12345@lid" → "12345"
export function usuario(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}
