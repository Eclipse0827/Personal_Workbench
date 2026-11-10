#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 PDF 逐页渲染成 PNG，用来肉眼检查排版。仅内部校对用。"""

import os
import sys
import zlib
import struct

import pypdfium2 as pdfium

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDF = os.path.join(ROOT, 'submission', 'ppt', '缓一缓-作品说明.pdf')
OUT = os.path.join(ROOT, '.doc-preview')


def write_png(path, w, h, rgb):
    raw = b''.join(b'\x00' + rgb[y * w * 3:(y + 1) * w * 3] for y in range(h))

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 6))
    png += chunk(b'IEND', b'')
    open(path, 'wb').write(png)


def main():
    scale = float(sys.argv[1]) if len(sys.argv) > 1 else 1.3
    os.makedirs(OUT, exist_ok=True)
    for name in os.listdir(OUT):
        if name.endswith('.png'):
            os.remove(os.path.join(OUT, name))

    pdf = pdfium.PdfDocument(PDF)
    for i in range(len(pdf)):
        bmp = pdf[i].render(scale=scale)
        w, h, stride = bmp.width, bmp.height, bmp.stride
        data = bytes(bmp.buffer)
        ch = len(data) // (w * h)
        rgb = bytearray(w * h * 3)
        for y in range(h):
            row = data[y * stride:y * stride + w * ch]
            for x in range(w):
                px = row[x * ch:(x + 1) * ch]
                o = (y * w + x) * 3
                rgb[o] = px[2]
                rgb[o + 1] = px[1]
                rgb[o + 2] = px[0]
        write_png(os.path.join(OUT, f'p{i + 1:02d}.png'), w, h, bytes(rgb))
    print('pages', len(pdf))


if __name__ == '__main__':
    main()
