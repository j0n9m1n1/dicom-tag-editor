# DICOM Tag Editor

**Live Web App:** [https://dcm.tyty.uk/](https://dcm.tyty.uk/)

A **100% browser-local, Zero-Build, Zero-Upload** DICOM Tag Editor and Metadata Viewer.  
All parsing, editing, validation, multi-file comparison, anonymization, pixel rendering, and byte-preserving file saving run entirely inside your browser memory — no medical images or patient data ever leave your machine.

> [!CAUTION]
> ### Disclaimer & Legal Notice
> 1. **Not for Clinical or Diagnostic Use:** This software is provided strictly for development, research, educational, and metadata inspection purposes. It is **not** a certified medical device and must not be used for clinical diagnosis or patient treatment decisions.
> 2. **De-identification Limitations:** The built-in anonymization preset assists with replacing common standard tags and stripping private tags, but it does **not** remove burned-in text inside pixel data (*Burned-in Annotation*) and may not cover all vendor-specific or nested attributes. Users are solely responsible for verifying full compliance with HIPAA, GDPR, or local data privacy regulations before sharing or publishing files.
> 3. **Provided "AS IS" — Backup Originals:** All processing happens locally in your browser with zero server transmission. This software is provided "AS IS" without warranty of any kind. Always keep a backup of your original DICOM files before editing or overwriting.

---

## Key Features

- **Hierarchical Tag Tree (`File Meta 0002` + `Main Dataset` + Nested `SQ`)**
  - Real-time search by tag `(GGGG,EEEE)`, keyword, VR, or value, plus quick filter chips (`Modified`, `Errors`, `SQ`, `Private`, `Meta`)
  - Drag-to-resize columns (`Tag`, `Keyword / Name`, `VR`, `VM`, `Len`, `Value`) with persistent column widths
  - Color-coded edit states (`Modified`, `Added`, `Pending Delete`, `VR Error`), right-click context menu, keyboard navigation, and double-click / `F2` inline editing
- **Right-Side Tag Inspector & Raw Hex Debugger**
  - Displays **DICOM PS3.5 VR specifications** (category, max/fixed length, even padding byte, VM allowance, format guide) with live validation
  - Dedicated multi-value (`VM > 1`) list editor, `DA`/`TM` quick date/time helpers, one-click standard `2.25.*` UID generator for `UI` tags, and automatic `ISO_IR 192` (UTF-8) charset helper for non-ASCII text
  - Expandable **`Raw Bytes (Hex)`** dump on every tag to inspect character encodings and padding bytes
- **Raw View (`dcmdump` & DICOM JSON)**
  - View, copy to clipboard, or export the entire dataset as DCMTK `dcmdump`-compatible text or structured JSON
- **Multi-File & Folder Workspace**
  - Open multiple `.dcm` files or **drag & drop an entire directory** (with lazy parsing and independent per-file Undo/Redo stacks)
  - **Side-by-Side Compare:** Pick any two open files to inspect differing, A-only, and B-only tags
  - **Batch Edit & Batch Anonymize:** Set, update, or delete a tag across all open files, strip all odd-group Private tags, and regenerate consistent `Study / Series / SOP Instance UIDs` across slices
  - **Batch ZIP Export:** Download readable DICOM files as a single standard `.zip` archive with zero external dependencies
- **Collapsible Pixel Preview Dock**
  - Supports uncompressed Grayscale (8/16-bit signed/unsigned, `MONOCHROME1/2`, Rescale Slope/Intercept), RGB, `YBR_FULL`, `YBR_FULL_422`, **RLE Lossless**, **JPEG Baseline**, and multi-frame stepping
  - Interactive mouse/touch drag Window Center/Width (`WC/WW`), CT presets (`Brain`, `Soft`, `Lung`, `Bone`), wheel zoom, `Shift+Drag` pan, Invert, and live cursor `(X, Y)` + pixel/HU readout
- **Bilingual UI, Neutral Dark Theme & Mobile Optimization**
  - Instant **English (`EN`) / Korean (`KO`)** and **Neutral Charcoal Dark / Light** theme switching via the Settings (`⚙`) dialog
  - Dedicated mobile bottom tab navigation (`Files` / `Tags` / `Inspect` / `Pixel`) and 2-row card layout on narrow screens

---

## Running Locally

No Node.js installation or build step is required.

- **Windows:** Double-click `run_local.bat`
- **Terminal (any OS):**
  ```bash
  python -m http.server 8080
  ```
  Then open `http://localhost:8080` in your browser.

## Deployment (GitHub Pages)

1. Push to the `main` branch — `.github/workflows/deploy.yml` automatically applies commit-hash cache busting and deploys to GitHub Pages.
2. In your repository **Settings → Pages → Build and deployment → Source**, select **GitHub Actions**.
3. To use a custom domain (e.g., `dcm.tyty.uk`), configure a DNS `CNAME` record pointing to `<username>.github.io` and set the domain under **Settings → Pages → Custom domain**.

## License

Released under the [MIT License](./LICENSE).
