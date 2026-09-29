"""Scraper de leads de provedores de internet.

    python main.py chave                      # identifica a versão dos dados (cache)
    python main.py base [--receita-arquivos 0,1]
    python main.py raspar --uf MG,SP --limite 100 [--min-acessos 200] [--max-acessos 0]

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
from planilha import Planilha
from sites import Raspador

DADOS = Path(__file__).resolve().parent.parent / "_dados"
BASE = DADOS / "base.json.gz"
RESUMO = DADOS / "resumo.json"


def cmd_chave(_):
    modificado = requests.head(anatel.URL, timeout=120).headers.get("Last-Modified", "")
    data = parsedate_to_datetime(modificado).strftime("%Y%m%d") if modificado else "sem-data"
    print(f"chave=anatel-{data}_receita-{receita.mes_mais_recente()}")


def cmd_base(args):
    DADOS.mkdir(exist_ok=True)
    inicio = time.time()
    mes_ref, provedores = anatel.carregar_provedores()
    print(f"anatel: {len(provedores)} provedores (mês {mes_ref})")
    arquivos = [int(n) for n in args.receita_arquivos.split(",")] if args.receita_arquivos else range(10)
    mes_receita, dados = receita.enriquecer(provedores.keys(), arquivos=arquivos)
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

    planilha = Planilha()
    ja_na_planilha = planilha.cnpjs()
    # primeiro os que ainda não estão na planilha, maiores primeiro
    selecionados.sort(key=lambda p: (_cnpj_formatado(p["cnpj"]) in ja_na_planilha, -p["acessos"]))
    lote = selecionados[: args.limite]
    print(f"filtro: {len(selecionados)} provedores elegíveis; processando {len(lote)}")

    raspador = Raspador()

    def processar(prov):
        try:
            return _linha(prov, raspador.processar(prov))
        except Exception:  # um site problemático não derruba a execução
            return _linha(prov, {})

    with ThreadPoolExecutor(args.paralelos) as pool:
        linhas = list(pool.map(processar, lote))

    novos, atualizados = planilha.upsert(linhas)
    com_email = sum(1 for l in linhas if l["E-mails do site"] or l["E-mail (Receita)"])
    com_whats = sum(1 for l in linhas if l["WhatsApp"])
    com_site = sum(1 for l in linhas if l["Site"])
    resumo = {
        "pedido": args.pedido,
        "filtros": f"UF={','.join(sorted(ufs))} limite={args.limite} acessos>={args.min_acessos}"
                   + (f" <= {args.max_acessos}" if args.max_acessos else ""),
        "provedores": len(linhas), "novos": novos, "atualizados": atualizados,
        "comEmail": com_email, "comWhatsapp": com_whats, "comSite": com_site,
        "elegiveis": len(selecionados), "duracaoMin": round((time.time() - inicio) / 60, 1),
    }
    resumo["planilha"] = planilha.registrar_execucao(resumo)
    DADOS.mkdir(exist_ok=True)
    RESUMO.write_text(json.dumps(resumo, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"resumo: {len(linhas)} provedores | {novos} novos | {atualizados} atualizados | "
          f"{com_site} com site | {com_email} com e-mail | {com_whats} com WhatsApp | {resumo['duracaoMin']} min")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(f"### Raspagem {args.pedido}\n\n| | |\n|---|---|\n" + "".join(
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
    args = ap.parse_args()
    {"chave": cmd_chave, "base": cmd_base, "raspar": cmd_raspar}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
