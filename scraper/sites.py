"""Acha o site do provedor e extrai contatos comerciais dele.

1. Site: domínio do e-mail oficial (Receita), se não for e-mail gratuito;
   senão, busca no Bing (o Google bloqueia robô).
2. Raspagem educada: respeita robots.txt, no máximo 5 páginas por site
   (início + páginas de contato/atendimento), 1 s entre requisições.
3. Só guarda e-mails INSTITUCIONAIS do próprio domínio (contato@,
   comercial@...) — nada de e-mail pessoal/nominal (LGPD).
"""

import base64
import re
import threading
import time
import unicodedata
from urllib import robotparser
from urllib.parse import parse_qs, unquote, urljoin, urlparse

import requests
from bs4 import BeautifulSoup

UA = "Mozilla/5.0 (compatible; leads-provedores/1.0; +https://github.com/sgveng3-lang/leads-provedores)"
UA_BUSCA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
TIMEOUT = 12
MAX_PAGINAS = 5
MAX_BYTES = 2 << 20

EMAIL_GRATUITO = {
    "gmail.com", "hotmail.com", "hotmail.com.br", "outlook.com", "outlook.com.br", "live.com", "msn.com",
    "yahoo.com", "yahoo.com.br", "bol.com.br", "uol.com.br", "terra.com.br", "ig.com.br", "globo.com",
    "globomail.com", "r7.com", "zipmail.com.br", "oi.com.br", "icloud.com", "me.com", "protonmail.com",
    "gmail.com.br", "aol.com", "yandex.com",
}
SITES_IGNORADOS = (
    "facebook.", "instagram.", "linkedin.", "youtube.", "twitter.", "x.com", "tiktok.", "wikipedia.",
    "google.", "bing.", "microsoft.", "apple.com", "reclameaqui.", "gov.br", "cnpj", "econodata", "casadosdados",
    "empresas", "telelistas", "guiamais", "apontador", "solutudo", "consultas", "speedtest", "minhaconexao",
    "melhorplano", "tecmundo", "olx.", "mercadolivre", "yelp.", "tripadvisor", "waze.", "maps.",
)
LOCAIS_INSTITUCIONAIS = {
    "contato", "contatos", "comercial", "vendas", "venda", "atendimento", "sac", "suporte", "financeiro",
    "cobranca", "faturamento", "adm", "administrativo", "administracao", "diretoria", "ouvidoria", "noc",
    "info", "informacoes", "faleconosco", "fale", "marketing", "parcerias", "parceria", "negocios", "corporativo",
    "empresas", "provedor", "internet", "central", "relacionamento", "comunicacao", "rh", "juridico", "compras",
    "suporte.tecnico", "atendimento.cliente", "contato.comercial", "ti", "noc.suporte", "helpdesk", "abuse",
}
PALAVRAS_CONTATO = ("contato", "fale", "atendimento", "comercial", "sobre", "empresa", "quem-somos",
                    "quemsomos", "suporte", "central", "ouvidoria", "sac")

RE_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
RE_WHATS = re.compile(r"(?:wa\.me/|whatsapp\.com/send/?\?phone=|api\.whatsapp\.com/send/?\?phone=)\+?(\d{10,13})", re.I)
RE_TEL = re.compile(r"(?:\(?0?(\d{2})\)?[\s.-]*)(9?\d{4})[\s.-]?(\d{4})\b")
RE_0800 = re.compile(r"\b0800[\s.-]?\d{3}[\s.-]?\d{4}\b")
# número escrito perto da palavra WhatsApp (ex.: "WhatsApp: (37) 9 9999-9999")
RE_WHATS_TEXTO = re.compile(r"whats\s*app[^0-9]{0,40}\(?0?(\d{2})\)?[\s.-]*(9[\s.]?\d{4})[\s.-]?(\d{4})", re.I)

# Bing: uma busca por vez no processo inteiro, com intervalo, pra não ser bloqueado
_TRAVA_BING = threading.Lock()
_INTERVALO_BING = 2.0
_ultima_busca = [0.0]


def _sem_acento(texto):
    return unicodedata.normalize("NFKD", texto).encode("ascii", "ignore").decode().lower()


def dominio_registravel(host):
    partes = host.lower().strip(".").split(".")
    if partes and partes[0] == "www":
        partes = partes[1:]
    if len(partes) >= 3 and partes[-1] == "br" and len(partes[-2]) <= 4:
        return ".".join(partes[-3:])
    return ".".join(partes[-2:])


def _fichas_do_nome(nome):
    ignorar = {"provedor", "internet", "telecom", "ltda", "comunicacoes", "telecomunicacoes", "servicos",
               "informatica", "fibra", "net", "eireli", "comercio", "solucoes", "tecnologia"}
    return [t for t in re.findall(r"[a-z0-9]{4,}", _sem_acento(nome)) if t not in ignorar]


