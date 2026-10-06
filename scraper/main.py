"""Scraper de leads de provedores de internet.

    python main.py chave                      # identifica a versão dos dados (cache)
    python main.py base [--receita-arquivos 0,1]
    python main.py ufs                        # UFs da base, em JSON (matriz do GitHub)
    python main.py raspar --uf MG --limite 0  # 0 = todos os provedores da UF
    python main.py consolidar --pasta _dados/resumos   # soma os resumos das UFs

IMPORTANTE: o repositório é público e os logs do GitHub Actions também. Este
script só imprime CONTAGENS — nunca nome, e-mail ou telefone de provedor.
Os dados vão apenas para a planilha.
"""

import argparse
import gzip
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from email.utils import parsedate_to_datetime
from pathlib import Path

import requests

import anatel
import receita
from cnpj_api import ConsultaCnpj
from planilha import Planilha
from sites import Raspador

DADOS = Path(__file__).resolve().parent.parent / "_dados"
BASE = DADOS / "base.json.gz"
RESUMO = DADOS / "resumo.json"
CACHE_CNPJ = DADOS / "cnpj_cache.json.gz"  # {cnpj: {..., "em": epoch}} — consultas às APIs
DESCARTE_DIAS = 30  # provedor sem e-mail só é tentado de novo depois disso
UA_NAVEGADOR = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"


