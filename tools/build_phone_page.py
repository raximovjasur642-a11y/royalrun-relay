#!/usr/bin/env python3
# Telefon sahifasini Unity manbasidan (Assets/Scripts/Net/PhonePage.cs) olib relay/public/phone.html ga yozadi va
# qahramon portretlarini (Assets/UI/Portraits) relay/public/p/ ga 256 px qilib nusxalaydi. LAN va Internet rejimida sahifa bir xil.
import os, re, sys
here = os.path.dirname(os.path.abspath(__file__))
relay = os.path.dirname(here)
proj = os.path.dirname(relay)
src = open(os.path.join(proj, 'Assets/Scripts/Net/PhonePage.cs'), encoding='utf-8').read()
a = src.index('const string Html = @"') + len('const string Html = @"')
b = src.index('</html>";') + len('</html>')
html = src[a:b].replace('""', '"')
open(os.path.join(relay, 'public/phone.html'), 'w', encoding='utf-8').write(html)
print('phone.html:', len(html), 'bayt')
pdir = os.path.join(proj, 'Assets/UI/Portraits')
out = os.path.join(relay, 'public/p')
os.makedirs(out, exist_ok=True)
try:
    from PIL import Image
except ImportError:
    Image = None
for f in sorted(os.listdir(pdir)):
    m = re.match(r'portrait_([a-z0-9_]+)\.png$', f)
    if not m: continue
    dst = os.path.join(out, m.group(1) + '.png')
    if Image:
        im = Image.open(os.path.join(pdir, f)); im.thumbnail((256, 256)); im.save(dst, optimize=True)
    else:
        import shutil; shutil.copyfile(os.path.join(pdir, f), dst)
    print('portret:', m.group(1), os.path.getsize(dst), 'bayt')
