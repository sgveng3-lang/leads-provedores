"""Revisita o site dos provedores da aba alvo e grava o "WhatsApp comercial" (número que o
site rotula como comercial/vendas) na aba Provedores, sem esperar a raspagem do fim do mês.
Também atualiza WhatsApp/Telefones do site (servem pra reconhecer o número do suporte).

    python filtro/contatos_alvo.py             # grava
    python filtro/contatos_alvo.py --simular   # só conta

Só imprime contagens (mesma regra do repositório público).
"""

import argparse
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ / "scraper"))
from planilha import Planilha  # noqa: E402
from sites import Raspador  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--simular", action="store_true")
    ap.add_argument("--paralelos", type=int, default=8)
    args = ap.parse_args()
    segredos = RAIZ / "segredos"
    planilha = Planilha(
        os.environ.get("PLANILHA_URL") or (segredos / "url-planilha.txt").read_text().strip(),
        os.environ.get("PLANILHA_TOKEN") or (segredos / "token-planilha.txt").read_text().strip())
    linhas = planilha._post({"acao": "contatos_alvo"})["linhas"]
    if linhas and "site" not in linhas[0]:
        raise SystemExit("o Apps Script ainda não foi reimplantado (contatos_alvo sem 'site')")
    com_site = [l for l in linhas if l.get("site")]
    print(f"aba alvo: {len(linhas)} linhas; {len(com_site)} com site", flush=True)

    raspador = Raspador()

    def visitar(l):
        try:
            c = raspador.contatos(l["site"])
        except Exception:  # site problemático não derruba o resto
            return None
        return {"CNPJ": l["cnpj"], "WhatsApp comercial": ", ".join(c["whats_comercial"]),
                "WhatsApp": ", ".join(c["whatsapp"]), "Telefones do site": ", ".join(c["telefones"])}

    with ThreadPoolExecutor(args.paralelos) as pool:
        achados = [a for a in pool.map(visitar, com_site) if a]
    comerciais = sum(1 for a in achados if a["WhatsApp comercial"])
    print(f"sites lidos: {len(achados)}; com WhatsApp comercial: {comerciais}", flush=True)
    if not args.simular:
        # o upsert não apaga dado bom com vazio: só manda o que achou
        planilha.upsert([{k: v for k, v in a.items() if v} for a in achados])
        print("gravado na aba Provedores", flush=True)


if __name__ == "__main__":
    main()
