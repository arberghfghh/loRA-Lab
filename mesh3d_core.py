# Image to 3D helpers for Kōbō's Hunyuan3D meshes:
#   - clean_mesh: drop the small floating bits Hunyuan leaves around hair and cloth, optional Taubin smoothing.
#   - texture_from_views: paint a UV texture by projecting the source picture (and optional left / back / right
#     views) onto the mesh, each texel taking the views that see it head-on, then filling the rest from the
#     nearest painted surface.
# Hunyuan3D's mesh is Y-up and faces +Z; its multi-view "left" image looks at the object's own left side (+X).
# Reuses ComfyUI's mesh helpers (UV rasterizer, BVH ray casts, seam fill) from comfy_extras.nodes_mesh_postprocess.
import logging

import numpy as np
import torch
import torch.nn.functional as F
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

import comfy.model_management
from comfy_extras import nodes_mesh_postprocess as P

# view -> (direction from the object to the camera, screen right); screen up is always +Y.
VIEWS = {
    "front": ((0.0, 0.0, 1.0), (1.0, 0.0, 0.0)),
    "left": ((1.0, 0.0, 0.0), (0.0, 0.0, -1.0)),
    "back": ((0.0, 0.0, -1.0), (-1.0, 0.0, 0.0)),
    "right": ((-1.0, 0.0, 0.0), (0.0, 0.0, 1.0)),
}


def clean_mesh(v, f, min_part=0.01, smooth_iters=0, target_faces=0):
    """v (N,3) float, f (M,3) int numpy -> (v, f) without parts smaller than min_part x the largest (by faces),
    optionally smoothed and decimated to about target_faces."""
    n = v.shape[0]
    if f.shape[0] == 0:
        return v, f
    a = np.concatenate([f[:, 0], f[:, 1], f[:, 2]])
    b = np.concatenate([f[:, 1], f[:, 2], f[:, 0]])
    _, label = connected_components(coo_matrix((np.ones(a.shape[0], np.int8), (a, b)), shape=(n, n)), directed=False)
    face_label = label[f[:, 0]]
    sizes = np.bincount(face_label)
    keep = sizes[face_label] >= min_part * sizes.max()
    f = f[keep]
    used = np.unique(f)
    remap = np.full(n, -1, np.int64)
    remap[used] = np.arange(used.shape[0])
    v, f = v[used], remap[f]
    logging.info(f"[Kobo 3D] clean-up: kept {int(keep.sum())}/{keep.shape[0]} faces, "
                 f"dropped {int((sizes < min_part * sizes.max()).sum())} floating parts")
    if smooth_iters > 0:
        v = _taubin(v, f, smooth_iters)
    if 0 < target_faces < f.shape[0]:
        v, f = _decimate(v, f, target_faces)
    return v, f


def _decimate(v, f, target):
    """ComfyUI's QEM decimation overshoots on Hunyuan meshes (asking 100k gave 32k), so retarget until within 10%."""
    dev = comfy.model_management.get_torch_device()
    vt = torch.from_numpy(np.ascontiguousarray(v, dtype=np.float32)).to(dev)
    ft = torch.from_numpy(np.ascontiguousarray(f).astype(np.int64)).to(dev)
    lo, hi, best = float(target), float(f.shape[0] - 1), None   # faces out grow with the ask: bisect it
    ask = lo
    for _ in range(7):
        rv, rf, *_ = P.qem_decimate_simplify(vt, ft, int(ask), colors=None, config=P.QEMConfig())
        n = int(rf.shape[0])
        if best is None or abs(n - target) < abs(best[1].shape[0] - target):
            best = (rv, rf)
        if abs(n - target) <= 0.1 * target:
            break
        if n < target:
            lo = ask
        else:
            hi = ask
        ask = (lo + hi) / 2
    logging.info(f"[Kobo 3D] decimated {f.shape[0]} -> {best[1].shape[0]} faces (target {target})")
    return best[0].cpu().numpy().astype(np.float32), best[1].cpu().numpy().astype(np.int64)


