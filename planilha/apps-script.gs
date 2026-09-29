/**
 * Recebe os leads do scraper (GitHub Actions) e grava na planilha.
 *
 * Instalação: na planilha "Leads Provedores" → Extensões → Apps Script →
 * cole este arquivo inteiro em Código.gs → Configurações do projeto (⚙) →
 * Propriedades do script → adicione TOKEN = <conteúdo de segredos/token-planilha.txt>
 * → Implantar → Nova implantação → App da Web (Executar como: Eu; Quem pode
 * acessar: Qualquer pessoa) → copie a URL /exec.
 *
 * Sem o TOKEN certo nada é gravado. A URL sozinha não dá acesso a nada.
 *
 * Aba "Provedores": uma linha por CNPJ. O scraper atualiza as colunas de
 * dados; as colunas STATUS e OBSERVAÇÕES são suas e nunca são sobrescritas.
 * Aba "Execuções": uma linha por raspagem (log).
 */

const ABA_PROVEDORES = 'Provedores';
const ABA_EXECUCOES = 'Execuções';

const COLUNAS = [
  'CNPJ', 'Empresa (Anatel)', 'Nome fantasia', 'Grupo econômico', 'Porte',
  'UF principal', 'UFs', 'Municípios', 'Acessos', 'Mês ref. Anatel',
  'E-mail (Receita)', 'Telefone (Receita)', 'Situação (Receita)',
  'Site', 'E-mails do site', 'WhatsApp', 'Telefones do site',
  'Status', 'Observações', 'Primeira captura', 'Atualizado em',
  'Enviado em', 'Enviado para', 'Já enviado',
];
// colunas que o scraper nunca sobrescreve (suas + as do envio de e-mail)
const COLUNAS_DO_USUARIO = ['Status', 'Observações', 'Enviado em', 'Enviado para', 'Já enviado'];
const COLUNAS_EXECUCOES = ['Data', 'Pedido', 'Filtros', 'Provedores', 'Novos', 'Atualizados', 'Com e-mail', 'Com WhatsApp', 'Duração (min)'];

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.sair) return descadastrar_(String(p.sair), String(p.t || ''));
  return json_({ ok: true, servico: 'leads-provedores' });
}

// assinatura do link de descadastro: HMAC-SHA256(cnpj, TOKEN), 16 primeiros caracteres
function assinatura_(cnpj) {
  const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  const bytes = Utilities.computeHmacSha256Signature(cnpj, token);
  return Utilities.base64EncodeWebSafe(bytes).slice(0, 16);
}

function descadastrar_(cnpj, t) {
  const html = (msg) => HtmlService.createHtmlOutput(
    '<div style="font-family:sans-serif;max-width:520px;margin:60px auto;text-align:center"><h2>' + msg + '</h2></div>');
  if (t !== assinatura_(cnpj)) return html('Link inválido.');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const aba = aba_(ABA_PROVEDORES, COLUNAS);
    const n = aba.getLastRow() - 1;
    const cnpjs = n > 0 ? aba.getRange(2, 1, n, 1).getDisplayValues() : [];
    const i = cnpjs.findIndex((l) => l[0] === cnpj);
    if (i >= 0) aba.getRange(i + 2, COLUNAS.indexOf('Status') + 1).setValue('Descadastrado');
  } finally {
    lock.releaseLock();
  }
  return html('Pronto! Você não vai receber mais e-mails nossos.');
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000); // duas raspagens ao mesmo tempo não se atropelam
  try {
    const corpo = JSON.parse(e.postData.contents);
    const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
    if (!token || corpo.token !== token) return json_({ ok: false, erro: 'token inválido' });

    if (corpo.acao === 'upsert') return json_(upsert_(corpo.linhas || []));
    if (corpo.acao === 'execucao') return json_(registrarExecucao_(corpo.execucao || {}));
    if (corpo.acao === 'cnpjs') return json_({ ok: true, cnpjs: cnpjsExistentes_() });
    if (corpo.acao === 'pendentes') return json_(pendentes_(corpo.quantidade || 20));
    if (corpo.acao === 'marcar_enviado') return json_(marcarEnviado_(corpo.cnpj, corpo.para, corpo.status));
    return json_({ ok: false, erro: 'ação desconhecida' });
  } catch (erro) {
    return json_({ ok: false, erro: String(erro) });
  } finally {
    lock.releaseLock();
  }
}

function aba_(nome, cabecalho) {
  const planilha = SpreadsheetApp.getActiveSpreadsheet();
  let aba = planilha.getSheetByName(nome);
  if (!aba) {
    aba = planilha.insertSheet(nome);
    aba.getRange(1, 1, 1, cabecalho.length).setValues([cabecalho]).setFontWeight('bold');
    aba.setFrozenRows(1);
  }
  return aba;
}

function cnpjsExistentes_() {
  const aba = aba_(ABA_PROVEDORES, COLUNAS);
  const n = aba.getLastRow() - 1;
  if (n < 1) return [];
  return aba.getRange(2, 1, n, 1).getDisplayValues().map((l) => l[0]);
}

