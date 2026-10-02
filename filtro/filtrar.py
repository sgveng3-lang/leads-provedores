"""Filtro fiscal mensal (dia 1º): refaz a aba "alvo" da planilha.

    python filtro/filtrar.py                 # tudo (baixa a PGFN, consulta CNPJs, grava a aba alvo)
    python filtro/filtrar.py --pgfn DIR      # usa zips da PGFN já baixados nessa pasta
    python filtro/filtrar.py --simular       # não grava na planilha

1. Lê os CNPJs da aba Provedores (só leitura) e os dados da Anatel (_dados/base.json.gz,
   o mesmo cache da raspagem).
2. Fica só com os pequenos: porte "Pequeno Porte" na Anatel e 200–20.000 acessos.
3. Cruza com a Dívida Ativa da União (dados abertos da PGFN, trimestral): o trimestre
   mais recente e o de 2 anos antes (quem saiu da lista = "Já quitou").
4. Completa porte/Simples/e-mail/atividade (CNAE) pelas APIs de CNPJ, com cache de 90 dias.
5. Grava a aba "alvo" (ação aba_alvo do Apps Script, que preserva as colunas de controle
   do envio: Status, Observações, Enviado em, Enviado para, Já enviado).

Repositório público: o log e o resumo só têm contagens, nunca nomes/e-mails.
"""

import argparse
import gzip
import io
import json
import os
import re
import sys
import time
import zipfile
from collections import Counter
from pathlib import Path

import requests

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ / "scraper"))
from planilha import Planilha  # noqa: E402

DADOS = RAIZ / "_dados"
BASE = DADOS / "base.json.gz"
CACHE = DADOS / "fiscal_cache.json.gz"
CACHE_DIAS = 90
PGFN = "https://dadosabertos.pgfn.gov.br/"
BASES_PGFN = {"Nao_Previdenciario": "Federal", "Previdenciario": "INSS", "FGTS": "FGTS"}
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      "Accept": "application/json"}
ORDEM_PRIORIDADE = {"Alta": 0, "Média": 1, "Baixa": 2}

CABECALHO = ["CNPJ", "Empresa (Anatel)", "Razão social", "UF", "Municípios", "Acessos",
             "Porte (Receita)", "Simples Nacional", "Perfil fiscal", "Prioridade",
             "Pagando (R$)", "Em cobrança (R$)", "Em cobrança na Justiça (R$)", "Em discussão (R$)",
             "Dívida em 2024 (R$)", "Tipos de dívida", "Inscrições atuais", "Dívida mais antiga", "E-mail (Receita)",
             "Atividade principal (CNAE)"]
FORMATOS = {"5": "#,##0", **{str(i): '"R$" #,##0.00' for i in (10, 11, 12, 13, 14)}}


# ---------------- PGFN ----------------
def trimestres_disponiveis():
    html = requests.get(PGFN, timeout=120, headers=UA).text
    return sorted(set(re.findall(r"(\d{4}_trimestre_0[1-4])/", html)))


def anos_antes(trimestre, anos=2):
    ano, _, t = trimestre.split("_")
    return f"{int(ano) - anos}_trimestre_{t}"


def baixar(trimestre, base, pasta):
    """Baixa (retomando se cair) e confere o zip. Devolve o caminho."""
    destino = pasta / f"{trimestre}_{base}.zip"
    url = f"{PGFN}{trimestre}/Dados_abertos_{base}.zip"
    total = int(requests.head(url, timeout=120, headers=UA, allow_redirects=True).headers.get("Content-Length", 0))
    for tentativa in range(8):
        feito = destino.stat().st_size if destino.exists() else 0
        if total and feito >= total:
            break
        try:
            with requests.get(url, headers={**UA, "Range": f"bytes={feito}-"} if feito else UA, stream=True, timeout=300) as r:
                r.raise_for_status()
                modo = "ab" if feito and r.status_code == 206 else "wb"
                with open(destino, modo) as f:
                    for bloco in r.iter_content(1 << 20):
                        f.write(bloco)
        except requests.RequestException as erro:
            print(f"  pgfn {trimestre} {BASES_PGFN[base]}: tentativa {tentativa + 1} falhou ({type(erro).__name__})", flush=True)
            time.sleep(20 * (tentativa + 1))
    with zipfile.ZipFile(destino) as z:  # BadZipFile aqui = arquivo incompleto
        z.namelist()
    return destino