def _fit_view(verts, r, up, mask, dev):
    """Scale + offset that lay the mesh outline (seen along this view) over the object's outline in the picture.
    Starts from the bounding boxes, then searches nearby scales/offsets for the best overlap (IoU)."""
    box = _mask_bbox(mask)
    if box is None:
        return None
    x0, x1, y0, y1 = box
    sr, su = verts @ r, verts @ up
    top, h_mesh = float(su.max()), float(su.max() - su.min())
    if h_mesh <= 0:
        return None
    cmid = float(sr.max() + sr.min()) / 2
    s0, cx0 = (y1 - y0 + 1) / h_mesh, (x0 + x1) / 2
    H, W = mask.shape
    k = 160.0 / H   # search on a ~160 px tall copy
    hs, ws = max(8, round(H * k)), max(8, round(W * k))
    m = torch.from_numpy(np.ascontiguousarray(mask, dtype=np.float32)).to(dev)[None, None]
    m = F.interpolate(m, size=(hs, ws), mode="area")[0, 0] > 0.5
    sub = verts[:: max(1, verts.shape[0] // 40000)]
    a, b = sub @ r - cmid, top - sub @ up

    def iou(s, cx, ty):
        px = ((cx + a * s) * k).long().clamp(0, ws - 1)
        py = ((ty + b * s) * k).long().clamp(0, hs - 1)
        sil = torch.zeros((hs, ws), dtype=torch.bool, device=dev)
        sil[py, px] = True
        sil = F.max_pool2d(sil[None, None].float(), 3, 1, 1)[0, 0] > 0
        return float((sil & m).sum()) / max(1.0, float((sil | m).sum()))

    # Coarse pass with a wide sideways range (a sword or cape sticking out moves the mesh's box centre),
    # then a fine pass around the best match.
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    best = (iou(s0, cx0, y0), s0, cx0, float(y0))
    for scales, dxs, dys in ((np.linspace(0.85, 1.15, 7), np.linspace(-0.45, 0.45, 19) * bw, np.linspace(-0.06, 0.06, 5) * bh),
                             (np.linspace(0.96, 1.04, 5), np.linspace(-0.04, 0.04, 9) * bw, np.linspace(-0.02, 0.02, 5) * bh)):
        _, s1, c1, t1 = best
        for ds in scales:
            for dx in dxs:
                for dy in dys:
                    cand = (s1 * ds, c1 + dx, t1 + dy)
                    score = iou(*cand)
                    if score > best[0]:
                        best = (score, *cand)
    return best[1], best[2], best[3], cmid, top, best[0]


def _taubin(v, f, iters, lam=0.5, mu=-0.53):
    n = v.shape[0]
    a = np.concatenate([f[:, 0], f[:, 1], f[:, 2], f[:, 1], f[:, 2], f[:, 0]])
    b = np.concatenate([f[:, 1], f[:, 2], f[:, 0], f[:, 0], f[:, 1], f[:, 2]])
    adj = coo_matrix((np.ones(a.shape[0]), (a, b)), shape=(n, n)).tocsr()
    adj.data[:] = 1.0
    deg = np.asarray(adj.sum(1)).ravel()
    deg[deg == 0] = 1
    v = v.astype(np.float64)
    for _ in range(iters):
        for k in (lam, mu):
            v = v + k * (adj @ v / deg[:, None] - v)
    return v.astype(np.float32)


def _mask_bbox(mask):
    ys, xs = np.nonzero(mask > 0.5)
    if ys.size == 0:
        return None
    return float(xs.min()), float(xs.max()), float(ys.min()), float(ys.max())


def _paint(pts, nrm, views, outline, tri, front_weight, sharpness, dev):
    """Colour points (K,3) with normals (K,3) from the views; returns (K,3) numpy.
    outline: vertices used to line each view up with its picture; tri: (T,3,3) triangles that can block a view."""
    bvh = P._build_triangle_bvh(tri)
    up = torch.tensor([0.0, 1.0, 0.0], device=dev)
    acc = torch.zeros((pts.shape[0], 3), device=dev)
    wsum = torch.zeros(pts.shape[0], device=dev)
    for name, (img, msk) in views.items():
        d = torch.tensor(VIEWS[name][0], device=dev)
        r = torch.tensor(VIEWS[name][1], device=dev)
        fit = _fit_view(outline, r, up, msk, dev)
        if fit is None:
            continue
        scale, cx, ty, cmid, top, iou = fit
        px = cx + (pts @ r - cmid) * scale
        py = ty + (top - pts @ up) * scale
        H, W = msk.shape
        grid = torch.stack([(2 * px + 1) / W - 1, (2 * py + 1) / H - 1], -1)[None, None]     # (1,1,K,2)
        im = torch.from_numpy(np.ascontiguousarray(img[..., :3], dtype=np.float32)).to(dev).permute(2, 0, 1)[None]
        mk = torch.from_numpy(np.ascontiguousarray(msk, dtype=np.float32)).to(dev)[None, None]
        mk = -F.max_pool2d(-mk, 7, 1, 3)   # shrink the outline a little so edges don't pick up background
        col = F.grid_sample(im, grid, mode="bilinear", padding_mode="border", align_corners=False)[0, :, 0].T
        inside = F.grid_sample(mk, grid, mode="bilinear", padding_mode="zeros", align_corners=False)[0, 0, 0] > 0.5
        facing = (nrm @ d).clamp(min=0)
        idx = torch.nonzero(inside & (facing > 0.05), as_tuple=True)[0]
        vis = torch.zeros(pts.shape[0], dtype=torch.bool, device=dev)
        for s in range(0, idx.shape[0], 1 << 19):   # ray-cast toward the camera; blocked = another part is in front
            sel = idx[s:s + (1 << 19)]
            o = pts[sel] + nrm[sel] * 2e-3 + d * 2e-3
            vis[sel] = ~P._any_hit_rays_bvh(o, d.expand(sel.shape[0], 3).contiguous(), tri, bvh, tmin=1e-4)
        w = facing ** sharpness * vis.float() * (front_weight if name == "front" else 1.0)
        acc += w[:, None] * col
        wsum += w
        logging.info(f"[Kobo 3D] {name} view: outline overlap {iou:.2f}, colours {int((w > 0).sum())}/{w.shape[0]} points")
    painted = wsum > 1e-6
    colors = torch.full((pts.shape[0], 3), 0.5, device=dev)
    colors[painted] = acc[painted] / wsum[painted, None]
    colors, pts_np, painted_np = colors.cpu().numpy(), pts.cpu().numpy(), painted.cpu().numpy()
    if painted_np.any() and not painted_np.all():   # surface no view saw: copy the nearest painted surface
        _, near = cKDTree(pts_np[painted_np]).query(pts_np[~painted_np], k=1)
        colors[~painted_np] = colors[painted_np][near]
    return np.clip(colors, 0.0, 1.0)


def colors_from_views(v, f, views, front_weight=2.0, sharpness=2.0):
    """Per-vertex colours (N,3), linear as glTF's COLOR_0 expects, for mesh v (N,3), f (M,3);
    views: {name: (image HxWx3 0..1, mask HxW 0..1)}."""
    dev = comfy.model_management.get_torch_device()
    vt = torch.from_numpy(np.ascontiguousarray(v, dtype=np.float32)).to(dev)
    ft = torch.from_numpy(np.ascontiguousarray(f).astype(np.int64)).to(dev)
    nrm = torch.from_numpy(P._smooth_vertex_normals(v.astype(np.float32), f.astype(np.int64))).to(dev)
    c = _paint(vt, nrm, views, vt, vt[ft], front_weight, sharpness, dev)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4).astype(np.float32)


def texture_from_views(v, f, uvs, views, ref=None, size=1024, front_weight=2.0, sharpness=2.0):
    """Like colors_from_views, into a UV texture: v, f, uvs (N,2) of a decimated, unwrapped mesh. ref = (vertices, faces)
    of the dense mesh, used to place texels on the true surface and to line the views up.
    Returns (normalized uvs (N,2), texture (size,size,3) float32)."""
    dev = comfy.model_management.get_torch_device()
    uv = P._normalize_uvs_to_unit(uvs.astype(np.float32))
    face_idx, bary, cov = P._rasterize_uv_barycentric(f, uv, size)
    vt = torch.from_numpy(np.ascontiguousarray(v, dtype=np.float32)).to(dev)
    ft = torch.from_numpy(np.ascontiguousarray(f).astype(np.int64)).to(dev)
    pos_map = P._interp_vertex_attr(vt, ft, face_idx, bary, cov).cpu().numpy()
    vn = torch.from_numpy(P._smooth_vertex_normals(v.astype(np.float32), f.astype(np.int64))).to(dev)
    nrm_map = P._interp_vertex_attr(vn, ft, face_idx, bary, cov)
    del face_idx, bary
    mask = cov.cpu().numpy()
    if not mask.any():
        return uv, np.full((size, size, 3), 0.5, np.float32)
    if ref is not None:
        pos_map = P._back_project_positions(pos_map, mask, torch.from_numpy(ref[0]), torch.from_numpy(ref[1]))
    pts = torch.from_numpy(np.ascontiguousarray(pos_map[mask], dtype=np.float32)).to(dev)
    nrm = F.normalize(nrm_map[torch.from_numpy(mask).to(dev)], dim=-1)
    del nrm_map
    outline = torch.from_numpy(np.ascontiguousarray(ref[0] if ref is not None else v, dtype=np.float32)).to(dev)
    tex = np.zeros((size, size, 3), np.float32)
    tex[mask] = _paint(pts, nrm, views, outline, vt[ft], front_weight, sharpness, dev)
    return uv, np.clip(P._seam_fill(tex, mask), 0.0, 1.0).astype(np.float32)