def email_aceito(email, dominio_site, fichas):
    """Institucional do domínio do provedor, ou e-mail gratuito (gmail...) que o
    provedor publica como contato da empresa (tem o nome dele ou palavra institucional)."""
    local, _, dom = email.partition("@")
    if not dom or dom.endswith((".png", ".jpg", ".gif", ".webp", ".svg")) or "sentry" in dom or "wix" in dom:
        return False
    local_n = _sem_acento(local)
    institucional = local_n in LOCAIS_INSTITUCIONAIS or any(
        p in local_n for p in ("contato", "comercial", "vendas", "atendimento", "suporte", "financeiro", "sac"))
    if dominio_site and dominio_registravel(dom) == dominio_site:
        return institucional
    if dom in EMAIL_GRATUITO:
        return institucional or any(f in local_n for f in fichas)
    return False


def whatsapps_do_texto(*textos):
    achados = {}
    for t in textos:
        for numero in RE_WHATS.findall(t):
            achados[numero if numero.startswith("55") else "55" + numero] = True
        for ddd, a, b in RE_WHATS_TEXTO.findall(t):
            if 11 <= int(ddd) <= 99:
                achados["55" + ddd + re.sub(r"\D", "", a) + b] = True
    return list(achados)


class Raspador:
    def __init__(self):
        self.sessao = requests.Session()
        self.sessao.headers.update({"User-Agent": UA, "Accept-Language": "pt-BR,pt;q=0.9"})
        self.robots = {}

    # ---------- HTTP ----------
    def _get(self, url, **kw):
        try:
            resp = self.sessao.get(url, timeout=TIMEOUT, stream=True, allow_redirects=True, **kw)
            tipo = resp.headers.get("Content-Type", "")
            if resp.status_code >= 400 or "html" not in tipo:
                return None
            conteudo = resp.raw.read(MAX_BYTES, decode_content=True)
            resp.encoding = resp.encoding or "utf-8"
            return resp.url, conteudo.decode(resp.encoding, errors="replace")
        except (requests.RequestException, UnicodeError, LookupError, OSError):
            return None

    def _pode(self, url):
        base = "{0.scheme}://{0.netloc}".format(urlparse(url))
        if base not in self.robots:
            rp = robotparser.RobotFileParser()
            try:
                resp = self.sessao.get(base + "/robots.txt", timeout=TIMEOUT)
                rp.parse(resp.text.splitlines() if resp.status_code == 200 else [])
            except requests.RequestException:
                rp.parse([])
            self.robots[base] = rp
        return self.robots[base].can_fetch(UA, url)

    # ---------- achar o site ----------
    def site_pelo_email(self, email):
        dominio = email.split("@")[-1].lower() if "@" in email else ""
        if not dominio or dominio in EMAIL_GRATUITO:
            return None
        for url in (f"https://{dominio}", f"https://www.{dominio}", f"http://{dominio}"):
            pagina = self._get(url)
            if pagina:
                return pagina
        return None

    # Testado em 2026-09-28: Google, DuckDuckGo, Brave, Mojeek, Startpage e Ecosia
    # bloqueiam acesso automatizado (captcha/403/429). Yahoo e Bing respondem.
    MOTORES = {
        "yahoo": ("https://br.search.yahoo.com/search", "p", "div.algo", "h3 a[href]"),
        "bing": ("https://www.bing.com/search", "q", "li.b_algo", "h2 a[href]"),
    }

    def _buscar(self, motor, consulta):
        url, param, sel_item, sel_link = self.MOTORES[motor]
        extras = {"setlang": "pt-br", "cc": "BR"} if motor == "bing" else {}
        with _TRAVA_BING:
            espera = _INTERVALO_BING - (time.time() - _ultima_busca[0])
            if espera > 0:
                time.sleep(espera)
            try:
                resp = requests.get(url, params={param: consulta, **extras},
                                    headers={"User-Agent": UA_BUSCA, "Accept-Language": "pt-BR,pt;q=0.9"}, timeout=TIMEOUT)
            except requests.RequestException:
                return []
            finally:
                _ultima_busca[0] = time.time()
        sopa = BeautifulSoup(resp.text, "html.parser")
        resultados = []
        for item in sopa.select(sel_item):
            link = item.select_one(sel_link)
            if link:
                resultados.append((self._desembrulhar(link["href"]), item.get_text(" ")))
        return resultados

    def buscar(self, consulta):
        """Yahoo + Bing, sem repetir endereço."""
        vistos, juntos = set(), []
        for motor in self.MOTORES:
            for url, texto in self._buscar(motor, consulta):
                if url and url not in vistos:
                    vistos.add(url)
                    juntos.append((url, texto))
        return juntos

    def site_pela_busca(self, resultados, fichas):
        for url, _ in resultados[:10]:
            host = urlparse(url).netloc.lower()
            if not host or any(s in host for s in SITES_IGNORADOS):
                continue
            pagina = self._get(url)
            if not pagina:
                continue
            texto = _sem_acento(BeautifulSoup(pagina[1], "html.parser").get_text(" ")[:20000])
            dominio = _sem_acento(host)
            if any(f in dominio or f in texto for f in fichas) and ("internet" in texto or "fibra" in texto or "provedor" in texto):
                return f"https://{urlparse(pagina[0]).netloc}", pagina[1]
        return None

    @staticmethod
    def _desembrulhar(href):
        """Tira o redirecionamento do Yahoo (/RU=<url>/) e do Bing (ck/a?u=a1<base64>)."""
        m = re.search(r"/RU=([^/]+)/", href)
        if m:
            return unquote(m.group(1))
        if "bing.com/ck/" not in href:
            return href
        u = parse_qs(urlparse(href).query).get("u", [""])[0]
        if u.startswith("a1"):
            try:
                return base64.urlsafe_b64decode(u[2:] + "=" * (-len(u[2:]) % 4)).decode()
            except ValueError:
                return ""
        return ""

    # ---------- raspar contatos ----------
    def contatos(self, url_inicial, html_inicial=None, fichas=()):
        dominio = dominio_registravel(urlparse(url_inicial).netloc)
        visitadas, fila = set(), [url_inicial]
        emails, whats, telefones = {}, {}, {}
        primeira = True
        while fila and len(visitadas) < MAX_PAGINAS:
            url = fila.pop(0)
            if url in visitadas or not self._pode(url):
                continue
            visitadas.add(url)
            if primeira and html_inicial:
                final, html = url, html_inicial
            else:
                time.sleep(1)
                pagina = self._get(url)
                if not pagina:
                    continue
                final, html = pagina
            primeira = False
            sopa = BeautifulSoup(html, "html.parser")
            texto = sopa.get_text(" ")
            hrefs = [a.get("href", "") for a in sopa.find_all("a")]

            candidatos = RE_EMAIL.findall(texto) + [h[7:].split("?")[0] for h in hrefs if h.lower().startswith("mailto:")]
            for e in candidatos:
                e = e.strip().lower()
                if email_aceito(e, dominio, fichas):
                    emails[e] = True
            for numero in whatsapps_do_texto(texto, *hrefs):
                whats[numero] = True
            for m in RE_0800.findall(texto):
                telefones[re.sub(r"[\s.-]", "", m)] = True
            for ddd, a, b in RE_TEL.findall(texto):
                if 11 <= int(ddd) <= 99:
                    telefones[f"({ddd}) {a}-{b}"] = True

            for a in sopa.find_all("a", href=True):
                destino = urljoin(final, a["href"]).split("#")[0]
                alvo = _sem_acento(destino + " " + a.get_text(" "))
                if urlparse(destino).netloc.endswith(dominio) and any(p in alvo for p in PALAVRAS_CONTATO):
                    if destino not in visitadas and destino not in fila:
                        fila.append(destino)
        return {
            "emails": list(emails)[:5],
            "whatsapp": [f"+{w}" for w in list(whats)[:3]],
            "telefones": list(telefones)[:4],
        }

    def processar(self, prov):
        """prov: dados da base (anatel + receita). Retorna {site, emails, whatsapp, telefones}.
        Sempre busca no Bing: o próprio resultado da busca também traz e-mail/WhatsApp."""
        rec = prov.get("receita") or {}
        nome = rec.get("fantasia") or prov["empresa"]
        fichas = _fichas_do_nome(nome) or _fichas_do_nome(prov["empresa"])
        municipio = (prov.get("municipios_top") or [""])[0].split("/")[0]
        resultados = self.buscar(f'{nome} provedor internet {municipio} {prov.get("uf_principal", "")}')

        pagina = self.site_pelo_email(rec.get("email", "")) or self.site_pela_busca(resultados, fichas)
        achado = {"site": "", "emails": [], "whatsapp": [], "telefones": []}
        if pagina:
            achado = {"site": f"https://{urlparse(pagina[0]).netloc}", **self.contatos(pagina[0], pagina[1], fichas)}

        # e-mails/WhatsApp que aparecem nos resultados da busca sobre este provedor
        dominio_site = dominio_registravel(urlparse(achado["site"]).netloc) if achado["site"] else ""
        textos = [t for u, t in resultados[:10] if any(f in _sem_acento(t + u) for f in fichas)]
        emails = dict.fromkeys(achado["emails"])
        for t in textos:
            for e in RE_EMAIL.findall(t):
                if email_aceito(e.lower(), dominio_site, fichas):
                    emails[e.lower()] = None
        whats = dict.fromkeys(w.lstrip("+") for w in achado["whatsapp"])
        whats.update(dict.fromkeys(whatsapps_do_texto(*textos)))
        achado["emails"] = list(emails)[:5]
        achado["whatsapp"] = [f"+{w}" for w in list(whats)[:3]]
        return achado
