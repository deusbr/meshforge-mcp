---
name: meshforge-3d
description: Generate, inspect, and preview PBR GLB 3D models from text, images, or declarative Scene DSL purely in local code (zero API keys) via meshforge-mcp across Codex, Claude Code, Gemini CLI, Claude Desktop, and OpenBot.
---

# MeshForge 3D — Pure-Code Text & Image to GLB (Zero API Keys)

Use `meshforge-mcp` whenever a task needs a real `.glb` 3D model without external API keys or GPUs.

## Techniques Built In

1. **Custom Scene DSL (`mesh_build_scene`)** — Best for arbitrary Text-to-3D requests from Codex, Claude Code, Gemini, or OpenBot: author a JSON `parts` list combining `box`, `sphere`, `cylinder`, `cone`, `torus`, `lathe`, `tube`, `extrude`, and `sdf` (`smoothUnion`/`subtract`/`intersect` via Marching Tetrahedra) with PBR materials.
2. **Prompt & Image Generation (`mesh_generate_3d`)**
   - `provider: "pure-code"` (default for text): parses material/color/style keywords and builds multi-part procedural GLBs offline.
   - `provider: "image-inflate"` (default for images): segments foreground (alpha or border flood-fill), computes an exact 2D Euclidean Distance Transform, inflates a closed 3D mesh, and embeds the input image as a UV-mapped PBR texture inside the `.glb`.
   - `provider: "image-relief"`: Gaussian-smoothed luminance heightmap / lithophane watertight slab with embedded UV texture.
   - Optional zero-key cloud/local Gradio Spaces (`hunyuan3d-hf`, `sf3d-hf`, `local-gradio`) are also supported when explicitly requested.
3. **Inspect & Preview (`mesh_inspect_glb`, `mesh_preview_html`)** — Parse GLB binary chunks/metrics and generate an interactive Three.js viewer HTML.
4. **Install Across Clients (`mesh_install_clients`)** — Register `meshforge-mcp` atomically into Codex, Claude Code, Claude Desktop, Gemini CLI, Cursor, and Antigravity.
