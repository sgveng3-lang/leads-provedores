// Cliente WhatsApp (zapo-js) enxuto: só a sessão fica em disco (.auth/);
// nenhum histórico de mensagens, conversas ou contatos é guardado.
import { existsSync, mkdirSync } from 'node:fs';
import { ConsoleLogger, createStore, WaClient } from 'zapo-js';
import { createSqliteStore } from '@zapo-js/store-sqlite';
import { log } from './base.js';

const BANCO_AUTH = '.auth/state.sqlite';
export const idsEnviadosPeloBot = new Set(); // pra ignorar o eco das próprias mensagens

let cliente = null;

export async function conectar() {
  mkdirSync('.auth', { recursive: true });
  const primeiraVez = !existsSync(BANCO_AUTH);
  const sqlite = createSqliteStore({ path: BANCO_AUTH, driver: 'auto' });
  const store = createStore({
    backends: { sqlite },
    providers: {
      auth: 'sqlite', signal: 'sqlite', preKey: 'sqlite', session: 'sqlite', identity: 'sqlite',
      senderKey: 'sqlite', appState: 'sqlite', privacyToken: 'sqlite',
      messages: 'memory', threads: 'none', contacts: 'none',
    },
    memory: { limits: { messages: 20, groupMetadataGroups: 5, chatMetadataChats: 5, deviceListUsers: 100 } },
  });

  cliente = new WaClient({ store, sessionId: 'default' }, new ConsoleLogger(process.env.LOG_LEVEL || 'warn'));
  cliente.on('connection', (e) => log.info(`whatsapp: ${e.status} ${e.reason ?? ''}`));
  await cliente.connect();

  if (primeiraVez) {
    const codigo = await cliente.auth.requestPairingCode(process.env.WHATSAPP_NUMERO);
    log.info(`>>> CÓDIGO DE PAREAMENTO: ${codigo.match(/.{1,4}/g)?.join('-') ?? codigo} <<<`);
    log.info('No celular do número do bot: WhatsApp > Dispositivos conectados > Conectar com número de telefone.');
  }
  return cliente;
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