def categoria(tipo, situacao):
    s = situacao.upper()
    if tipo.startswith("Benef") or "PARCEL" in s or "NEGOCIA" in s:
        return "pagando"
    if tipo.startswith("Em cobran"):
        return "cobranca"
    return "discussao"  # garantia, suspensa por decisão judicial etc.


def ler_trimestre(trimestre, pasta, raiz_para_cnpj):
    """{cnpj: [inscrições]} só dos CNPJs da planilha (casados pela raiz de 8 dígitos)."""
    dividas = {}
    for base, nome in BASES_PGFN.items():
        inicio = time.time()
        with zipfile.ZipFile(baixar(trimestre, base, pasta)) as z:
            for membro in z.namelist():
                with z.open(membro) as f:
                    texto = io.TextIOWrapper(f, encoding="latin-1", newline="")
                    cab = next(texto).rstrip("\r\n").split(";")
                    i = {n: k for k, n in enumerate(cab)}
                    for linha in texto:
                        cnpj = raiz_para_cnpj.get(linha[:10])  # "12.345.678" = raiz formatada
                        if not cnpj:
                            continue
                        p = linha.rstrip("\r\n").split(";")
                        if p[i["TIPO_DEVEDOR"]].upper() != "PRINCIPAL":  # federal vem em maiúsculas
                            continue
                        dividas.setdefault(cnpj, []).append({
                            "base": nome,
                            "cat": categoria(p[i["TIPO_SITUACAO_INSCRICAO"]], p[i["SITUACAO_INSCRICAO"]]),
                            "ajuizada": p[i["INDICADOR_AJUIZADO"]].upper() == "SIM",
                            "valor": float(p[i["VALOR_CONSOLIDADO"]] or 0),
                            "data": p[i["DATA_INSCRICAO"]],
                        })
        print(f"  pgfn {trimestre} {nome}: lido em {time.time() - inicio:.0f}s", flush=True)
    return dividas


# ---------------- dados do CNPJ (porte, Simples, e-mail, CNAE) ----------------
PORTES = {"ME": "Microempresa (ME)", "MICRO EMPRESA": "Microempresa (ME)", "MICROEMPRESA": "Microempresa (ME)",
          "EPP": "Empresa de Pequeno Porte (EPP)", "EMPRESA DE PEQUENO PORTE": "Empresa de Pequeno Porte (EPP)",
          "DEMAIS": "Demais"}


def _porte(texto):
    t = (texto or "").strip().upper()
    return PORTES.get(t, texto or "")


def _get(url):
    try:
        r = requests.get(url, headers=UA, timeout=30)
    except requests.RequestException:
        return None
    if r.status_code == 404:
        return {}
    if r.status_code != 200:
        return None
    try:
        return r.json()
    except ValueError:
        return None


def _cnae(cod, desc):
    cod = re.sub(r"\D", "", str(cod or ""))
    return f"{cod} - {desc}" if cod else ""


def _opencnpj(c):
    d = _get(f"https://api.opencnpj.org/{c}")
    if not d:
        return d
    excl = d.get("data_exclusao_simples") or ""
    return {"razao": d.get("razao_social", ""), "porte": _porte(d.get("porte_empresa")),
            "simples": "Sim" if d.get("opcao_simples") == "S" else (f"Excluído em {excl}" if excl and excl != "0000-00-00" else "Não"),
            "email": (d.get("email") or "").lower(),
            "cnae": _cnae(d.get("cnae_principal"), next((x.get("descricao", "") for x in d.get("cnaes", []) if x.get("is_principal")), ""))}


