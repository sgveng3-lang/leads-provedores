"""Provedores de banda larga fixa a partir dos dados abertos da Anatel.

Usa Acessos_Banda_Larga_Fixa_<ano>_Colunas.csv (formato largo: uma coluna por
mês) do ano mais recente e soma os acessos do último mês com dado, por CNPJ.
"""

import csv
import io
import re
from collections import Counter, defaultdict

from zip_remoto import abrir_zip_remoto

URL = "https://www.anatel.gov.br/dadosabertos/paineis_de_dados/acessos/acessos_banda_larga_fixa.zip"


def _inteiro(texto):
    texto = (texto or "").strip()
    return int(texto) if texto.isdigit() else 0


def carregar_provedores():
    """Retorna (mes_ref, {cnpj: dados}). Exclui operadoras de Grande Porte."""
    z = abrir_zip_remoto(URL)
    candidatos = [n for n in z.namelist() if re.search(r"_(\d{4})_Colunas\.csv$", n)]
    arquivo = max(candidatos, key=lambda n: re.search(r"_(\d{4})_Colunas", n).group(1))

    with z.open(arquivo) as bruto:
        leitor = csv.reader(io.TextIOWrapper(bruto, encoding="utf-8-sig", newline=""), delimiter=";")
        cabecalho = next(leitor)
        col = {nome: i for i, nome in enumerate(cabecalho)}
        meses = [i for i, nome in enumerate(cabecalho) if re.fullmatch(r"\d{4}-\d{2}", nome)]

        # 1ª passada não dá (arquivo remoto); acumula por mês e decide o mês no fim
        por_mes = defaultdict(lambda: defaultdict(int))  # cnpj -> mes -> acessos
        info = {}
        ufs = defaultdict(Counter)
        municipios = defaultdict(Counter)
        for linha in leitor:
            if len(linha) < len(cabecalho):
                continue
            cnpj = re.sub(r"\D", "", linha[col["CNPJ"]]).zfill(14)
            if linha[col["Porte da Prestadora"]].strip().lower().startswith("grande"):
                continue
            ultimo = 0
            for i in meses:
                valor = _inteiro(linha[i])
                if valor:
                    por_mes[cnpj][cabecalho[i]] += valor
                    ultimo = valor
            if cnpj not in info:
                info[cnpj] = {
                    "empresa": linha[col["Empresa"]].strip(),
                    "grupo": linha[col["Grupo Econômico"]].strip(),
                    "porte": linha[col["Porte da Prestadora"]].strip(),
                }
            if ultimo:
                ufs[cnpj][linha[col["UF"]].strip()] += ultimo
                municipios[cnpj][f"{linha[col['Município']].strip()}/{linha[col['UF']].strip()}"] += ultimo

    # mês de referência = último mês que tem dado na maioria do arquivo
    totais_mes = Counter()
    for acessos in por_mes.values():
        for mes, v in acessos.items():
            totais_mes[mes] += v
    mes_ref = max(m for m, v in totais_mes.items() if v > 0)

    provedores = {}
    for cnpj, acessos in por_mes.items():
        # provedor que não reportou o último mês usa o mais recente dele
        mes_proprio = max(acessos)
        total = acessos.get(mes_ref) or acessos[mes_proprio]
        if not total:
            continue
        principais = [m for m, _ in municipios[cnpj].most_common()]
        provedores[cnpj] = {
            **info[cnpj],
            "cnpj": cnpj,
            "acessos": total,
            "mes_ref": mes_ref if mes_ref in acessos else mes_proprio,
            "uf_principal": ufs[cnpj].most_common(1)[0][0] if ufs[cnpj] else "",
            "ufs": sorted(ufs[cnpj]),
            "municipios_qtd": len(principais),
            "municipios_top": principais[:5],
        }
    return mes_ref, provedores
