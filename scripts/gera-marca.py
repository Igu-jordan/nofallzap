#!/usr/bin/env python3
"""Gera os arquivos de marca do painel a partir das artes originais.

As artes que o Jordao mandou sao dois quadrados de 1254x1254: um icone com
fundo transparente e um logo completo (icone em cima, nome embaixo) com fundo
PRETO. O topbar do painel e #161b22, nao preto — por isso o nome precisa sair
com o fundo virando transparencia, senao aparece um retangulo escuro em volta
das letras.

Os recortes abaixo sao fixos porque foram medidos nessas artes especificas.
Se a arte mudar, rode o trecho comentado no fim para medir de novo.

    python3 scripts/gera-marca.py     (da raiz do repositorio)
"""

from PIL import Image
import numpy as np

ICONE = 'assets/marca/nofallzap-icone-original.png'
LOGO = 'assets/marca/nofallzap-logo-original.png'
OUT = 'web/public/'

# --- icone: a arte ja vem com alfa, so tiramos a sobra em volta
ic = Image.open(ICONE).convert('RGBA').crop((50, 53, 1201, 1194))
ic.resize((180, 180), Image.LANCZOS).save(OUT + 'apple-touch-icon.png', optimize=True)
ic.resize((192, 192), Image.LANCZOS).save(OUT + 'favicon-192.png', optimize=True)
ic.resize((32, 32), Image.LANCZOS).save(OUT + 'favicon.png', optimize=True)
ic.resize((72, 72), Image.LANCZOS).save(OUT + 'marca-icone.png', optimize=True)
ic.resize((256, 256), Image.LANCZOS).save(
    OUT + 'favicon.ico', sizes=[(16, 16), (32, 32), (48, 48)])

# --- nome: recorta a faixa do texto e transforma o preto em transparencia.
# O alfa vem do canal mais claro de cada pixel, entao a borda serrilhada das
# letras continua suave em cima de qualquer fundo escuro.
wm = Image.open(LOGO).convert('RGB').crop((214, 752, 1060, 932))
a = np.array(wm).astype(np.uint8)
alpha = np.clip(a.max(axis=2).astype(int) * 255 // int(a.max()), 0, 255).astype(np.uint8)
wm = Image.fromarray(np.dstack([a, alpha]), 'RGBA')
wm.resize((int(wm.width * 64 / wm.height), 64), Image.LANCZOS).save(
    OUT + 'marca-nome.png', optimize=True)

print('marca gerada em', OUT)

# Para remedir os recortes numa arte nova:
#   a = np.array(Image.open(LOGO).convert('RGB')).astype(int)
#   mask = a.max(axis=2) > 40
#   perfil = mask.sum(axis=1)          # faixa vazia separa icone e nome