def _cnpja(c):
    d = _get(f"https://open.cnpja.com/office/{c}")
    if not d:
        return d
    emp = d.get("company") or {}
    simples = emp.get("simples") or {}
    emails = [e.get("address", "").lower() for e in d.get("emails") or [] if e.get("address")]
    return {"razao": emp.get("name", ""), "porte": _porte((emp.get("size") or {}).get("acronym")),
            "simples": "Sim" if simples.get("optant") else "Não", "email": emails[0] if emails else "",
            "cnae": _cnae((d.get("mainActivity") or {}).get("id"), (d.get("mainActivity") or {}).get("text", ""))}


def _receitaws(c):
    d = _get(f"https://receitaws.com.br/v1/cnpj/{c}")
    if d is None or d.get("status") == "ERROR":
        return None
    s = d.get("simples") or {}
    excl = s.get("data_exclusao") or ""
    a = (d.get("atividade_principal") or [{}])[0]
    return {"razao": d.get("nome", ""), "porte": _porte(d.get("porte")),
            "simples": "Sim" if s.get("optante") else (f"Excluído em {excl}" if excl else "Não"),
            "email": (d.get("email") or "").lower(), "cnae": _cnae(a.get("code"), a.get("text", ""))}


# função, segundos entre consultas, próximo uso
APIS = [[_opencnpj, 0.6, 0.0], [_cnpja, 12, 0.0], [_receitaws, 21, 0.0]]


def consultar_cnpj(c):
    for _ in range(30):
        api = min(APIS, key=lambda a: a[2])
        espera = api[2] - time.time()
        if espera > 0:
            time.sleep(espera)
        r = api[0](c)
        api[2] = time.time() + (api[1] if r is not None else max(api[1] * 3, 60))  # falhou: a API descansa
        if r is not None:
            return r
    return None


# ---------------- montagem ----------------
def perfil(cnpj, atual, antigo):
    a = atual.get(cnpj, [])
    if not a:
        return ("Já quitou", "Alta") if cnpj in antigo else (None, None)
    cats = {d["cat"] for d in a}
    if "cobranca" not in cats:
        return ("Pagando", "Alta") if "pagando" in cats else ("Em discussão", "Baixa")
    if "pagando" in cats:
        return "Pagando em parte", "Média"
    if any(d["ajuizada"] for d in a if d["cat"] == "cobranca"):
        return "Devendo na Justiça", "Baixa"
    return "Devendo", "Média"


def soma(lst, **filtro):
    return round(sum(d["valor"] for d in lst if all(d[k] == v for k, v in filtro.items())), 2)


