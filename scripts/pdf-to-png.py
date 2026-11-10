#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把单页 PDF 栅格化成 PNG（用于把 HTML 出的配图放进文档）。

    python scripts/pdf-to-png.py in.pdf out.png [宽度像素]
"""

import os
import sys
import zlib
import struct

import pypdfium2 as pdfium


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
    src = sys.argv[1]
    dst = sys.argv[2]
    target_w = int(sys.argv[3]) if len(sys.argv) > 3 else 2200

    pdf = pdfium.PdfDocument(os.path.abspath(src))
    page = pdf[0]
    base_w = page.get_width()
    scale = target_w / base_w
    bmp = page.render(scale=scale)
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
    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    write_png(dst, w, h, bytes(rgb))
    print(f'OK {dst} {w}x{h}')


if __name__ == '__main__':
    main()
