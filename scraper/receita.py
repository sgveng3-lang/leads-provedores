"""E-mail, telefone e situação cadastral oficiais de cada CNPJ, a partir dos
dados abertos do CNPJ da Receita Federal (arquivos Estabelecimentos0..9).

Os arquivos ficam num compartilhamento público (Nextcloud) acessível por
WebDAV: usuário = token do compartilhamento, senha vazia. São ~5,4 GB por
mês; lemos cada ZIP em streaming e guardamos só os CNPJs que interessam.
"""

import csv
import io
import re
from concurrent.futures import ThreadPoolExecutor

import requests

from zip_remoto import UA, abrir_zip_remoto

WEBDAV = "https://arquivos.receitafederal.gov.br/public.php/webdav/"
AUTH = ("YggdBLfdninEJX9", "")

SITUACAO = {"01": "Nula", "02": "Ativa", "03": "Suspensa", "04": "Inapta", "08": "Baixada"}

# layout oficial do arquivo Estabelecimentos (sem cabeçalho)
C_BASICO, C_ORDEM, C_DV, C_FANTASIA, C_SITUACAO = 0, 1, 2, 4, 5
C_DDD1, C_TEL1, C_DDD2, C_TEL2, C_EMAIL = 21, 22, 23, 24, 27


def mes_mais_recente():
    resp = requests.request("PROPFIND", WEBDAV, auth=AUTH, headers={"Depth": "1", "User-Agent": UA}, timeout=120)
    resp.raise_for_status()
    meses = re.findall(r"/public\.php/webdav/(\d{4}-\d{2})/", resp.text)
    return max(meses)


def _telefone(ddd, numero):
    ddd, numero = re.sub(r"\D", "", ddd), re.sub(r"\D", "", numero)
    return f"({ddd}) {numero[:-4]}-{numero[-4:]}" if ddd and len(numero) >= 8 else ""


def _ler_arquivo(mes, n, alvo):
    url = f"{WEBDAV}{mes}/Estabelecimentos{n}.zip"
    z = abrir_zip_remoto(url, auth=AUTH, bloco=16 << 20)
    achados = {}
    with z.open(z.namelist()[0]) as bruto:
        leitor = csv.reader(io.TextIOWrapper(bruto, encoding="latin-1", newline=""), delimiter=";", quotechar='"')
        for linha in leitor:
            if len(linha) <= C_EMAIL:
                continue
            cnpj = linha[C_BASICO] + linha[C_ORDEM] + linha[C_DV]
            if cnpj not in alvo:
                continue
            telefones = [t for t in (_telefone(linha[C_DDD1], linha[C_TEL1]), _telefone(linha[C_DDD2], linha[C_TEL2])) if t]
            achados[cnpj] = {
                "fantasia": linha[C_FANTASIA].strip().title(),
                "situacao": SITUACAO.get(linha[C_SITUACAO].strip(), linha[C_SITUACAO].strip()),
                "email": linha[C_EMAIL].strip().lower(),
                "telefones": list(dict.fromkeys(telefones)),
            }
    return n, achados


def enriquecer(cnpjs, mes=None, arquivos=range(10), paralelos=5, progresso=print):
    """Retorna (mes, {cnpj: {fantasia, situacao, email, telefones}}) para os CNPJs pedidos."""
    mes = mes or mes_mais_recente()
    alvo = set(cnpjs)
    achados = {}
    with ThreadPoolExecutor(paralelos) as pool:
        for n, parcial in pool.map(lambda n: _ler_arquivo(mes, n, alvo), arquivos):
            achados.update(parcial)
            progresso(f"receita: arquivo {n} lido — {len(achados)}/{len(alvo)} CNPJs encontrados até agora")
    return mes, achados