function upsert_(linhas) {
  const aba = aba_(ABA_PROVEDORES, COLUNAS);
  aba.getRange(1, 1, 1, COLUNAS.length).setValues([COLUNAS]).setFontWeight('bold');
  const agora = Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'yyyy-MM-dd HH:mm');
  const total = aba.getLastRow() - 1;
  const atuais = total > 0 ? aba.getRange(2, 1, total, COLUNAS.length).getValues() : [];
  const indicePorCnpj = {};
  atuais.forEach((l, i) => { indicePorCnpj[String(l[0])] = i; });

  let novos = 0, atualizados = 0;
  linhas.forEach((dados) => {
    const cnpj = String(dados['CNPJ'] || '');
    if (!cnpj) return;
    const i = indicePorCnpj[cnpj];
    if (i === undefined) {
      const linha = COLUNAS.map((c) => (c === 'Primeira captura' || c === 'Atualizado em') ? agora
        : (c === 'Status' ? 'Novo' : (c === 'Já enviado' ? 'NÃO' : (dados[c] ?? ''))));
      atuais.push(linha);
      indicePorCnpj[cnpj] = atuais.length - 1;
      novos++;
    } else {
      COLUNAS.forEach((c, j) => {
        if (COLUNAS_DO_USUARIO.includes(c) || c === 'Primeira captura') return;
        if (c === 'Atualizado em') { atuais[i][j] = agora; return; }
        // não apaga um dado bom com um vazio (ex.: site fora do ar nesta rodada)
        if (dados[c] !== undefined && dados[c] !== '') atuais[i][j] = dados[c];
      });
      atualizados++;
    }
  });

  if (atuais.length) {
    const intervalo = aba.getRange(2, 1, atuais.length, COLUNAS.length);
    intervalo.setNumberFormat('@'); // CNPJ e telefones como texto (sem perder zeros)
    intervalo.setValues(atuais);
  }
  return { ok: true, novos: novos, atualizados: atualizados, total: atuais.length };
}

// Próximos leads pra receber e-mail: Status "Novo" (ou vazio), sem envio anterior,
// com algum e-mail. Maiores provedores primeiro.
function pendentes_(quantidade) {
  const aba = aba_(ABA_PROVEDORES, COLUNAS);
  aba.getRange(1, 1, 1, COLUNAS.length).setValues([COLUNAS]).setFontWeight('bold');
  const n = aba.getLastRow() - 1;
  if (n < 1) return { ok: true, leads: [], enviados: [] };
  const col = {};
  COLUNAS.forEach((c, i) => { col[c] = i; });
  const linhas = aba.getRange(2, 1, n, COLUNAS.length).getDisplayValues();

  // "Já enviado" = SIM é o controle; linhas antigas sem a coluna preenchida contam
  // como SIM se já têm data de envio (e a planilha é corrigida aqui mesmo)
  const jaEnviado = linhas.map((l) => l[col['Já enviado']] === 'SIM' || (!!l[col['Enviado em']]));
  const corrigir = linhas.map((l, i) => [jaEnviado[i] ? 'SIM' : (l[col['Já enviado']] || 'NÃO')]);
  aba.getRange(2, col['Já enviado'] + 1, n, 1).setValues(corrigir);

  // endereços que já receberam e-mail (por qualquer CNPJ): o envio não repete
  const enviados = linhas.map((l) => String(l[col['Enviado para']] || '').replace(/^RECUSADO\s+|^REPETIDO\s+/, '').toLowerCase())
    .filter((e) => e.includes('@'));

  const leads = linhas
    .filter((l, i) => !jaEnviado[i] && ['', 'Novo'].includes(l[col['Status']])
      && (l[col['E-mails do site']] || l[col['E-mail (Receita)']]))
    .map((l) => ({
      cnpj: l[col['CNPJ']], empresa: l[col['Empresa (Anatel)']], fantasia: l[col['Nome fantasia']],
      uf: l[col['UF principal']], municipios: l[col['Municípios']], acessos: Number(String(l[col['Acessos']]).replace(/\D/g, '')) || 0,
      emailReceita: l[col['E-mail (Receita)']], emailsSite: l[col['E-mails do site']],
    }))
    .sort((a, b) => b.acessos - a.acessos)
    .slice(0, quantidade);
  // assinatura do descadastro só pros escolhidos (calcular pra milhares estoura o tempo do Google)
  leads.forEach((lead) => { lead.sair = assinatura_(lead.cnpj); });
  return { ok: true, leads: leads, enviados: Array.from(new Set(enviados)) };
}

function marcarEnviado_(cnpj, para, status) {
  const aba = aba_(ABA_PROVEDORES, COLUNAS);
  const n = aba.getLastRow() - 1;
  const cnpjs = n > 0 ? aba.getRange(2, 1, n, 1).getDisplayValues() : [];
  const i = cnpjs.findIndex((l) => l[0] === cnpj);
  if (i < 0) return { ok: false, erro: 'cnpj não encontrado' };
  const linha = i + 2;
  const agora = Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'yyyy-MM-dd HH:mm');
  aba.getRange(linha, COLUNAS.indexOf('Status') + 1).setValue(status || 'Enviado');
  aba.getRange(linha, COLUNAS.indexOf('Já enviado') + 1).setValue('SIM');
  aba.getRange(linha, COLUNAS.indexOf('Enviado em') + 1).setValue(agora);
  aba.getRange(linha, COLUNAS.indexOf('Enviado para') + 1).setValue(para || '');
  return { ok: true };
}

function registrarExecucao_(ex) {
  const aba = aba_(ABA_EXECUCOES, COLUNAS_EXECUCOES);
  const agora = Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'yyyy-MM-dd HH:mm');
  aba.appendRow([agora, ex.pedido || '', ex.filtros || '', ex.provedores || 0, ex.novos || 0,
    ex.atualizados || 0, ex.comEmail || 0, ex.comWhatsapp || 0, ex.duracaoMin || 0]);
  return { ok: true, url: SpreadsheetApp.getActiveSpreadsheet().getUrl() };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
