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
];
const COLUNAS_DO_USUARIO = ['Status', 'Observações'];
const COLUNAS_EXECUCOES = ['Data', 'Pedido', 'Filtros', 'Provedores', 'Novos', 'Atualizados', 'Com e-mail', 'Com WhatsApp', 'Duração (min)'];

function doGet() {
  return json_({ ok: true, servico: 'leads-provedores' });
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
      const linha = COLUNAS.map((c) => (c === 'Primeira captura' || c === 'Atualizado em') ? agora : (c === 'Status' ? 'Novo' : (dados[c] ?? '')));
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
