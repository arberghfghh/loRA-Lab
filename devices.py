# Faster on phones, tablets and other PCs: small WebP thumbnails instead of full-size PNGs in the grids,
# gzip for the page / tag list / JSON answers, and the addresses other devices on the Wi-Fi can open.
import gzip
import hashlib
import io
import itertools
import os
import re
import socket
import threading
import time

import folder_paths
from PIL import Image, ImageOps

THUMBS = os.path.join(folder_paths.get_user_directory(), "default", "lora-lab-thumbs")
SIZES = (256, 384, 512, 768, 1024)   # widths the page may ask for (rounded up), so the cache stays small
EXTS = (".png", ".jpg", ".jpeg", ".webp")
KEEP_DAYS = 45                        # thumbnails not shown for this long are removed at start-up


def image_path(filename, subfolder="", kind="output"):
    """Absolute path of an output/input/temp image, or None if it's outside that folder or not an image."""
    base = folder_paths.get_directory_by_type(kind if kind in ("output", "input", "temp") else "output")
    if not base or not filename:
        return None
    base = os.path.abspath(base)
    path = os.path.abspath(os.path.join(base, subfolder or "", filename))
    if os.path.normcase(os.path.commonpath([path, base])) != os.path.normcase(base) or not path.lower().endswith(EXTS):
        return None
    return path if os.path.isfile(path) else None


def thumbnail(path, width):
    """(webp bytes, etag) for a picture shrunk to `width` (rounded up to SIZES); made once, then read from the cache."""
    width = next((s for s in SIZES if s >= width), SIZES[-1])
    st = os.stat(path)
    etag = hashlib.sha1(f"{path}|{st.st_mtime_ns}|{st.st_size}|{width}".encode()).hexdigest()[:20]
    cached = os.path.join(THUMBS, etag[:2], etag + ".webp")
    try:
        with open(cached, "rb") as f:
            data = f.read()
        os.utime(cached)   # recently shown: keep it
        return data, etag
    except OSError:
        pass
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)
        im = im.convert("RGBA" if im.mode in ("RGBA", "LA", "P") else "RGB")
        if im.width > width:
            im = im.resize((width, max(1, round(im.height * width / im.width))), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "WEBP", quality=82, method=4)
    data = buf.getvalue()
    os.makedirs(os.path.dirname(cached), exist_ok=True)
    tmp = cached + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, cached)
    return data, etag


def prune_thumbs():
    cutoff = time.time() - KEEP_DAYS * 86400
    for d, _, files in os.walk(THUMBS):
        for f in files:
            p = os.path.join(d, f)
            try:
                if os.path.getmtime(p) < cutoff:
                    os.remove(p)
            except OSError:
                pass


threading.Thread(target=prune_thumbs, daemon=True).start()

_gz = {}   # path -> (mtime_ns, size, etag, gzipped bytes)
_gz_lock = threading.Lock()


def gzipped(path):
    """(gzipped bytes, etag) of a text file, re-compressed only when the file changes (other sessions edit index.html)."""
    st = os.stat(path)
    with _gz_lock:
        hit = _gz.get(path)
        if hit and hit[:2] == (st.st_mtime_ns, st.st_size):
            return hit[3], hit[2]
    with open(path, "rb") as f:
        raw = f.read()
    data = gzip.compress(raw, compresslevel=6, mtime=0)
    etag = hashlib.sha1(raw).hexdigest()[:20]
    with _gz_lock:
        _gz[path] = (st.st_mtime_ns, st.st_size, etag, data)
    return data, etag


SHARE = os.path.join(folder_paths.get_output_directory(), "ASA-Share")   # Share Files tab: what other devices upload / download


def share_list(folder=SHARE):
    os.makedirs(folder, exist_ok=True)
    files = [{"name": e.name, "size": st.st_size, "mtime": st.st_mtime} for e in os.scandir(folder) if e.is_file() for st in [e.stat()]]
    return sorted(files, key=lambda f: -f["mtime"])


def share_path(name, folder=SHARE):
    """Path of a file already in the share folder, or None for anything else (sub-paths, '..', missing files)."""
    path = os.path.join(folder, name or "")
    return path if name and os.path.basename(name) == name and os.path.isfile(path) else None


def share_create(filename, folder=SHARE):
    """(path, file open for writing) for an upload: a safe version of its name, with ' (2)', ' (3)'… when taken."""
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", os.path.basename((filename or "").replace("\\", "/"))).strip(" .") or "file"
    if re.fullmatch(r"(con|prn|aux|nul|com\d|lpt\d)(\..*)?", name, re.I):   # Windows device names
        name = "_" + name
    stem, ext = os.path.splitext(name)
    stem, ext = stem[:150], ext[:20]
    os.makedirs(folder, exist_ok=True)
    for n in itertools.count(1):
        path = os.path.join(folder, f"{stem}{ext}" if n == 1 else f"{stem} ({n}){ext}")
        try:
            return path, open(path, "xb")   # "x": two uploads with the same name never write into one file
        except FileExistsError:
            pass


def lan_addresses():
    """IPv4 addresses other devices can use, Wi-Fi / Ethernet first (virtual adapters like Hyper-V's are skipped)."""
    found = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))   # no packet is sent; this just picks the adapter with the default route
        found.append(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip not in found and not ip.startswith(("127.", "169.254.", "172.")):
                found.append(ip)
    except OSError:
        pass
    return [ip for ip in found if not ip.startswith("127.")]