def ler_gz(caminho, padrao):
    try:
        with gzip.open(caminho, "rt", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return padrao


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pgfn", default=str(DADOS / "pgfn"), help="pasta dos zips da PGFN (baixa o que faltar)")
    ap.add_argument("--min-acessos", type=int, default=200)
    ap.add_argument("--max-acessos", type=int, default=20000)
    ap.add_argument("--simular", action="store_true", help="não grava na planilha")
    ap.add_argument("--pedido", default="manual")
    args = ap.parse_args()
    inicio = time.time()
    pasta = Path(args.pgfn)
    pasta.mkdir(parents=True, exist_ok=True)

    planilha = Planilha()
    cnpjs = {re.sub(r"\D", "", c).zfill(14) for c in planilha.cnpjs() if re.sub(r"\D", "", c)}
    anatel = ler_gz(BASE, {}).get("provedores", {})
    if not anatel:
        raise SystemExit(f"sem dados da Anatel em {BASE} (rode scraper/main.py base)")
    pequenos = {c for c in cnpjs if anatel.get(c, {}).get("porte") == "Pequeno Porte"
                and args.min_acessos <= anatel[c].get("acessos", 0) <= args.max_acessos}
    raiz_para_cnpj = {}
    for c in sorted(pequenos):
        raiz_para_cnpj.setdefault(f"{c[0:2]}.{c[2:5]}.{c[5:8]}", c)
    print(f"planilha: {len(cnpjs)} CNPJs; pequenos: {len(pequenos)}", flush=True)

    trimestres = trimestres_disponiveis()
    t_atual = trimestres[-1]
    t_antigo = anos_antes(t_atual) if anos_antes(t_atual) in trimestres else trimestres[0]
    print(f"pgfn: {t_atual} x {t_antigo}", flush=True)
    atual = ler_trimestre(t_atual, pasta, raiz_para_cnpj)
    antigo = ler_trimestre(t_antigo, pasta, raiz_para_cnpj)
    candidatos = sorted(set(atual) | set(antigo))
    print(f"cruzaram com a PGFN: {len(candidatos)}", flush=True)

    cache = ler_gz(CACHE, {})
    validade = time.time() - CACHE_DIAS * 86400
    faltam = [c for c in candidatos if cache.get(c, {}).get("_em", 0) < validade]
    print(f"dados de CNPJ: {len(candidatos) - len(faltam)} no cache, {len(faltam)} a consultar", flush=True)
    sem_dados = 0
    for n, c in enumerate(faltam, 1):
        r = consultar_cnpj(c)
        if r is None:
            sem_dados += 1
        else:
            cache[c] = {**r, "_em": time.time()}
        if n % 100 == 0:
            print(f"  consultados {n}/{len(faltam)}", flush=True)
    DADOS.mkdir(exist_ok=True)
    with gzip.open(CACHE, "wt", encoding="utf-8") as f:
        json.dump(cache, f)

    linhas = []
    for c in candidatos:
        p, prio = perfil(c, atual, antigo)
        if not p:
            continue
        prov, r, a, v = anatel[c], cache.get(c, {}), atual.get(c, []), antigo.get(c, [])
        datas = sorted((d["data"][6:] + d["data"][3:5] + d["data"][:2], d["data"]) for d in a + v if len(d["data"]) == 10)
        linhas.append([
            f"{c[:2]}.{c[2:5]}.{c[5:8]}/{c[8:12]}-{c[12:]}",
            prov.get("empresa", ""), r.get("razao", ""), prov.get("uf_principal", ""),
            ", ".join(prov.get("municipios_top", [])[:3]), prov.get("acessos", 0),
            r.get("porte", ""), r.get("simples", ""), p, prio,
            soma(a, cat="pagando"), soma(a, cat="cobranca", ajuizada=False), soma(a, cat="cobranca", ajuizada=True),
            soma(a, cat="discussao"), soma(v),
            ", ".join(sorted({d["base"] for d in a + v})), len(a),
            datas[0][1] if datas else "", r.get("email", ""), r.get("cnae", ""),
        ])
    # padrão combinado: maior valor pagando primeiro; empate por prioridade e acessos
    linhas.sort(key=lambda l: (-l[10], ORDEM_PRIORIDADE[l[9]], -l[5]))

    gravado = None
    if not args.simular:
        gravado = planilha._post({"acao": "aba_alvo", "cabecalho": CABECALHO, "linhas": linhas, "formatos": FORMATOS})
    cont = Counter(l[8] for l in linhas)
    resumo = {"pedido": args.pedido, "pgfn": f"{t_atual} x {t_antigo}", "cnpjs": len(cnpjs), "pequenos": len(pequenos),
              "cruzaram": len(candidatos), "alvo": len(linhas), "perfis": dict(cont), "sem_dados_cnpj": sem_dados,
              "gravado": bool(gravado and gravado.get("ok")), "simulado": args.simular,
              "duracao_min": round((time.time() - inicio) / 60, 1)}
    (DADOS / "resumo-filtro.json").write_text(json.dumps(resumo, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(resumo, ensure_ascii=False), flush=True)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a", encoding="utf-8").write(
            f"### filtro fiscal: {len(linhas)} na aba alvo ({resumo['pgfn']})\n\n"
            + "\n".join(f"- {k}: {v}" for k, v in cont.most_common()) + "\n")


if __name__ == "__main__":
    main()
