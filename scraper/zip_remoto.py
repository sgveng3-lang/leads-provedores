"""Lê arquivos de dentro de um ZIP remoto por HTTP Range, sem baixar o ZIP
inteiro. A Anatel publica um ZIP de ~1 GB com vários anos; só precisamos de
um CSV dele."""

import io
import zipfile

import requests

UA = "leads-provedores/1.0 (+https://github.com/sgveng3-lang/leads-provedores)"


class ArquivoRemoto(io.RawIOBase):
    def __init__(self, url, auth=None):
        self.url, self.auth, self.pos = url, auth, 0
        cab = requests.head(url, auth=auth, timeout=120, allow_redirects=True, headers={"User-Agent": UA})
        cab.raise_for_status()
        self.tamanho = int(cab.headers["Content-Length"])
        self.sessao = requests.Session()
        self.sessao.headers["User-Agent"] = UA

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, deslocamento, origem=0):
        base = {0: 0, 1: self.pos, 2: self.tamanho}[origem]
        self.pos = base + deslocamento
        return self.pos

    def readinto(self, buffer):
        if self.pos >= self.tamanho:
            return 0
        fim = min(self.pos + len(buffer), self.tamanho) - 1
        for tentativa in range(5):
            try:
                resp = self.sessao.get(self.url, auth=self.auth, timeout=300,
                                       headers={"Range": f"bytes={self.pos}-{fim}"})
                resp.raise_for_status()
                dados = resp.content
                break
            except requests.RequestException:
                if tentativa == 4:
                    raise
        buffer[: len(dados)] = dados
        self.pos += len(dados)
        return len(dados)


def abrir_zip_remoto(url, auth=None, bloco=8 << 20):
    """bloco = quantos bytes cada requisição traz (leitura sequencial do CSV)."""
    return zipfile.ZipFile(io.BufferedReader(ArquivoRemoto(url, auth), buffer_size=bloco))
