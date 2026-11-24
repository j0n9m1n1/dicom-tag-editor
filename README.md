# DICOM Tag Editor

**Live Web App:** [https://dcm.tyty.uk/](https://dcm.tyty.uk/)

A **100% browser-local, Zero-Build, Zero-Upload** DICOM Tag Editor, Metadata Viewer, Side-by-Side Diff Tool, and Pixel Previewer.  
All parsing, editing, VR validation, multi-file comparison, anonymization, pixel rendering, and byte-preserving file saving run entirely inside your browser memory — no medical images or patient data ever leave your machine.

> [!CAUTION]
> ### Disclaimer & Legal Notice
> 1. **Not for Clinical or Diagnostic Use:** This software is provided strictly for development, research, educational, and metadata inspection purposes. It is **not** a certified medical device and must not be used for clinical diagnosis or patient treatment decisions.
> 2. **De-identification Limitations:** The built-in anonymization preset assists with replacing common standard tags and stripping private tags, but it does **not** remove burned-in text inside pixel data (*Burned-in Annotation*) and may not cover all vendor-specific or nested attributes. Users are solely responsible for verifying full compliance with HIPAA, GDPR, or local data privacy regulations before sharing or publishing files.
> 3. **Provided "AS IS" — Backup Originals:** All processing happens locally in your browser with zero server transmission. This software is provided "AS IS" without warranty of any kind. Always keep a backup of your original DICOM files before editing or overwriting.

---

## Key Features

- **Full NEMA PS3.6 Standard Dictionary (`5,041+` Tags & `187+` SOP Class UIDs)**
  - Complete standard DICOM tag lookup including Group `0040` (**MPPS** / Modality Worklist) tags and standard SOP Class / Transfer Syntax UID names
  - Quick preset chips for common coded tags (`SpecificCharacterSet`, `PerformedProcedureStepStatus`, etc.)
- **Hierarchical Tag Tree (`File Meta 0002` + `Main Dataset` + Nested `SQ`)**
  - Real-time search by tag `(GGGG,EEEE)`, keyword, VR, or value, plus quick filter chips (`Modified`, `Errors`, `SQ`, `Private`, `Meta`)
  - Drag-to-resize columns (`Tag`, `Keyword / Name`, `VR`, `VM`, `Len`, `Value`) with persistent column widths
  - Color-coded edit states (`Modified`, `Added`, `Pending Delete`, `VR Error`), right-click context menu, full keyboard navigation (`↑↓`, `←→`, `PageUp/PageDown`, `Home/End`), and double-click / `F2` inline editing
- **Right-Side Tag Inspector & Raw Hex Debugger**
  - Displays **DICOM PS3.5 VR specifications** (category, max/fixed length, even padding byte, VM allowance, format guide) with live validation
  - Structured **`PN` (Person Name)** component editor (`Alphabetic` / `Ideographic` groups), multi-value (`VM > 1`) list editor, `DA`/`TM` quick date/time helpers, one-click standard `2.25.*` UID generator, and automatic `ISO_IR 192` (UTF-8) charset helper
  - Expandable **`Raw Bytes (Hex)`** dump on every tag to inspect character encodings and padding bytes
- **VS Code-Style Multi-File Tabs & Collapsible Explorer**
  - Open multiple `.dcm` files or **drag & drop an entire directory** (with lazy parsing and independent per-file Undo/Redo stacks)
  - **Top File Tab Bar:** Middle-truncated DICOM UID filenames (`1.2.840…0001.dcm`), unsaved dots, mouse-wheel horizontal scroll, drag-to-reorder tabs, right-click tab menu (`Compare with Active`, `Close Others`, `Close to the Right`), and middle-click / `Alt+W` close
  - **Collapsible `Open Files` Sidebar & Unified Topbar Menus:** Keep collapsed for maximum workspace width, or expand for bulk series navigation with right-click file actions (`Compare`, `Assign A/B`, `Copy Filename`, `Save File As`, `Close Others/Below`) and `Close All`; access **Add Tag / Batch Edit / Anonymize** under `Edit ▾` and **Overwrite / Save As / Save All to Folder / Save All as ZIP** under `Save | ▾`
- **WinMerge-Style Inline Side-by-Side Compare**
  - Inline split workspace (`File A | Draggable Resizer | File B`) with 4 content-sized columns (`Tag | Keyword | VR | Value`)
  - Structured DICOM order (`File Meta 0002` → `Main Dataset` → nested `SQ` children), synchronized scroll/hover/selection, keyboard navigation (`↑↓`, `PageUp/PageDown`, `Home/End`), `Show differences only`, search, Prev/Next diff stepper, and compact diff stat chips
  - Assign File A / B via top dropdowns OR by dragging files directly from the top tab bar or `Open Files` sidebar
- **Raw View (`dcmdump` & DICOM JSON) + Error Diagnostics**
  - View, copy to clipboard, or export the entire dataset as DCMTK `dcmdump`-compatible text or structured JSON
  - Built-in **File Open Error Diagnostics** modal inspecting Part 10 `DICM` header, detected non-DICOM signatures, failure offset, and hex preview
- **Collapsible Pixel Preview Dock**
  - Supports uncompressed Grayscale (8/16-bit signed/unsigned, `MONOCHROME1/2`, Rescale Slope/Intercept), RGB, `YBR_FULL`, `YBR_FULL_422`, **RLE Lossless**, **JPEG Baseline**, and multi-frame stepping
  - Interactive mouse/touch drag Window Center/Width (`WC/WW`), CT presets (`Brain`, `Soft`, `Lung`, `Bone`), wheel zoom, `Shift+Drag` pan, Invert, and live cursor `(X, Y)` + pixel/HU readout
- **Dual UI Styles (`Modern` / `Raw`), Bilingual UI & Mobile Support**
  - Instant **English (`EN`) / Korean (`KO`)**, **Dark / Light** theme, and **Modern / Raw (terminal wireframe)** UI switching via Settings (`⚙`)
  - Dedicated mobile bottom tab navigation (`Files` / `Tags` / `Inspect` / `Pixel`) and 2-row card layout on narrow screens
- **Installable Desktop / Offline App (PWA)**
  - Install as a standalone desktop app from Chrome / Edge with offline Service Worker caching
  - Registers OS **`.dcm` / `.dicom` file handler** (`launchQueue`) so you can open DICOM files directly from File Explorer with direct `Ctrl+S` overwrite support

---

## Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl + O` | Open local DICOM file(s) |
| `Alt + W` | Close active file tab or Compare view |
| `Ctrl + S` / `Ctrl + Shift + S` | Save (direct overwrite if supported) / Save As |
| `Ctrl + F` | Focus tag search (Tree or Compare view) |
| `Ctrl + Z` / `Ctrl + Y` | Undo / Redo (per-file stack) |
| `↑` `↓` / `PageUp` `PageDown` / `Home` `End` | Navigate tags in Tree or Compare view |
| `←` `→` | Collapse / Expand sequence nodes |
| `F2` / Double-click | Inline edit selected tag value |
| `Delete` | Toggle pending delete on selected tag |
| `Ctrl + ,` | Open / toggle Settings |
| `Esc` | Close modal or exit Compare view |

---

## Running Locally & Testing

No build step is required.

- **Windows:** Double-click `run_local.bat`
- **Terminal (any OS):**
  ```bash
  python -m http.server 8080
  ```
  Then open `http://localhost:8080` in your browser.
- **Automated Regression Tests (Node.js 22+):**
  ```bash
  node --test tests/dicom-regressions.test.mjs
  ```

## Deployment (GitHub Pages)

1. Push to the `main` branch — `.github/workflows/deploy.yml` runs the Node 22 regression test suite, applies commit-hash cache busting across `index.html`, `src/`, and `sw.js`, updates `sitemap.xml`, and deploys to GitHub Pages.
2. In your repository **Settings → Pages → Build and deployment → Source**, select **GitHub Actions**.
3. To use a custom domain (e.g., `dcm.tyty.uk`), configure a DNS `CNAME` record pointing to `<username>.github.io` and set the domain under **Settings → Pages → Custom domain**.

## License

Released under the [MIT License](./LICENSE).
