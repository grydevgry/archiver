#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Génère les icônes de l'extension (boîte d'archive + cadenas de hash)."""
from PIL import Image, ImageDraw

SIZES = [16, 32, 48, 128]
BG = (18, 58, 95, 255)          # bleu foncé
BOX = (255, 255, 255, 255)      # blanc
LID = (120, 200, 255, 255)      # bleu clair
LOCK = (255, 210, 90, 255)      # or (empreinte / hash)
DARK = (10, 40, 70, 255)


def draw_icon(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = size / 16.0  # unité

    # fond arrondi
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(3 * u), fill=BG)

    # couvercle (lisse) de la boîte
    d.rounded_rectangle([2.2 * u, 3.0 * u, 13.8 * u, 6.2 * u],
                        radius=int(0.8 * u), fill=LID)

    # corps de la boîte
    d.rounded_rectangle([3.2 * u, 6.2 * u, 12.8 * u, 13.4 * u],
                        radius=int(0.8 * u), fill=BOX)

    # fente de l'archive (bandeau horizontal)
    d.rounded_rectangle([4.4 * u, 7.2 * u, 11.6 * u, 8.4 * u],
                        radius=int(0.5 * u), fill=BG)

    # cadenas / empreinte (hash) sur le corps
    cx = 8.0 * u
    d.rounded_rectangle([6.4 * u, 9.4 * u, 9.6 * u, 12.4 * u],
                        radius=int(0.6 * u), fill=LOCK)
    # anse du cadenas
    lw = max(1, int(0.9 * u))
    d.arc([6.9 * u, 8.3 * u, 9.1 * u, 10.5 * u], start=180, end=360,
          fill=LOCK, width=lw)
    # gâche
    d.ellipse([cx - 0.5 * u, 10.4 * u, cx + 0.5 * u, 11.4 * u], fill=DARK)

    return img


def main():
    for s in SIZES:
        im = draw_icon(s)
        im.save("icons/icon%d.png" % s)
        print("icon%d.png" % s)


if __name__ == "__main__":
    main()
