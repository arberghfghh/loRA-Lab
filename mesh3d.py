# ComfyUI nodes for Kōbō's Image to 3D tab: clean a Hunyuan3D mesh, and paint it from the source picture
# (+ optional side/back views). The work is in mesh3d_core.py.
import copy
import importlib

import numpy as np
import torch

from comfy_api.latest import Types
from comfy_extras.nodes_save_3d import get_mesh_batch_item

from . import mesh3d_core

RELOAD_CORE = False  # True while developing: pick up mesh3d_core edits without restarting ComfyUI


def _core():
    if RELOAD_CORE:
        importlib.reload(mesh3d_core)
    return mesh3d_core


def _item(mesh):
    v, f, _c, uv, _n = get_mesh_batch_item(mesh, 0)
    return v, f, uv


class ASALabMeshCleanup:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "mesh": ("MESH",),
            "min_part": ("FLOAT", {"default": 0.01, "min": 0.0, "max": 0.5, "step": 0.001,
                                   "tooltip": "Drop separate parts smaller than this share of the largest part (by faces)."}),
            "smooth_iters": ("INT", {"default": 0, "min": 0, "max": 20, "tooltip": "Taubin smoothing passes (0 = off)."}),
            "target_faces": ("INT", {"default": 0, "min": 0, "max": 5000000, "step": 1000, "tooltip": "Decimate to about this many faces (0 = keep all)."}),
        }}

    RETURN_TYPES = ("MESH",)
    FUNCTION = "run"
    CATEGORY = "Kōbō/3d"

    def run(self, mesh, min_part, smooth_iters, target_faces):
        v, f, _ = _item(mesh)
        v2, f2 = _core().clean_mesh(v.detach().cpu().numpy().astype(np.float32), f.detach().cpu().numpy().astype(np.int64),
                                    min_part, smooth_iters, target_faces)
        return (Types.MESH(torch.from_numpy(v2)[None].to(v.dtype), torch.from_numpy(f2)[None].to(f.dtype)),)


class ASALabTextureFromViews:
    @classmethod
    def INPUT_TYPES(cls):
        opt = {"reference_mesh": ("MESH", {"tooltip": "Dense mesh before decimation: texels are placed on its true surface."})}
        for v in ("left", "back", "right"):
            opt[v] = ("IMAGE",)
            opt[v + "_mask"] = ("MASK",)
        return {"required": {
            "mesh": ("MESH", {"tooltip": "With UVs it gets a texture; without UVs its vertices are coloured."}),
            "front": ("IMAGE",),
            "front_mask": ("MASK",),
            "resolution": ("INT", {"default": 1024, "min": 256, "max": 4096, "step": 256, "tooltip": "Texture size (meshes with UVs only)."}),
            "front_weight": ("FLOAT", {"default": 2.0, "min": 0.1, "max": 10.0, "step": 0.1,
                                       "tooltip": "How much more the source picture counts than the generated views."}),
        }, "optional": opt}

    RETURN_TYPES = ("MESH",)
    FUNCTION = "run"
    CATEGORY = "Kōbō/3d"

    def run(self, mesh, front, front_mask, resolution, front_weight, reference_mesh=None, **views):
        v, f, uv = _item(mesh)
        pics = {"front": (front[0].cpu().numpy(), front_mask[0].cpu().numpy())}
        for name in ("left", "back", "right"):
            if views.get(name) is not None and views.get(name + "_mask") is not None:
                pics[name] = (views[name][0].cpu().numpy(), views[name + "_mask"][0].cpu().numpy())
        v_np, f_np = v.detach().cpu().numpy().astype(np.float32), f.detach().cpu().numpy().astype(np.int64)
        out = copy.copy(mesh)
        if uv is None:   # full-detail mesh: colour the vertices
            out.vertex_colors = torch.from_numpy(_core().colors_from_views(v_np, f_np, pics, front_weight=front_weight))[None]
            return (out,)
        ref = None
        if reference_mesh is not None:
            rv, rf, _ = _item(reference_mesh)
            ref = (rv.detach().cpu().numpy().astype(np.float32), rf.detach().cpu().numpy().astype(np.int64))
        uv_n, tex = _core().texture_from_views(v_np, f_np, uv.detach().cpu().numpy(), pics, ref=ref, size=resolution, front_weight=front_weight)
        out.uvs = torch.from_numpy(uv_n)[None].to(torch.float32)
        out.texture = torch.from_numpy(tex)[None]
        out.vertex_colors = None
        return (out,)


NODE_CLASS_MAPPINGS = {"ASALabMeshCleanup": ASALabMeshCleanup, "ASALabTextureFromViews": ASALabTextureFromViews}
NODE_DISPLAY_NAME_MAPPINGS = {"ASALabMeshCleanup": "Kōbō: Clean 3D mesh", "ASALabTextureFromViews": "Kōbō: Paint 3D mesh from pictures"}
