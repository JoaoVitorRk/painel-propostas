# Gera site/media/favicon.png (512) e site/media/apple-touch-icon.png (180) a partir do logo da RK.
#   python testes-e2e/ferramentas/icones.py
# Recorta só o monograma "RK" (o "PERFORMANCE" não se lê em 16-32 px) e recompõe num quadrado escuro
# com o mesmo brilho quente do logo original, com o filete dourado embaixo. Grava também uma prévia
# ampliada (16/32/48 px) na pasta temporária, para conferir a leitura em tamanho pequeno.
import os
import tempfile
from PIL import Image, ImageDraw, ImageFilter

AQUI = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.abspath(os.path.join(AQUI, "..", ".."))                       # raiz do repositório
RAIZ = os.path.abspath(os.path.join(BASE, "..", ".."))                       # Rk performance
ORIGEM = os.path.join(RAIZ, "02-materiais-comerciais", "linkedin-joao-vitor", "pagina-rk", "logo-rk-800.png")
DESTINO = os.path.join(BASE, "site", "media")
OURO = (201, 169, 106)

logo = Image.open(ORIGEM).convert("RGB")
W, H = logo.size

# caixa exata do "RK": pixels dourados acima do filete (y < 470)
xs, ys = [], []
for y in range(0, 470):
    for x in range(W):
        r, g, b = logo.getpixel((x, y))
        if r > 120 and r - b > 45:
            xs.append(x); ys.append(y)
caixa = (min(xs), min(ys), max(xs) + 1, max(ys) + 1)
rk = logo.crop(caixa)

# cobertura do dourado (borda suave) pelo canal vermelho; o fundo do logo chega a r=45 no brilho
alfa = Image.new("L", rk.size)
pa, pr = alfa.load(), rk.load()
for y in range(rk.size[1]):
    for x in range(rk.size[0]):
        t = (pr[x, y][0] - 48) / float(OURO[0] - 48)
        pa[x, y] = max(0, min(255, int(round(t * 255))))


def fundo(lado):
    base = Image.new("RGB", (lado, lado), (13, 13, 12))
    brilho = Image.new("L", (lado, lado), 0)
    r = int(lado * 0.62)
    cx, cy = lado // 2, int(lado * 0.18)
    ImageDraw.Draw(brilho).ellipse((cx - r, cy - r, cx + r, cy + r), fill=110)
    brilho = brilho.filter(ImageFilter.GaussianBlur(lado * 0.22))
    return Image.composite(Image.new("RGB", (lado, lado), (52, 43, 26)), base, brilho)


def icone(lado, larg_rk):
    img = fundo(lado)
    esc = larg_rk / rk.size[0]
    tam = (int(round(rk.size[0] * esc)), int(round(rk.size[1] * esc)))
    m = alfa.resize(tam, Image.LANCZOS)
    filete_h = max(2, int(round(lado * 0.011)))
    gap = int(round(lado * 0.075))
    x0 = (lado - tam[0]) // 2
    y0 = (lado - (tam[1] + gap + filete_h)) // 2 + int(round(lado * 0.01))
    img.paste(Image.new("RGB", tam, OURO), (x0, y0), m)
    fl = int(round(tam[0] * 0.62))
    fx, fy = (lado - fl) // 2, y0 + tam[1] + gap
    ImageDraw.Draw(img).rectangle((fx, fy, fx + fl - 1, fy + filete_h - 1), fill=(176, 148, 96))
    return img


os.makedirs(DESTINO, exist_ok=True)
fav = icone(512, 360)
fav.save(os.path.join(DESTINO, "favicon.png"), optimize=True)
icone(180, 124).save(os.path.join(DESTINO, "apple-touch-icon.png"), optimize=True)

previa = Image.new("RGB", (4 * (16 + 32 + 48) + 80, 4 * 48 + 40), (240, 240, 240))
x = 20
for t in (16, 32, 48):
    previa.paste(fav.resize((t, t), Image.LANCZOS).resize((t * 4, t * 4), Image.NEAREST), (x, 20))
    x += t * 4 + 20
arq = os.path.join(tempfile.gettempdir(), "rk-previa-icones.png")
previa.save(arq)
print("ok:", DESTINO, "| prévia ampliada:", arq)