def _ler_json_gz(caminho, padrao):
    try:
        with gzip.open(caminho, "rt", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return padrao


def _gravar_json_gz(caminho, dados):
    DADOS.mkdir(exist_ok=True)
    with gzip.open(caminho, "wt", encoding="utf-8") as f:
        json.dump(dados, f)


def cmd_chave(_):
    modificado = ""
    for tentativa in range(5):
        try:
            modificado = requests.head(anatel.URL, timeout=120, headers={"User-Agent": UA_NAVEGADOR}).headers.get("Last-Modified", "")
            break
        except requests.RequestException:
            time.sleep(10 * (tentativa + 1))
    data = parsedate_to_datetime(modificado).strftime("%Y%m%d") if modificado else time.strftime("%Y%m")
    print(f"chave=anatel-{data}")


def cmd_base(args):
    DADOS.mkdir(exist_ok=True)
    inicio = time.time()
    mes_ref, provedores = anatel.carregar_provedores()
    print(f"anatel: {len(provedores)} provedores (mês {mes_ref})")
    arquivos = [int(n) for n in args.receita_arquivos.split(",")] if args.receita_arquivos else range(10)
    try:
        mes_receita, dados = receita.enriquecer(provedores.keys(), arquivos=arquivos)
    except Exception as erro:  # no GitHub (EUA) o servidor da Receita recusa a conexão
        print(f"receita em massa indisponível ({type(erro).__name__}); e-mails virão das APIs de CNPJ na raspagem")
        mes_receita, dados = "", {}
    for cnpj, rec in dados.items():
        provedores[cnpj]["receita"] = rec
    with gzip.open(BASE, "wt", encoding="utf-8") as f:
        json.dump({"mes_ref": mes_ref, "receita_mes": mes_receita, "provedores": provedores}, f)
    com_email = sum(1 for r in dados.values() if r["email"])
    print(f"base: {len(dados)} com dados da Receita, {com_email} com e-mail — {(time.time() - inicio) / 60:.1f} min")


def _cnpj_formatado(c):
    return f"{c[:2]}.{c[2:5]}.{c[5:8]}/{c[8:12]}-{c[12:]}"


def _linha(prov, contatos):
    rec = prov.get("receita") or {}
    top = prov.get("municipios_top") or []
    extra = prov.get("municipios_qtd", 0) - len(top)
    return {
        "CNPJ": _cnpj_formatado(prov["cnpj"]),
        "Empresa (Anatel)": prov["empresa"],
        "Nome fantasia": rec.get("fantasia", ""),
        "Grupo econômico": "" if prov.get("grupo", "").upper() == "OUTROS" else prov.get("grupo", ""),
        "Porte": prov.get("porte", ""),
        "UF principal": prov.get("uf_principal", ""),
        "UFs": ", ".join(prov.get("ufs", [])),
        "Municípios": ", ".join(top) + (f" (+{extra})" if extra > 0 else ""),
        "Acessos": prov["acessos"],
        "Mês ref. Anatel": prov.get("mes_ref", ""),
        "E-mail (Receita)": rec.get("email", ""),
        "Telefone (Receita)": " / ".join(rec.get("telefones", [])),
        "Situação (Receita)": rec.get("situacao", ""),
        "Site": contatos.get("site", ""),
        "E-mails do site": ", ".join(contatos.get("emails", [])),
        "WhatsApp": ", ".join(contatos.get("whatsapp", [])),
        "Telefones do site": ", ".join(contatos.get("telefones", [])),
        "WhatsApp comercial": ", ".join(contatos.get("whats_comercial", [])),
    }


def cmd_raspar(args):
    inicio = time.time()
    with gzip.open(BASE, "rt", encoding="utf-8") as f:
        base = json.load(f)["provedores"]

    ufs = {u.strip().upper() for u in args.uf.split(",") if u.strip()}
    todas = "TODAS" in ufs
    selecionados = [
        p for p in base.values()
        if (todas or p.get("uf_principal") in ufs)
        and p["acessos"] >= args.min_acessos
        and (not args.max_acessos or p["acessos"] <= args.max_acessos)
        and (p.get("receita") or {}).get("situacao", "Ativa") == "Ativa"
    ]

    cache = _ler_json_gz(CACHE_CNPJ, {})
    agora = time.time()
    recentes_sem_email = {c for c, v in cache.items() if v.get("sem_email_em", 0) > agora - DESCARTE_DIAS * 86400}
    selecionados = [p for p in selecionados if p["cnpj"] not in recentes_sem_email]

    planilha = Planilha()
    ja_na_planilha = planilha.cnpjs()
    # primeiro os que ainda não estão na planilha, maiores primeiro
    selecionados.sort(key=lambda p: (_cnpj_formatado(p["cnpj"]) in ja_na_planilha, -p["acessos"]))
    lote = selecionados[: args.limite] if args.limite else selecionados
    print(f"filtro: {len(selecionados)} provedores elegíveis; processando {len(lote)}")

    consulta = ConsultaCnpj()
    consultados = 0
    for prov in lote:
        if prov.get("receita"):
            continue
        dados = cache.get(prov["cnpj"])
        if not dados or "email" not in dados:
            resultado = consulta.consultar(prov["cnpj"])
            consultados += 1
            if resultado is None:
                continue
            dados = {**resultado, "em": agora}
            cache[prov["cnpj"]] = dados
            if consultados % 10 == 0:
                print(f"apis de cnpj: {consultados} consultados")
                _gravar_json_gz(CACHE_CNPJ, cache)
        prov["receita"] = {k: dados.get(k, "") for k in ("fantasia", "situacao", "email", "telefones")}
    _gravar_json_gz(CACHE_CNPJ, cache)
    if consultados:
        print("apis de cnpj: " + ", ".join(f"{k}={v}" for k, v in sorted(consulta.uso.items())))
    lote = [p for p in lote if (p.get("receita") or {}).get("situacao", "Ativa") in ("Ativa", "")]

    raspador = Raspador()

    def processar(prov):
        try:
            return _linha(prov, raspador.processar(prov))
        except Exception:  # um site problemático não derruba a execução
            return _linha(prov, {})

    with ThreadPoolExecutor(args.paralelos) as pool:
        processadas = list(pool.map(processar, lote))

    # regra: provedor sem nenhum e-mail (Receita ou site/busca) não entra na planilha
    linhas = [l for l in processadas if l["E-mails do site"] or l["E-mail (Receita)"]]
    sem_email = len(processadas) - len(linhas)
    com_email_cnpjs = {l["CNPJ"] for l in linhas}
    for prov in lote:
        if _cnpj_formatado(prov["cnpj"]) not in com_email_cnpjs:
            cache.setdefault(prov["cnpj"], {})["sem_email_em"] = agora
    _gravar_json_gz(CACHE_CNPJ, cache)
    planilha.upsert(linhas)
    # contagem local (não depende da resposta da planilha)
    novos = sum(1 for l in linhas if l["CNPJ"] not in ja_na_planilha)
    atualizados = len(linhas) - novos
    com_email = len(linhas)
    com_whats = sum(1 for l in linhas if l["WhatsApp"])
    com_site = sum(1 for l in linhas if l["Site"])
    resumo = {
        "pedido": args.pedido,
        "filtros": f"UF={','.join(sorted(ufs))} limite={args.limite} acessos>={args.min_acessos}"
                   + (f" <= {args.max_acessos}" if args.max_acessos else ""),
        "processados": len(processadas), "semEmailDescartados": sem_email, "consultasCnpj": consultados,
        "provedores": len(linhas), "novos": novos, "atualizados": atualizados,
        "comEmail": com_email, "comWhatsapp": com_whats, "comSite": com_site,
        "elegiveis": len(selecionados), "duracaoMin": round((time.time() - inicio) / 60, 1),
    }
    if not args.sem_registro:
        resumo["planilha"] = planilha.registrar_execucao(resumo)
    saida = Path(args.saida) if args.saida else RESUMO
    saida.parent.mkdir(parents=True, exist_ok=True)
    saida.write_text(json.dumps(resumo, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"resumo: {len(processadas)} processados | {sem_email} sem e-mail (descartados) | {len(linhas)} gravados | {novos} novos | {atualizados} atualizados | "
          f"{com_site} com site | {com_email} com e-mail | {com_whats} com WhatsApp | {resumo['duracaoMin']} min")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(f"### Raspagem {args.pedido}\n\n| | |\n|---|---|\n" + "".join(
                f"| {k} | {v} |\n" for k, v in resumo.items() if k != "planilha"))


def cmd_ufs(args):
    with gzip.open(BASE, "rt", encoding="utf-8") as f:
        base = json.load(f)["provedores"]
    ufs = sorted({p["uf_principal"] for p in base.values() if p.get("uf_principal")})
    pedidas = {u.strip().upper() for u in (args.so or "").split(",") if u.strip() and u.strip().upper() != "TODAS"}
    if pedidas:
        ufs = [u for u in ufs if u in pedidas]
    print("ufs=" + json.dumps(ufs))


SOMAVEIS = ("processados", "semEmailDescartados", "consultasCnpj", "provedores", "novos", "atualizados",
            "comEmail", "comWhatsapp", "comSite", "elegiveis")


def cmd_consolidar(args):
    arquivos = sorted(Path(args.pasta).rglob("*.json"))
    total = {k: 0 for k in SOMAVEIS}
    ufs_ok = []
    for arq in arquivos:
        r = json.loads(arq.read_text(encoding="utf-8"))
        for k in SOMAVEIS:
            total[k] += r.get(k, 0) or 0
        ufs_ok.append(r.get("filtros", "").split("UF=")[-1].split()[0])
    resumo = {"pedido": args.pedido, "filtros": f"Brasil — {len(ufs_ok)} UFs concluídas", **total,
              "duracaoMin": round((time.time() - args.inicio) / 60, 1) if args.inicio else 0}
    resumo["planilha"] = Planilha().registrar_execucao(resumo)
    RESUMO.parent.mkdir(parents=True, exist_ok=True)
    RESUMO.write_text(json.dumps(resumo, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"consolidado: {len(ufs_ok)} UFs | {total['processados']} processados | {total['provedores']} gravados | "
          f"{total['novos']} novos | {total['comWhatsapp']} com WhatsApp")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(f"### Raspagem {args.pedido} (Brasil)\n\n| | |\n|---|---|\n" + "".join(
                f"| {k} | {v} |\n" for k, v in resumo.items() if k != "planilha"))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("chave")
    b = sub.add_parser("base")
    b.add_argument("--receita-arquivos", default="", help="ex.: 1 ou 0,1 (teste); padrão = todos")
    r = sub.add_parser("raspar")
    r.add_argument("--uf", default="TODAS")
    r.add_argument("--limite", type=int, default=100)
    r.add_argument("--min-acessos", type=int, default=200)
    r.add_argument("--max-acessos", type=int, default=0)
    r.add_argument("--paralelos", type=int, default=8)
    r.add_argument("--pedido", default="manual")
    r.add_argument("--sem-registro", action="store_true", help="não grava linha em Execuções (a consolidação grava)")
    r.add_argument("--saida", default="", help="arquivo do resumo (padrão _dados/resumo.json)")
    u = sub.add_parser("ufs")
    u.add_argument("--so", default="", help="ex.: PB,MT,RS (padrão: todas)")
    c = sub.add_parser("consolidar")
    c.add_argument("--pasta", required=True)
    c.add_argument("--pedido", default="manual")
    c.add_argument("--inicio", type=float, default=0, help="epoch do início da execução")
    args = ap.parse_args()
    {"chave": cmd_chave, "base": cmd_base, "raspar": cmd_raspar, "ufs": cmd_ufs,
     "consolidar": cmd_consolidar}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
